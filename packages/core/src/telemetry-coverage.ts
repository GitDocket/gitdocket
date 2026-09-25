import { OPERATIONS, type Operation } from "./telemetry";

export const COVERAGE_STATUSES = [
  "supported",
  "excluded",
  "uninstrumented",
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export interface SurfaceCoverage {
  surface: "cli" | "mcp" | "serve";
  /** CLI command path, MCP tool name, or Serve method + route pattern. */
  id: string;
  status: CoverageStatus;
  operation: Operation | null;
  since: string;
  notes?: string;
}

const supported = (
  surface: SurfaceCoverage["surface"],
  id: string,
  operation: Operation,
  since: string,
  notes?: string,
): SurfaceCoverage => ({
  surface,
  id,
  status: "supported",
  operation,
  since,
  ...(notes ? { notes } : {}),
});

const excluded = (
  surface: SurfaceCoverage["surface"],
  id: string,
  since: string,
  notes: string,
): SurfaceCoverage => ({
  surface,
  id,
  status: "excluded",
  operation: null,
  since,
  notes,
});

/** Original opt-in collector surface shipped with 0.4.1. */
const V1 = "0.4.1";
/** Editor, extension, and MCP discovery coverage first shipped in 0.5.0. */
const NEXT = "0.5.0";

export const TELEMETRY_COVERAGE: SurfaceCoverage[] = [
  supported("cli", "document move-plan", "document_move_plan", "0.5.1"),
  supported("cli", "document move-apply", "document_move_apply", "0.5.1"),
  supported("cli", "document move-recover", "document_move_recover", "0.5.1"),
  supported("mcp", "document_move_plan", "document_move_plan", "0.5.1"),
  supported("mcp", "document_move_apply", "document_move_apply", "0.5.1"),
  supported("mcp", "document_move_recover", "document_move_recover", "0.5.1"),
  excluded(
    "cli",
    "decision",
    "0.5.1",
    "Parent group; subcommands are counted.",
  ),
  supported("cli", "decision create", "decision_create", "0.5.1"),
  supported("mcp", "decision_create", "decision_create", "0.5.1"),
  excluded(
    "cli",
    "document",
    "0.5.1",
    "Command group; subcommands are observed.",
  ),
  supported("cli", "document create", "document_create", "0.5.1"),
  supported("cli", "document read", "document_read", "0.5.1"),
  supported("cli", "document edit", "document_edit", "0.5.1"),
  supported("mcp", "document_create", "document_create", "0.5.1"),
  supported("mcp", "document_read", "document_read", "0.5.1"),
  supported("mcp", "document_edit", "document_edit", "0.5.1"),
  supported("mcp", "index", "index", "0.5.1"),
  supported("cli", "ready", "ready", V1),
  supported("cli", "overview", "overview", V1),
  supported("cli", "search", "search", V1),
  supported("cli", "source", "source_page", V1),
  supported("cli", "guidance", "project_guidance", V1),
  supported("cli", "lint", "lint", V1),
  supported("cli", "index", "index", V1),
  supported("cli", "verify", "verify", V1),
  supported("cli", "verify status", "verify", V1),
  supported("cli", "init", "init", V1),
  supported("cli", "upgrade", "upgrade", V1),
  supported("cli", "task list", "task_list", V1),
  supported("cli", "task progress", "task_progress", "0.5.1"),
  supported("mcp", "task_progress", "task_progress", "0.5.1"),
  supported("serve", "GET /api/task-progress", "task_progress", "0.5.1"),
  supported("cli", "task create", "task_create", V1),
  supported("cli", "task start", "task_start", V1),
  supported("cli", "task stop", "task_stop", V1),
  supported("cli", "task move", "set_status", V1),
  supported("cli", "task edit", "task_edit", V1),
  supported("cli", "task close", "task_close", V1),
  supported("cli", "task log", "append_log", V1),
  supported("cli", "extension list", "extension_list", NEXT),
  supported("cli", "extension show", "extension_show", NEXT),
  supported("cli", "extension inspect", "extension_inspect", NEXT),
  supported("cli", "extension refresh", "extension_refresh", NEXT),
  supported("cli", "extension install", "extension_install", NEXT),
  supported("cli", "extension update", "extension_update", NEXT),
  supported("cli", "extension enable", "extension_enable", NEXT),
  supported("cli", "extension disable", "extension_disable", NEXT),
  supported("cli", "extension remove", "extension_remove", NEXT),
  supported("cli", "extension configure", "extension_configure", NEXT),
  supported("cli", "extension validate", "extension_validate", NEXT),
  supported("cli", "extension reconcile", "extension_reconcile", NEXT),
  supported("cli", "extension recover", "extension_recover", NEXT),
  excluded(
    "cli",
    "serve",
    V1,
    "Long-running process startup is not an adoption event; HTTP requests are counted on Serve.",
  ),
  excluded("cli", "task", V1, "Parent group; subcommands are counted."),
  excluded(
    "cli",
    "extension",
    NEXT,
    "Parent group; discovery and lifecycle subcommands are counted.",
  ),
  excluded(
    "cli",
    "telemetry",
    V1,
    "Controls and reports are never counted as adoption.",
  ),
  excluded("cli", "telemetry enable", V1, "Control surface."),
  excluded("cli", "telemetry status", V1, "Control surface."),
  excluded("cli", "telemetry disable", V1, "Control surface."),
  excluded("cli", "telemetry events", V1, "Control surface."),
  excluded("cli", "telemetry delete", V1, "Control surface."),
  excluded("cli", "telemetry report", V1, "Control surface."),
  {
    surface: "cli",
    id: "freshness",
    status: "uninstrumented",
    operation: "freshness",
    since: V1,
    notes:
      "Allowlisted for a possible future CLI; the freshness workflow is not a docket command.",
  },

  supported("mcp", "overview", "overview", V1),
  supported("mcp", "ready", "ready", V1),
  supported("mcp", "task_list", "task_list", V1),
  supported("mcp", "task_get", "task_get", V1),
  supported("mcp", "lint", "lint", V1),
  supported("mcp", "search", "search", V1),
  supported("mcp", "source_page", "source_page", V1),
  supported("mcp", "project_guidance", "project_guidance", V1),
  supported("mcp", "task_create", "task_create", V1),
  supported("mcp", "set_status", "set_status", V1),
  supported("mcp", "append_log", "append_log", V1),
  supported("mcp", "workflow_extensions", "workflow_extensions", NEXT),

  supported("serve", "GET /api/nav", "docs", V1),
  supported("serve", "GET /api/home", "overview", V1),
  supported("serve", "GET /api/docs", "docs", V1),
  supported("serve", "GET /api/activity", "activity", V1),
  supported("serve", "GET /api/search", "search", V1),
  supported("serve", "GET /api/board", "board", V1),
  supported("serve", "GET /api/epics", "epics", V1),
  supported("serve", "GET /api/tasks", "task_list", V1),
  supported("serve", "GET /api/facets", "config", V1),
  supported("serve", "GET /api/source/:path", "source_page", V1),
  supported("serve", "GET /api/concept/:path", "task_get", V1),
  supported("serve", "GET /api/work/:number", "task_get", V1),
  supported("serve", "GET /api/document-create", "edit_open", "0.5.1"),
  supported("serve", "POST /api/document-create", "document_create", "0.5.1"),
  supported("serve", "GET /api/guidance", "project_guidance", NEXT),
  supported("serve", "GET /api/edit-source/:path", "edit_open", NEXT),
  supported("serve", "POST /api/edit-source/:path", "edit_save", NEXT),
  supported("serve", "POST /api/edit-preview/:path", "edit_preview", NEXT),
  supported("serve", "POST /api/tasks/:id/status", "set_status", V1),
  supported("serve", "POST /api/tasks/:id/priority", "set_priority", V1),
  supported("serve", "POST /api/tasks/:id/reorder", "set_rank", V1),
  supported("serve", "POST /api/tasks/:id/rank", "set_rank", V1),
  supported("serve", "POST /api/tasks/:id/epic", "set_epic", V1),
  excluded(
    "serve",
    "GET /",
    V1,
    "HTML shell and assets are not product operations.",
  ),
  excluded("serve", "GET /assets/app.js", V1, "Bundled client asset."),
  excluded("serve", "HEAD *", V1, "Probe requests are excluded."),
  {
    surface: "serve",
    id: "commit",
    status: "uninstrumented",
    operation: "commit",
    since: V1,
    notes:
      "Allowlisted name with no current HTTP/CLI mapping; Git commits are not observed as operations.",
  },
];

export function coverageFor(
  surface: SurfaceCoverage["surface"],
  id: string,
): SurfaceCoverage | undefined {
  return TELEMETRY_COVERAGE.find(
    (entry) => entry.surface === surface && entry.id === id,
  );
}

export function cliOperation(args: string[]): Operation | undefined {
  const key =
    args[0] === "task" ||
    args[0] === "decision" ||
    args[0] === "document" ||
    args[0] === "extension" ||
    args[0] === "telemetry" ||
    (args[0] === "verify" && args[1])
      ? `${args[0]} ${args[1] ?? ""}`.trim()
      : (args[0] ?? "");
  const entry = coverageFor("cli", key) ?? coverageFor("cli", args[0] ?? "");
  return entry?.status === "supported"
    ? (entry.operation ?? undefined)
    : undefined;
}

export function serveOperation(
  method: string,
  path: string,
): Operation | undefined {
  const normalized = path.replace(/\/+$/, "") || "/";
  const exact = coverageFor("serve", `${method} ${normalized}`);
  if (exact?.status === "supported") return exact.operation ?? undefined;
  const patterns: [RegExp, string][] = [
    [/^GET \/api\/source\//, "GET /api/source/:path"],
    [/^GET \/api\/concept\//, "GET /api/concept/:path"],
    [/^GET \/api\/work\//, "GET /api/work/:number"],
    [/^GET \/api\/edit-source\//, "GET /api/edit-source/:path"],
    [/^POST \/api\/edit-source\//, "POST /api/edit-source/:path"],
    [/^POST \/api\/edit-preview\//, "POST /api/edit-preview/:path"],
    [/^POST \/api\/tasks\/[^/]+\/status$/, "POST /api/tasks/:id/status"],
    [/^POST \/api\/tasks\/[^/]+\/priority$/, "POST /api/tasks/:id/priority"],
    [/^POST \/api\/tasks\/[^/]+\/reorder$/, "POST /api/tasks/:id/reorder"],
    [/^POST \/api\/tasks\/[^/]+\/rank$/, "POST /api/tasks/:id/rank"],
    [/^POST \/api\/tasks\/[^/]+\/epic$/, "POST /api/tasks/:id/epic"],
  ];
  const candidate = `${method} ${normalized}`;
  for (const [pattern, id] of patterns) {
    if (!pattern.test(candidate)) continue;
    const entry = coverageFor("serve", id);
    return entry?.status === "supported"
      ? (entry.operation ?? undefined)
      : undefined;
  }
  return undefined;
}

export function serveRouteId(method: string, path: string): string {
  const pattern = path
    .replace(/:path\{[^}]+\}/g, ":path")
    .replace(/:number\{[^}]+\}/g, ":number")
    .replace(/:id\b/g, ":id");
  return `${method} ${pattern}`;
}

export function assertCoverageOperations(): void {
  for (const entry of TELEMETRY_COVERAGE) {
    if (
      entry.operation &&
      !OPERATIONS.includes(entry.operation as (typeof OPERATIONS)[number])
    )
      throw new Error(`${entry.id} names unknown operation ${entry.operation}`);
  }
}
