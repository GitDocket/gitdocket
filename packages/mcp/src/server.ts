// @gitdocket/mcp — the auto-approvable agent surface. Every tool is a
// narrow, named, zod-validated mirror of a @gitdocket/core op; none executes
// shell. Writes address IDs; source pages accept only exact members of the
// bundle inventory. Files are reached through core's rooted FileStore. That containment is what
// makes allowlisting the whole server (`mcp__docket`) safe. Read tools carry
// readOnlyHint so cautious users can allowlist reads alone.

import {
  appendLog,
  buildSchemas,
  createWorkItem,
  DOCKET_VERSION,
  type DocketConfig,
  docketIntent,
  type FileStore,
  GitWorktreeIdCoordinator,
  lintBundle,
  PRIORITIES,
  parseConcept,
  READY_QUEUE_DESCRIPTION,
  readyWorkItems,
  STATES,
  setStatus,
  sourcePage,
  WORK_ITEM_TYPES,
  type WorkItem,
} from "@gitdocket/core";
import { deriveRepositoryOverview } from "@gitdocket/core/orientation";
import {
  environmentAttribution,
  errorCategory,
  OPERATIONS,
  type Operation,
  observeOperation,
  Telemetry,
} from "@gitdocket/core/telemetry";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  RepositoryOwner,
  type RepositoryResolver,
  snapshotStore,
} from "./owner";

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
  resolve?: RepositoryResolver,
): McpServer {
  const server = new McpServer({ name: "docket", version: DOCKET_VERSION });
  const idCoordinator = root ? new GitWorktreeIdCoordinator(root) : undefined;
  const owner = new RepositoryOwner(
    resolve ?? (async () => ({ store, config })),
    root,
  );
  const telemetry = root ? new Telemetry(root, "mcp") : undefined;
  // Wrap the SDK's public request-handler registration, outside tool validation.
  // This records handled validation failures without altering protocol responses.
  const register = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => {
    if ((schema as unknown) !== CallToolRequestSchema)
      return register(schema, handler);
    return register(schema, async (request, extra) => {
      const params = request.params as
        | { name?: string; _meta?: Record<string, unknown> }
        | undefined;
      const operation = params?.name;
      if (!operation || !OPERATIONS.includes(operation as Operation))
        return handler(request, extra);
      const meta = params?._meta;
      const attribution = {
        ...environmentAttribution(),
        trigger: "explicit" as const,
      };
      if (typeof meta?.["docket/workflow"] === "string")
        attribution.workflow = meta["docket/workflow"];
      if (typeof meta?.["docket/actor"] === "string")
        attribution.actor = meta["docket/actor"];
      if (typeof meta?.["docket/host"] === "string")
        attribution.host = meta["docket/host"];
      return observeOperation(
        telemetry,
        operation as Operation,
        async () => handler(request, extra),
        {
          dimensions: () => owner.dimensions(),
          attribution,
          resultError: (result) => {
            const value = result as {
              isError?: boolean;
              content?: { text?: string }[];
            };
            return value.isError
              ? errorCategory(value.content?.[0]?.text)
              : "none";
          },
        },
      );
    });
  };
  const close = server.close.bind(server);
  server.close = async () => {
    owner.close();
    await close();
  };
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    owner.close();
    onclose?.();
  };

  server.registerTool(
    "overview",
    {
      title: "Orient and review",
      description: docketIntent("orientation").discovery,
      annotations: READ,
    },
    async () => {
      const { bundle, config, store } = await owner.metadata();
      return json(
        await deriveRepositoryOverview({
          bundle,
          config,
          store,
          root,
          evidence: owner.evidence(config),
        }),
      );
    },
  );

  server.registerTool(
    "ready",
    {
      title: "List ready tasks",
      description: READY_QUEUE_DESCRIPTION,
      inputSchema: { limit: z.number().int().min(1).max(1000).optional() },
      annotations: READ,
    },
    async ({ limit }) => {
      const { bundle: b } = await owner.metadata();
      const ready = readyWorkItems(b);
      return json(ready.slice(0, limit).map(summarize));
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
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional().default(0),
      },
      annotations: READ,
    },
    async ({ status, type, limit, offset }) => {
      const { bundle: b } = await owner.metadata();
      let items = b.workItems;
      if (status) items = items.filter((w) => w.fm.status === status);
      if (type) items = items.filter((w) => w.fm.type === type);
      return json(
        items
          .slice(offset, limit === undefined ? undefined : offset + limit)
          .map(summarize),
      );
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
      const { bundle: b, config } = await owner.metadata();
      const item = b.byId(id);
      if (!item) throw new Error(`no item with id ${id}`);
      const source = await owner.source(item.path);
      const current = parseConcept(
        item.path,
        source,
        buildSchemas(config),
      ).concept;
      if (
        !current ||
        current.kind === "generic" ||
        ![current.fm.id, ...current.fm.aliases].includes(id)
      )
        throw new Error(`item changed; retry lookup: ${id}`);
      return json({
        path: item.path,
        frontmatter: current.fm,
        source,
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
    async () => {
      const { snapshot } = await owner.read();
      return json(await lintBundle(snapshotStore(snapshot), snapshot.bundle));
    },
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
    async ({ query, limit }) => {
      const { snapshot } = await owner.read();
      return json(snapshot.search.search(query, { limit }));
    },
  );

  server.registerTool(
    "source_page",
    {
      title: "Read a source page",
      description:
        "Explicit bounded retrieval of exact bundle Markdown, including log.md. Returns source hash, line range and a continuation cursor; changed sources reject old cursors.",
      inputSchema: {
        path: z.string().min(1),
        maxChars: z.number().int().min(1).max(32768).optional(),
        cursor: z
          .object({
            path: z.string(),
            sourceHash: z.string(),
            offset: z.number().int().min(0),
          })
          .optional(),
      },
      annotations: READ,
    },
    async ({ path, maxChars, cursor }) => {
      const sources = await owner.sourceMap(path);
      const page = sourcePage(sources, path, {
        maxChars,
        cursor,
      });
      if (!page) throw new Error(`not found: ${path}`);
      return json(page);
    },
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
        await owner.mutate(
          async ({ store, config }) =>
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
      json(
        await owner.mutate(({ store, config }) =>
          setStatus(store, config, id, to, { note }),
        ),
      ),
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
    async ({ id, entry }) =>
      json(
        await owner.mutate(({ store, config }) =>
          appendLog(store, config, id, entry),
        ),
      ),
  );

  server.server.setRequestHandler = register;
  return server;
}
