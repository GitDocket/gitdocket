// docket init — pure text transforms for adopt-in-place. Adoption is
// additive, never a migration: every function here takes what already
// exists and returns a composed result, so callers can guarantee "never
// clobbers". Filesystem and git orchestration live in the CLI; this module
// stays runtime-portable.

import { INDEX_MARKER } from "./indexmd";
import { findFreshnessWatermark } from "./lint";
import { DOCKET_VERSION } from "./version";

export type InitAction = "create" | "update" | "skip";

export interface InitResult {
  action: InitAction;
  content: string;
  /** Present when action is "skip" for a reason worth surfacing. */
  reason?: string;
}

/** docket.yaml template — mirrors this repo's reference copy. */
export function defaultConfigYaml(project: string, bundle: string): string {
  return `# Docket configuration — consumed by the docket CLI and by agents.

bundle: ${bundle}

project: ${project}          # ID key for work items: ${project}-1, ${project}-2, … (epics + tasks share one sequence)

ids:
  scheme: sequential     # next = max existing + 1
  decision_prefix: DEC   # decisions number independently: DEC-1, DEC-2, …

workflow:
  states: [todo, in-progress, blocked, in-review, done, closed]
  # \`ready\` is never written to a file — it is derived:
  # status == todo AND every task in depends_on has status == done.

git:
  trailer: "Task"        # commit trailer key linking commits to tasks
  branch_prefix: "task/" # branch naming: task/${project}-12-short-slug
`;
}

/** Project key from a directory name: letters/digits, uppercased, max 3. */
export function deriveProjectKey(dirname: string): string {
  const key = dirname
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 3);
  return key || "DKT";
}

/** Bundle files scaffolded when missing. Paths are bundle-relative. */
export function scaffoldFiles(
  project: string,
  today: string,
): { path: string; content: string }[] {
  return [
    {
      path: "index.md",
      content: `# ${project} — docs & work\n\n<!-- Replace the heading above with the project's full name and add one concise sentence explaining its purpose. Docket preserves this preamble when regenerating the index. -->\n\n${INDEX_MARKER}\n`,
    },
    {
      path: "log.md",
      content: `# Log\n\n## ${today}\n\n- **Create** — Adopted Docket (\`docket init\`).\n`,
    },
  ];
}

/**
 * Stamp the freshness baseline watermark into log.md. Adoption is
 * the baseline: a fresh bundle has nothing to retrospect, so init seeds the
 * watermark the docket-freshness workflow advances from — instead of lint
 * nagging for a ritual with nothing to sweep. The entry lands under today's
 * section (log.md is newest-first). "create" refers to the entry — the file
 * itself always pre-exists (scaffolded or brownfield).
 */
export function composeFreshnessBaseline(
  log: string,
  sha: string | undefined,
  today: string,
): InitResult {
  if (findFreshnessWatermark(log))
    return { action: "skip", content: log, reason: "already stamped" };
  if (!sha) return { action: "skip", content: log, reason: "no commits yet" };
  const entry = `- **Freshness** — baseline at adoption; reviewed through \`${sha}\` (nothing to review before Docket).`;
  const heading = `## ${today}`;
  const lines = log.split("\n");
  const at = lines.indexOf(heading);
  if (at >= 0) {
    lines.splice(at + 1, 0, "", entry);
    return { action: "create", content: lines.join("\n") };
  }
  // No section for today — open one. The log is newest-first, so it goes
  // right after the title (or at the very top of a title-less log).
  const title = lines.findIndex((line) => line.startsWith("# "));
  lines.splice(title + 1, 0, "", heading, "", entry);
  return { action: "create", content: lines.join("\n") };
}

const HOOK_BEGIN = `# >>> docket prepare-commit-msg@${DOCKET_VERSION} >>>`;
const HOOK_END = "# <<< docket prepare-commit-msg <<<";
// Matches the begin marker at any version, and the legacy unversioned form.
const HOOK_MARKER_PREFIX = "# >>> docket prepare-commit-msg";

