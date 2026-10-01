import { foreignTaskSummaries, withTaskProgress } from "@gitdocket/core";
// @gitdocket/mcp — the auto-approvable agent surface. Every tool is a
// narrow, named, zod-validated mirror of a @gitdocket/core op; none executes
// shell. Writes address IDs; source pages accept only exact members of the
// bundle inventory. Files are reached through core's rooted FileStore. That containment is what
// makes allowlisting the whole server (`mcp__docket`) safe. Read tools carry
// readOnlyHint so cautious users can allowlist reads alone.

import { createHash } from "node:crypto";
import {
  appendLog,
  applyDocumentMove,
  applyIndex,
  applyReconciliation,
  buildSchemas,
  compactWriteReceipt,
  createDecision,
  createDocument,
  createWorkItem,
  DOCKET_VERSION,
  DOCUMENT_TYPES,
  type DocketConfig,
  docketIntent,
  editDocument,
  errorReceipt,
  type FileStore,
  GitWorktreeIdCoordinator,
  lintBundle,
  lintSummary,
  loadBundle,
  MARKDOWN_AUTHORING_RULE,
  makeLintReport,
  mutate,
  overviewDriftOutcome,
  PRIORITIES,
  parseConcept,
  planDocumentMove,
  planReconciliation,
  READY_QUEUE_DESCRIPTION,
  ReconcileError,
  readDocumentSection,
  readEditableDocument,
  readLintBaseline,
  readReconciliationSource,
  readWorkflowFreshness,
  readyWorkItems,
  reconcileApplySchema,
  reconcileSelectionSchema,
  recoverDocumentMove,
  recoverReconciliation,
  renderIndex,
  STATES,
  setStatus,
  sourcePage,
  taskDriftOutcome,
  taskDriftReceipt,
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
import {
  CallToolRequestSchema,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { extensionPage } from "./extensions";
import { type RepositoryResolver, snapshotStore } from "./owner";

import {
  TARGETING_RULE,
  TargetError,
  type TargetOptions,
  TargetRouter,
} from "./target";

const MUTATIONS = new Set([
  "document_create",
  "document_edit",
  "document_move_apply",
  "document_move_recover",
  "reconcile_apply",
  "reconcile_recover",
  "index",
  "task_create",
  "decision_create",
  "set_status",
  "append_log",
]);

const READ = { readOnlyHint: true, openWorldHint: false } as const;
// Writes are additive or state-machine-guarded frontmatter edits — nothing deletes.
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

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
  targetOptions: TargetOptions = {},
): McpServer {
  const server = new McpServer(
    { name: "docket", version: DOCKET_VERSION },
    { instructions: `${MARKDOWN_AUTHORING_RULE}\n${TARGETING_RULE}` },
  );
  const router = new TargetRouter(store, config, root, resolve, targetOptions);
  const owner = new Proxy(router.launchOwner, {
    get(_owner, key) {
      const selected = router.current()?.owner ?? router.launchOwner;
      const value = Reflect.get(selected, key);
      return typeof value === "function" ? value.bind(selected) : value;
    },
  });
  const launchCoordinator = root
    ? new GitWorktreeIdCoordinator(root)
    : undefined;
  const idCoordinator = () =>
    router.current()?.entry?.coordinator ?? launchCoordinator;
  const json = (value: unknown) => {
    if (value && typeof value === "object" && "coordination" in value)
      recordOperationOutcome(
        overviewDriftOutcome(
          value.coordination as Parameters<typeof overviewDriftOutcome>[0],
        ),
      );
    const bound = router.current();
    const projected =
      bound?.mutation &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
        ? {
            ...value,
            checkout: { ...bound.receipt, matched: !bound.targetFailure },
          }
        : value;
    const text = JSON.stringify(projected, null, 2);
    recordOperationOutcome({ responseBytes: Buffer.byteLength(text) });
    return { content: [{ type: "text" as const, text }] };
  };
  const failed = (operation: string, error: unknown, advisory: object = {}) => {
    const failure = router.current()?.targetFailure ?? error;
    const receipt = errorReceipt(operation, failure);
    return {
      ...json({
        ...(failure instanceof TargetError
          ? {
              ...receipt,
              mutation: failure.mutation,
              error: {
                code: failure.code,
                message: failure.message,
                messageOmitted: false,
              },
              recovery:
                "Review the intended checkout and current source before retrying; no automatic retarget or rollback is authorized.",
              checkout: { supported: router.local, matched: false },
            }
          : receipt),
        ...advisory,
      }),
      isError: true,
    };
  };
  const reply = async (
    operation: string,
    response: "compact" | "full" | undefined,
    run: () => Promise<unknown>,
    review?: () => Promise<object>,
  ) => {
    let advisory = {};
    try {
      advisory = (await review?.()) ?? {};
      const result = await run();
      const value =
        result && typeof result === "object"
          ? { ...result, ...advisory }
          : result;
      return json(
        response === "compact"
          ? compactWriteReceipt(operation, value, router.current()?.receipt)
          : value,
      );
    } catch (error) {
      return failed(operation, error, advisory);
    }
  };
  const reviewTask = async (target: { id?: string; path?: string }) => {
    const { bundle, store, config } = await owner.metadata();
    const item = target.id
      ? bundle.byId(target.id)
      : bundle.workItems.find((item) => item.path === target.path);
    if (item?.kind !== "work" || item.fm.type !== "Task") return {};
    const progress = (await owner.evidence(config)?.snapshot(bundle.byId))?.git
      .taskProgress;
    const drift = taskDriftReceipt(item.fm.id, progress);
    recordOperationOutcome(taskDriftOutcome(drift));
    return {
      drift,
      instructions: await readWorkflowFreshness(store),
    };
  };
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, () =>
    router.invalidateRoots(),
  );
  const telemetry = root ? new Telemetry(root, "mcp") : undefined;
  // Wrap the SDK's public request-handler registration, outside tool validation.
  // Handle validation and target selection once, with the selected request lease.
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
      const invoke = () =>
        observeOperation(
          router.current()?.entry?.telemetry ?? telemetry,
          operation as Operation,
          async () => {
            const result = await handler(request, extra);
            const value = result as {
              isError?: boolean;
              content?: { type?: string; text?: string }[];
            };
            const texts = (value.content ?? [])
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "");
            if (value.isError && router.current()?.targetFailure)
              return failed(operation, router.current()?.targetFailure);
            if (
              value.isError &&
              !texts.some((t) => {
                try {
                  return [
                    "docket-receipt/v1",
                    "docket-reconcile-result/v1",
                  ].includes(JSON.parse(t)?.schema);
                } catch {
                  return false;
                }
              })
            )
              return {
                ...value,
                ...json(
                  errorReceipt(
                    operation,
                    { message: texts.join("\n") },
                    texts.some((t) =>
                      t.includes(
                        "Input validation error: Invalid arguments for tool",
                      ),
                    ),
                  ),
                ),
              };
            recordOperationOutcome({
              responseBytes: texts.reduce(
                (n, t) => n + Buffer.byteLength(t),
                0,
              ),
            });
            return result;
          },
          {
            dimensions: () => owner.dimensions(),
            attribution,
            resultError: (result) => {
              const value = result as {
                isError?: boolean;
                content?: { text?: string }[];
              };
              if (!value.isError) return "none";
              try {
                const receipt = JSON.parse(value.content?.[0]?.text ?? "");
                if (receipt.error?.code === "invalid-arguments")
                  return "validation";
                return errorCategory(
                  Object.assign(new Error(receipt.error?.message ?? ""), {
                    code: receipt.error?.code,
                  }),
                );
              } catch {
                return errorCategory(value.content?.[0]?.text);
              }
            },
          },
        );
      const roots = server.server.getClientCapabilities()?.roots;
      const provider = {
        supported: roots !== undefined,
        notifications: roots?.listChanged === true,
        list: () => server.server.listRoots(undefined, { timeout: 1500 }),
      };
      let bound: Awaited<ReturnType<TargetRouter["bind"]>>;
      try {
        bound = await router.bind(
          params?._meta,
          provider,
          MUTATIONS.has(operation),
        );
      } catch (error) {
        return observeOperation(
          telemetry,
          operation as Operation,
          async () => failed(operation, error),
          { attribution, resultError: () => errorCategory(error) },
        );
      }
      return router.run(bound, invoke);
    });
  };
  const close = server.close.bind(server);
  server.close = async () => {
    router.close();
    await close();
  };
  const onclose = server.server.onclose;
  server.server.onclose = () => {
    router.close();
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
      description: `${docketIntent("orientation").discovery} The default brief view includes live selections, omitted counts and dated context. Request view: full for the compatibility evidence model, including state-of-play refresh.`,
      inputSchema: {
        view: z.enum(["brief", "full"]).optional().default("brief"),
      },
      annotations: READ,
    },
    async ({ view }) => {
      const { bundle, config, store } = await owner.metadata();
      return json(
        await deriveRepositoryOverview({
          bundle,
          config,
          store,
          root: router.current()?.receipt.root ?? root,
          evidence: owner.evidence(config),
          view,
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
        "Run complete global conformance and practice validation. Default full view retains the diagnostic array. Summary is bounded to 8 KiB with global severity/category/code counts, prioritized source references and explicit omissions; changed_paths filters warnings only, never global errors. Optional baseline_path reads a complete saved CLI report inside this checkout; missing/incompatible evidence remains unknown. This read does not save reports or run CLI strict policy.",
      inputSchema: {
        view: z.enum(["full", "summary"]).optional(),
        changed_paths: z.array(z.string().min(1).max(2048)).max(32).optional(),
        baseline_path: z.string().min(1).max(2048).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(32).optional(),
      },
      annotations: READ,
    },
    async (args) => {
      const { snapshot, config } = await owner.read();
      const now = new Date();
      const diagnostics = await lintBundle(
        snapshotStore(snapshot),
        snapshot.bundle,
        { now },
      );
      if (
        args.view !== "summary" &&
        !args.changed_paths?.length &&
        args.baseline_path === undefined &&
        !args.offset
      )
        return json(diagnostics);
      const selectedRoot = router.current()?.entry?.input.root ?? root;
      const baseline =
        args.baseline_path !== undefined
          ? selectedRoot
            ? await readLintBaseline(args.baseline_path, selectedRoot)
            : {
                status: "unavailable" as const,
                reason: "No checkout root is available for baseline evidence.",
              }
          : undefined;
      const report = makeLintReport(
        diagnostics,
        snapshot.sources,
        config,
        { now },
        selectedRoot ?? "in-memory",
        now,
      );
      return json(
        lintSummary(report, baseline, {
          paths: args.changed_paths,
          offset: args.offset,
          limit: args.limit,
        }),
      );
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
      inputSchema: { response: z.enum(["compact", "full"]).optional() },
    },
    async ({ response }) =>
      reply("index", response, () =>
        owner.mutate(({ store, config }) =>
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
              version: createHash("sha256").update(next).digest("hex"),
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
  const reconciliationRoot = () => {
    const selected = router.current()?.receipt.root ?? root;
    if (!selected)
      throw new ReconcileError(
        "unsupported",
        "Reconciliation needs an explicitly bound local checkout.",
      );
    return selected;
  };
  server.registerTool(
    "reconcile_plan",
    {
      title: "Review Docket reconciliation",
      annotations: READ,
      description:
        "Plan explicitly selected Docket paths from a local ref or saved linked worktree. Bounded pages identify versions, semantic conflicts, drafts and derived index content; no writes, fetch, Git merge, task completion or application integration claim. Review exact sources before applying.",
      inputSchema: {
        selection: reconcileSelectionSchema,
        offset: z.number().int().nonnegative().optional().default(0),
      },
    },
    async ({ selection, offset }) => {
      try {
        const result = await owner.readDocument(({ store, config }) =>
          planReconciliation(
            store,
            config,
            reconciliationRoot(),
            selection,
            offset,
          ),
        );
        recordOperationOutcome({
          resultCount: result.items.length,
          resultTotal: result.total,
          truncated: result.omitted ? "results" : "none",
        });
        return json(result);
      } catch (error) {
        return failed("reconcile_plan", error);
      }
    },
  );
  server.registerTool(
    "reconcile_source",
    {
      title: "Read a reconciliation source",
      annotations: READ,
      description:
        "Read exact bounded base/local/incoming/proposed source pages for a selected path, guarded by the reviewed plan version. Follow nextOffset for the remaining source before accepting semantic changes.",
      inputSchema: {
        selection: reconcileSelectionSchema,
        expectedVersion: z.string(),
        path: z.string(),
        side: z.enum(["base", "local", "incoming", "proposed"]),
        offset: z.number().int().nonnegative().optional().default(0),
      },
    },
    async ({ selection, expectedVersion, path, side, offset }) => {
      try {
        return json(
          await owner.readDocument(({ store, config }) =>
            readReconciliationSource(
              store,
              config,
              reconciliationRoot(),
              selection,
              expectedVersion,
              path,
              side,
              offset,
            ),
          ),
        );
      } catch (error) {
        return failed("reconcile_source", error);
      }
    },
  );
  const reconciliationReply = async (
    operation: string,
    execute: () => ReturnType<typeof applyReconciliation>,
  ) => {
    try {
      const result = await execute();
      recordOperationOutcome({
        resultCount: result.writes,
        resultTotal: result.changedPaths,
        saveState: result.state === "noop" ? "unchanged" : "saved_locally",
        ...("error" in result && result.error?.code === "source-conflict"
          ? { failureReason: "source_changed" as const }
          : {}),
      });
      return {
        ...json(result),
        ...(result.state === "recovery_required" ? { isError: true } : {}),
      };
    } catch (error) {
      return failed(operation, error);
    }
  };
  server.registerTool(
    "reconcile_apply",
    {
      title: "Apply reviewed Docket reconciliation",
      annotations: WRITE,
      description:
        "Apply one explicit disposition per selected path using a source-bound plan version. Semantic choices require reasons; terminal imports require acceptCompletion and local transition/dependency policy. Preserve original and planned bytes in a local recovery journal, keep unrelated code/drafts, and regenerate derived index content. No Git history or remote actions.",
      inputSchema: reconcileApplySchema.shape,
    },
    async (input) =>
      reconciliationReply("reconcile_apply", () =>
        owner.mutate(({ store, config }) =>
          applyReconciliation(store, config, reconciliationRoot(), input),
        ),
      ),
  );
  server.registerTool(
    "reconcile_recover",
    {
      title: "Recover reviewed reconciliation",
      annotations: WRITE,
      description:
        "Resume using the retained recovery token; accept only original or already-applied source bytes. Preserve unrelated changes and fail for explicit review when they differ. Repeated successful recovery is a no-op; no rollback or implementation integration is implied.",
      inputSchema: { token: z.string() },
    },
    async ({ token }) =>
      reconciliationReply("reconcile_recover", () =>
        owner.mutate(({ store, config }) =>
          recoverReconciliation(store, config, reconciliationRoot(), token),
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
        response: z.enum(["compact", "full"]).optional(),
      },
      annotations: WRITE,
    },
    async ({ response, ...input }) =>
      reply("document_create", response, () =>
        owner.mutate(({ store, config }) =>
          createDocument(store, config, input),
        ),
      ),
  );
  server.registerTool(
    "document_read",
    {
      title: "Read an editable document or section",
      description:
        "Read the complete body, title, description and version, or supply section to read one level-one section with the whole-source version. Section reads are not complete body drafts. Never use excerpts as replacement bodies.",
      inputSchema: { path: z.string(), section: z.string().optional() },
      annotations: READ,
    },
    async ({ path, section }) =>
      json(
        await owner.readDocument(async ({ store, config }) =>
          section === undefined
            ? readEditableDocument(store, config, path)
            : readDocumentSection(store, config, path, section),
        ),
      ),
  );
  server.registerTool(
    "document_edit",
    {
      title: "Save a versioned document edit",
      description:
        "Replace the supplied body or one named level-one section, plus optional title/description, at expectedVersion. A newer source conflicts without writing. No tracker transitions or content judgment occur. Refresh discovery after the source batch.",
      inputSchema: {
        path: z.string(),
        expectedVersion: z.string(),
        response: z.enum(["compact", "full"]).optional(),
        patch: z
          .object({
            body: z.string().optional(),
            section: z
              .object({ heading: z.string(), body: z.string().nullable() })
              .strict()
              .optional(),
            title: z.string().nullable().optional(),
            description: z.string().nullable().optional(),
          })
          .strict(),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ path, response, ...input }) =>
      reply(
        "document_edit",
        response,
        () =>
          owner.mutate(({ store, config }) =>
            editDocument(store, config, path, input),
          ),
        () => reviewTask({ path }),
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
        response: z.enum(["compact", "full"]).optional(),
      },
      annotations: WRITE,
    },
    async ({ response, ...input }) =>
      reply("decision_create", response, () =>
        owner.mutate(async ({ store, config }) =>
          createDecision(store, config, input, idCoordinator()),
        ),
      ),
  );

  server.registerTool(
    "task_create",
    {
      title: "Create a work item",
      description:
        "Create a Task or Epic with the next coordinated id. Supply body for complete authored Markdown in one exclusive source write (64 KiB); omit it for the legacy Context/Acceptance Criteria skeleton. Returns a usable source version; creation never picks up work. Refresh discovery and lint once after the final source batch.",
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
        body: z
          .string()
          .optional()
          .describe(
            "Complete authored Markdown body, preserving intentional source line breaks",
          ),
        response: z.enum(["compact", "full"]).optional(),
      },
      annotations: WRITE,
    },
    async (input) =>
      reply("task_create", input.response, () =>
        owner.mutate(
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
                body: input.body,
              },
              idCoordinator(),
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
        response: z.enum(["compact", "full"]).optional(),
        note: z
          .string()
          .optional()
          .describe(
            "dated Log entry; required when moving to closed or reopening closed work",
          ),
      },
      annotations: WRITE,
    },
    async ({ id, to, note, response }) =>
      reply(
        "set_status",
        response,
        () =>
          owner.mutate(({ store, config }) =>
            setStatus(store, config, id, to, { note }),
          ),
        () => reviewTask({ id }),
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
        response: z.enum(["compact", "full"]).optional(),
      },
      annotations: WRITE,
    },
    async ({ id, entry, response }) =>
      reply("append_log", response, () =>
        owner.mutate(({ store, config }) =>
          appendLog(store, config, id, entry),
        ),
      ),
  );

  server.server.setRequestHandler = register;
  return server;
}
