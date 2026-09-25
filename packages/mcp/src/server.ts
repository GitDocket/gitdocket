import { foreignTaskSummaries, withTaskProgress } from "@gitdocket/core";
// @gitdocket/mcp — the auto-approvable agent surface. Every tool is a
// narrow, named, zod-validated mirror of a @gitdocket/core op; none executes
// shell. Writes address IDs; source pages accept only exact members of the
// bundle inventory. Files are reached through core's rooted FileStore. That containment is what
// makes allowlisting the whole server (`mcp__docket`) safe. Read tools carry
// readOnlyHint so cautious users can allowlist reads alone.

import {
  appendLog,
  applyDocumentMove,
  applyIndex,
  buildSchemas,
  createDecision,
  createDocument,
  createWorkItem,
  DOCKET_VERSION,
  DOCUMENT_TYPES,
  type DocketConfig,
  docketIntent,
  editDocument,
  type FileStore,
  GitWorktreeIdCoordinator,
  lintBundle,
  loadBundle,
  MARKDOWN_AUTHORING_RULE,
  mutate,
  PRIORITIES,
  parseConcept,
  planDocumentMove,
  READY_QUEUE_DESCRIPTION,
  readEditableDocument,
  readyWorkItems,
  recoverDocumentMove,
  renderIndex,
  STATES,
  setStatus,
  sourcePage,
  WORK_ITEM_TYPES,
  type WorkItem,
} from "@gitdocket/core";
import { deriveRepositoryOverview } from "@gitdocket/core/orientation";
import {
  attributionFromMcpMeta,
  errorCategory,
  OPERATIONS,
  type Operation,
  observeOperation,
  recordOperationOutcome,
  searchOutcome,
  Telemetry,
} from "@gitdocket/core/telemetry";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { extensionPage } from "./extensions";
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