// Self-contained sh block; variable names are prefixed so appending into an
// existing hook can't collide, and every failure path exits 0 so a broken
// docket state never blocks a commit.
const HOOK_BLOCK = `${HOOK_BEGIN}
# Inject the active task's trailer into the commit message. Active task is
# per-checkout state in .docket/active-task (untracked), so git worktrees
# each carry their own active task.
docket_msg_file="$1"
docket_top="$(git rev-parse --show-toplevel 2>/dev/null)" || docket_top=""
if [ -n "$docket_top" ] && [ -f "$docket_top/.docket/active-task" ]; then
  docket_task_id="$(head -n1 "$docket_top/.docket/active-task" | tr -d '[:space:]')"
  if [ -n "$docket_task_id" ] && ! grep -qi "^Task:" "$docket_msg_file"; then
    git interpret-trailers --in-place --trailer "Task: $docket_task_id" "$docket_msg_file"
  fi
fi
${HOOK_END}
`;

/**
 * Compose the trailer-injecting block into a prepare-commit-msg hook.
 * Missing hook → create; existing without our block → append; already
 * installed → skip. Never rewrites what's there.
 */
export function composeHook(existing: string | undefined): InitResult {
  if (existing === undefined) {
    return { action: "create", content: `#!/bin/sh\n${HOOK_BLOCK}` };
  }
  // Our marker (any version), or any hand-rolled hook already reading the
  // active-task file (this repo's Phase 0 hook predates the marker).
  if (
    existing.includes(HOOK_MARKER_PREFIX) ||
    existing.includes(".docket/active-task")
  ) {
    return { action: "skip", content: existing, reason: "already installed" };
  }
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return { action: "update", content: `${base}\n${HOOK_BLOCK}` };
}

// Full block span, any marker version — for upgrade's regenerate-in-place.
const HOOK_BLOCK_RE =
  /# >>> docket prepare-commit-msg(@\S+)? >>>[\s\S]*?# <<< docket prepare-commit-msg <<<\n?/;

/**
 * Upgrade the hook block in place: the marked span (any version) is replaced
 * with the current block. Hand-rolled hooks — active-task readers without our
 * marker — are never touched (same rule as composeHook, inverted: compose
 * skips what upgrade regenerates).
 */
export function upgradeHookBlock(existing: string): InitResult {
  if (!HOOK_BLOCK_RE.test(existing)) {
    return {
      action: "skip",
      content: existing,
      reason: existing.includes(".docket/active-task")
        ? "hand-rolled hook — never touched"
        : "no docket block",
    };
  }
  // Replacer fn: the block contains a literal `$1`, which a string
  // replacement would eat as a capture-group reference.
  const content = existing.replace(HOOK_BLOCK_RE, () => HOOK_BLOCK);
  return content === existing
    ? { action: "skip", content: existing, reason: "up to date" }
    : { action: "update", content };
}

const MCP_SERVER = { command: "docket-mcp" };

const CODEX_MCP_BEGIN = `# >>> docket mcp@${DOCKET_VERSION} >>>`;
const CODEX_MCP_END = "# <<< docket mcp <<<";
const CODEX_MCP_BEGIN_RE = /# >>> docket mcp(@\S+)? >>>/;
const CODEX_MCP_BLOCK = `${CODEX_MCP_BEGIN}
[mcp_servers.docket]
command = "docket-mcp"
${CODEX_MCP_END}
`;
const CODEX_MCP_BLOCK_RE =
  /# >>> docket mcp(@\S+)? >>>[\s\S]*?# <<< docket mcp <<<\n?/;

