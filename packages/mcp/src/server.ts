// @gitdocket/mcp — the auto-approvable agent surface. Every tool is a
// narrow, named, zod-validated mirror of a @gitdocket/core op; none executes
// shell and none takes a filesystem path — ids only, files reached solely
// through core's FileStore rooted at the bundle. That containment is what
// makes allowlisting the whole server (`mcp__docket`) safe. Read tools carry
// readOnlyHint so cautious users can allowlist reads alone.

import {
  appendLog,
  type Bundle,
  createWorkItem,
  DOCKET_VERSION,
  type DocketConfig,
  docketIntent,
  type FileStore,
  GitWorktreeIdCoordinator,
  lintBundle,
  loadBundle,
  PRIORITIES,
  READY_QUEUE_DESCRIPTION,
  readyWorkItems,
  STATES,
  searchBundle,
  setStatus,
  WORK_ITEM_TYPES,
  type WorkItem,
} from "@gitdocket/core";
import { deriveRepositoryOverview } from "@gitdocket/core/orientation";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const READ = { readOnlyHint: true, openWorldHint: false } as const;
// Writes are additive or state-machine-guarded frontmatter edits — nothing deletes.
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const summarize = (w: WorkItem) => ({
  id: w.fm.id,
  type: w.fm.type,
  title: w.fm.title,
  status: w.fm.status,
  priority: w.fm.priority,
  epic: w.fm.epic,
  depends_on: w.fm.depends_on,
  path: w.path,
});

export function createDocketServer(
  store: FileStore,
  config: DocketConfig,
  root?: string,
): McpServer {
  const server = new McpServer({ name: "docket", version: DOCKET_VERSION });
  const idCoordinator = root ? new GitWorktreeIdCoordinator(root) : undefined;
  // Bundles are reloaded per call: files are the source of truth and other
  // clients (CLI, editor, git) mutate them between calls.
  const bundle = (): Promise<Bundle> => loadBundle(store, config);

  server.registerTool(
    "overview",
    {
      title: "Orient and review",
      description: docketIntent("orientation").discovery,
      annotations: READ,
    },
    async () => {
      const b = await bundle();
      return json(
        await deriveRepositoryOverview({ bundle: b, config, store, root }),
      );
    },
  );

  server.registerTool(
    "ready",
    {
      title: "List ready tasks",
      description: READY_QUEUE_DESCRIPTION,
      annotations: READ,
    },
    async () => {
      const b = await bundle();
      const ready = readyWorkItems(b);
      return json(ready.map(summarize));
    },
  );

  server.registerTool(
    "task_list",
    {
      title: "List work items",
      description: "All work items, optionally filtered by status or type.",
      inputSchema: {
        status: z.enum(STATES).optional().describe("filter by status"),
        type: z.enum(WORK_ITEM_TYPES).optional().describe("Task or Epic"),
      },
      annotations: READ,
    },
    async ({ status, type }) => {
      const b = await bundle();
      let items = b.workItems;
      if (status) items = items.filter((w) => w.fm.status === status);
      if (type) items = items.filter((w) => w.fm.type === type);
      return json(items.map(summarize));
    },
  );

  server.registerTool(
    "task_get",
    {
      title: "Get a work item or decision",
      description:
        "Full markdown source and parsed frontmatter for one id (aliases resolve).",
      inputSchema: {
        id: z.string().min(1).describe("e.g. DKT-14 or DEC-2"),
      },
      annotations: READ,
    },
    async ({ id }) => {
      const b = await bundle();
      const item = b.byId(id);
      if (!item) throw new Error(`no item with id ${id}`);
      return json({
        path: item.path,
        frontmatter: item.fm,
        source: await store.read(item.path),
      });
    },
  );

  server.registerTool(
    "lint",
    {
      title: "Lint the bundle",
      description:
        "Conformance errors (parse failures, schema violations, duplicate ids, unresolvable depends_on) plus practice warnings (missing epic specs, broken links, stale statuses, freshness nag). Empty array means clean.",
      annotations: READ,
    },
    async () => json(await lintBundle(store, await bundle())),
  );

  server.registerTool(
    "search",
    {
      title: "Search the bundle",
      description:
        "Ranked text search across every file in the bundle — tokenized multi-term queries, title/id matches boosted, best hits first; hits carry the owning concept's id plus its link neighborhood (outbound links and backlinks).",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: READ,
    },
    async ({ query, limit }) =>
      json(await searchBundle(store, await bundle(), query, { limit })),
  );

  server.registerTool(
    "task_create",
    {
      title: "Create a work item",
      description:
        "Create a Task or Epic with the next numbered id; the file lands under work/ as a conformant concept.",
      inputSchema: {
        title: z.string().min(1),
        type: z.enum(WORK_ITEM_TYPES).optional().default("Task"),
        description: z.string().optional().describe("one-sentence description"),
        epic: z
          .string()
          .optional()
          .describe("bundle-absolute link, e.g. /work/epics/DKT-2-….md"),
        depends_on: z.array(z.string()).optional().describe("dependency ids"),
        priority: z.enum(PRIORITIES).optional().default("p2"),
        assignee: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    async (input) =>
      json(
        await createWorkItem(
          store,
          config,
          {
            title: input.title,
            type: input.type,
            description: input.description,
            epic: input.epic,
            dependsOn: input.depends_on,
            priority: input.priority,
            assignee: input.assignee,
            tags: input.tags,
          },
          idCoordinator,
        ),
      ),
  );

  server.registerTool(
    "set_status",
    {
      title: "Change a work item's status",
      description:
        "Move a work item through the state machine (invalid transitions are rejected). A disposition note is required when moving to closed; other transitions may optionally append a dated Log entry.",
      inputSchema: {
        id: z.string().min(1),
        to: z.enum(STATES),
        note: z
          .string()
          .optional()
          .describe("dated Log entry; required when `to` is `closed`"),
      },
      annotations: WRITE,
    },
    async ({ id, to, note }) =>
      json(await setStatus(store, config, id, to, { note })),
  );

  server.registerTool(
    "append_log",
    {
      title: "Append a Log entry",
      description:
        "Add a dated entry under an item's # Log section (newest first), creating the section if needed.",
      inputSchema: {
        id: z.string().min(1),
        entry: z.string().min(1),
      },
      annotations: WRITE,
    },
    async ({ id, entry }) => json(await appendLog(store, config, id, entry)),
  );

  return server;
}