const json = (value: unknown) => {
  const text = JSON.stringify(value, null, 2);
  recordOperationOutcome({ responseBytes: Buffer.byteLength(text) });
  return {
    content: [{ type: "text" as const, text }],
  };
};

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
  const server = new McpServer(
    { name: "docket", version: DOCKET_VERSION },
    { instructions: MARKDOWN_AUTHORING_RULE },
  );
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
      const attribution = attributionFromMcpMeta(params?._meta);
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
    "workflow_extensions",
    {
      title: "Discover installed workflow extensions",
      description:
        "Read current installed package availability, qualified workflow names, project choices and source paths. Read the selected canonical Markdown with source_page and relevant project_guidance before invocation. Only available workflows may be invoked; installation, discovery and tool bindings grant no task or external-write authority. Reread at each work boundary: running sessions may retain stale instructions. No lifecycle mutation or task selection occurs. Results are bounded to 24 KB and paginated; outputLimited explicitly directs oversized package inspection to CLI show before invocation.",
      inputSchema: {
        id: z.string().min(1).optional().describe("Optional exact package ID"),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: READ,
    },
    async ({ id, offset, limit }) => {
      const result = await owner.extensions();
      if (result.status === "unsupported") return json(result);
      return json(extensionPage(result, id, offset, limit));
    },
  );

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
      const { bundle: b, config } = await owner.metadata();
      const evidence = (await owner.evidence(config)?.snapshot(b.byId))?.git
        .taskProgress;
      const ready = readyWorkItems(b);
      return json(
        ready
          .slice(0, limit)
          .map((w) => withTaskProgress(summarize(w), evidence)),
      );
    },
  );

  server.registerTool(
    "task_list",
    {
      title: "List work items",
      description:
        "Local work items with observed worktree progress, optionally filtered by recorded status or type. Use task_progress to discover tasks existing only on other branches.",
      inputSchema: {
        status: z.enum(STATES).optional().describe("filter by status"),
        type: z.enum(WORK_ITEM_TYPES).optional().describe("Task or Epic"),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional().default(0),
      },
      annotations: READ,
    },
    async ({ status, type, limit, offset }) => {
      const { bundle: b, config } = await owner.metadata();
      const evidence = (await owner.evidence(config)?.snapshot(b.byId))?.git
        .taskProgress;
      let items = b.workItems;
      if (status) items = items.filter((w) => w.fm.status === status);
      if (type) items = items.filter((w) => w.fm.type === type);
      return json(
        items
          .slice(offset, limit === undefined ? undefined : offset + limit)
          .map((w) => withTaskProgress(summarize(w), evidence)),
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
      const evidence = (await owner.evidence(config)?.snapshot(b.byId))?.git
        .taskProgress;
      const item = b.byId(id);
      if (!item) {
        const foreign = foreignTaskSummaries(evidence).find((p) => p.id === id);
        if (foreign) return json(foreign);
        throw new Error(`no item with id ${id}`);
      }
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
        ...withTaskProgress({ id: current.fm.id }, evidence),
        path: item.path,
        frontmatter: current.fm,
        source,
      });
    },
  );

  server.registerTool(
    "task_progress",
    {
      title: "Read task progress across worktrees",
      description:
        "Bounded local worktree and committed-ref observations, including foreign-only tasks, conflicts and coverage; read-only.",
      inputSchema: { id: z.string().optional() },
      annotations: READ,
    },
    async ({ id }) => {
      const { bundle, config } = await owner.metadata();
      const evidence = (await owner.evidence(config)?.snapshot(bundle.byId))
        ?.git.taskProgress;
      if (!evidence)
        return json({
          complete: false,
          diagnostics: ["Git task progress unavailable"],
          tasks: [],
        });
      const tasks = evidence.tasks.filter((p) => !id || p.id === id);
      return json({
        ...evidence,
        tasks,
        observations: tasks.flatMap((p) => p.observations),
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
      const page = snapshot.search.searchPage(query, { limit });
      recordOperationOutcome(
        searchOutcome(page.hits.length, page.total, limit),
      );
      return json(page.hits);
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
      recordOperationOutcome({
        responseBytes: Buffer.byteLength(page.text),
        truncated: page.nextCursor ? "response" : "none",
      });
      return json(page);
    },
  );

  server.registerTool(
    "project_guidance",
    {
      title: "Read project guidance",
      description:
        "Read the optional authored project-guidance entry point before direct or tracked work. Returns exact bounded source, continuation cursor and explicit absent/invalid/unavailable states with link diagnostics. Follow remaining source pages and relevant scoped links using source_page before acting. Does not select work, read active-task state or execute procedures; scope and precedence remain agent judgment.",
      annotations: READ,
    },
    async () => json(await owner.guidance()),
  );

  server.registerTool(
    "index",
    {
      title: "Refresh wiki discovery",
      description:
        "Refresh the generated bundle index after authorized source changes, preserving authored index regions. Does not select or change tracked work.",
      annotations: WRITE,
    },
    async () =>
      json(
        await owner.mutate(({ store, config }) =>
          mutate(store, async () => {
            const current = (await store.list()).includes("index.md")
              ? await store.read("index.md")
              : "";
            const next = applyIndex(
              current,
              renderIndex(await loadBundle(store, config)),
            );
            if (current !== next) await store.write("index.md", next);
            return {
              changed: current !== next,
              paths: current !== next ? ["index.md"] : [],
            };
          }),
        ),
      ),
  );

  server.registerTool(
    "document_move_plan",
    {
      title: "Inspect a wiki page move",
      description:
        "Plan an ordinary Reference/Spec/Playbook path move without writing. Returns affected paths, supported link replacements, blockers, unmanaged-reference warnings and a complete bundle version. Title-only edits use document_edit.",
      inputSchema: { from: z.string(), to: z.string() },
      annotations: READ,
    },
    async ({ from, to }) =>
      json(
        await owner.readDocument(({ store, config }) =>
          planDocumentMove(store, config, from, to),
        ),
      ),
  );
  server.registerTool(
    "document_move_apply",
    {
      title: "Apply a reviewed wiki page move",
      description:
        "Recompute and apply a reviewed plan from from/to/expectedVersion; repair supported links and index. Does not change tracker state or guidance. If state is recovery_required, retain the receipt and use document_move_recover; originals remain in its journal.",
      inputSchema: {
        from: z.string(),
        to: z.string(),
        expectedVersion: z.string(),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async (input) =>
      json(
        await owner.mutate(({ store, config }) =>
          applyDocumentMove(store, config, input),
        ),
      ),
  );
  server.registerTool(
    "document_move_recover",
    {
      title: "Recover an interrupted wiki move",
      description:
        "Resume a move using its recovery token. Validates the journal and original/planned source versions; unrelated changes require explicit reconciliation. Never blindly restore journal bytes.",
      inputSchema: { token: z.string() },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ token }) =>
      json(
        await owner.mutate(({ store, config }) =>
          recoverDocumentMove(store, config, token),
        ),
      ),
  );

  server.registerTool(
    "document_create",
    {
      title: "Create a wiki page",
      description:
        "Create an ordinary Reference, Spec or Playbook at a bundle-relative path; collisions are rejected. Search for existing knowledge first. Does not track work or activate guidance. Run index afterward.",
      inputSchema: {
        path: z.string(),
        type: z.enum(DOCUMENT_TYPES),
        title: z.string(),
        description: z.string().optional(),
        body: z.string(),
        tags: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    async (input) =>
      json(
        await owner.mutate(({ store, config }) =>
          createDocument(store, config, input),
        ),
      ),
  );
  server.registerTool(
    "document_read",
    {
      title: "Read a complete editable document",
      description:
        "Read the complete body, title, description and version for a versioned save. Never use paged source excerpts as replacement drafts.",
      inputSchema: { path: z.string() },
      annotations: READ,
    },
    async ({ path }) =>
      json(
        await owner.readDocument(({ store, config }) =>
          readEditableDocument(store, config, path),
        ),
      ),
  );
  server.registerTool(
    "document_edit",
    {
      title: "Save a versioned document edit",
      description:
        "Replace only the supplied body/title/description at expectedVersion. A newer source conflicts without writing. No tracker transitions or guidance selection occur. Run index after changes.",
      inputSchema: {
        path: z.string(),
        expectedVersion: z.string(),
        patch: z
          .object({
            body: z.string().optional(),
            title: z.string().nullable().optional(),
            description: z.string().nullable().optional(),
          })
          .strict(),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ path, ...input }) =>
      json(
        await owner.mutate(({ store, config }) =>
          editDocument(store, config, path, input),
        ),
      ),
  );

  server.registerTool(
    "decision_create",
    {
      title: "Record a decision",
      description:
        "Create an accepted Decision under decisions/ with the configured decision prefix and its own sequence. Record context, alternatives, choice and consequences. Does not start tracked work or change project guidance. Run index afterward to refresh the derived index.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        context: z
          .string()
          .optional()
          .describe("context, relevant links and alternatives considered"),
        decision: z.string().optional().describe("accepted choice and why"),
        consequences: z
          .string()
          .optional()
          .describe("tradeoffs and follow-up effects"),
      },
      annotations: WRITE,
    },
    async (input) =>
      json(
        await owner.mutate(async ({ store, config }) =>
          createDecision(store, config, input, idCoordinator),
        ),
      ),
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
        "Move a work item through the state machine (invalid transitions are rejected). Moving to closed requires a disposition note. A project may permit closed Tasks or Epics to return to todo; that move requires a reason note and preserves the earlier disposition.",
      inputSchema: {
        id: z.string().min(1),
        to: z.enum(STATES),
        note: z
          .string()
          .optional()
          .describe(
            "dated Log entry; required when moving to closed or reopening closed work",
          ),
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