/** Register the docket MCP server in .mcp.json without touching other entries. */
export function mergeMcpJson(existing: string | undefined): InitResult {
  if (existing === undefined) {
    return {
      action: "create",
      content: `${JSON.stringify({ mcpServers: { docket: MCP_SERVER } }, null, 2)}\n`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { action: "skip", content: existing, reason: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { action: "skip", content: existing, reason: "not a JSON object" };
  }
  const root = parsed as Record<string, unknown>;
  const servers =
    typeof root.mcpServers === "object" && root.mcpServers !== null
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  if (servers.docket) {
    return { action: "skip", content: existing, reason: "already registered" };
  }
  root.mcpServers = { ...servers, docket: MCP_SERVER };
  return { action: "update", content: `${JSON.stringify(root, null, 2)}\n` };
}

/**
 * Add Docket's marker-managed MCP table to a valid Codex project config.
 * TOML validation belongs to the runtime caller; this pure transform only
 * composes text and refuses to replace an existing docket registration.
 */
export function mergeCodexConfig(existing: string | undefined): InitResult {
  if (existing === undefined)
    return { action: "create", content: CODEX_MCP_BLOCK };
  if (
    CODEX_MCP_BEGIN_RE.test(existing) ||
    /^\s*\[\s*mcp_servers(?:\.|\s*\.\s*)["']?docket["']?\s*\]\s*$/m.test(
      existing,
    )
  ) {
    return { action: "skip", content: existing, reason: "already registered" };
  }
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return { action: "update", content: `${base}\n${CODEX_MCP_BLOCK}` };
}

/** Regenerate only Docket's marked Codex MCP block; never add one. */
export function upgradeCodexConfig(existing: string): InitResult {
  if (!CODEX_MCP_BLOCK_RE.test(existing)) {
    return {
      action: "skip",
      content: existing,
      reason: "no docket block",
    };
  }
  const content = existing.replace(CODEX_MCP_BLOCK_RE, () => CODEX_MCP_BLOCK);
  return content === existing
    ? { action: "skip", content: existing, reason: "up to date" }
    : { action: "update", content };
}

export const ALLOW_RULES = ["mcp__docket", "Bash(docket:*)"] as const;

/**
 * Ensure .claude/settings.json pre-approves the docket surface:
 * enableAllProjectMcpServers plus the allow rules. Preserves everything else.
 */
export function mergeClaudeSettings(existing: string | undefined): InitResult {
  let root: Record<string, unknown> = {};
  if (existing !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { action: "skip", content: existing, reason: "not valid JSON" };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { action: "skip", content: existing, reason: "not a JSON object" };
    }
    root = parsed as Record<string, unknown>;
  }

  const permissions =
    typeof root.permissions === "object" && root.permissions !== null
      ? (root.permissions as Record<string, unknown>)
      : {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((r): r is string => typeof r === "string")
    : [];
  const missing = ALLOW_RULES.filter((rule) => !allow.includes(rule));

  if (
    existing !== undefined &&
    missing.length === 0 &&
    root.enableAllProjectMcpServers === true
  ) {
    return { action: "skip", content: existing, reason: "already configured" };
  }

  root.enableAllProjectMcpServers = true;
  root.permissions = { ...permissions, allow: [...allow, ...missing] };
  return {
    action: existing === undefined ? "create" : "update",
    content: `${JSON.stringify(root, null, 2)}\n`,
  };
}

const GITIGNORE_BLOCK = `# docket per-checkout state (active task, cache)
.docket/
`;

/**
 * Ensure `.docket/` is ignored. Additive: appends a commented rule unless some
 * line already covers the directory; never reorders or rewrites existing rules.
 */
export function ensureGitignore(existing: string | undefined): InitResult {
  if (existing === undefined)
    return { action: "create", content: GITIGNORE_BLOCK };
  const covered = existing
    .split("\n")
    .map((line) => line.trim())
    .some(
      (line) =>
        line === ".docket" ||
        line === ".docket/" ||
        line === "/.docket" ||
        line === "/.docket/",
    );
  if (covered)
    return { action: "skip", content: existing, reason: "already ignored" };
  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  return { action: "update", content: `${base}\n${GITIGNORE_BLOCK}` };
}

/** True when a markdown source lacks a frontmatter block with a `type` key. */
export function needsFrontmatter(source: string): boolean {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return true;
  return !/^type:/m.test(match[1] ?? "");
}

/** Mechanical type proposal from a bundle-relative path — the agent refines it. */
export function proposeType(path: string): string {
  if (path.startsWith("work/epics/")) return "Epic";
  if (path.startsWith("work/tasks/")) return "Task";
  if (path.startsWith("decisions/")) return "Decision";
  if (path.startsWith("specs/")) return "Spec";
  if (path.startsWith("reference/")) return "Reference";
  if (path.startsWith("workflows/")) return "Workflow";
  return "Doc";
}
