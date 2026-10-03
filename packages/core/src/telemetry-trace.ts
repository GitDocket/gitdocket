import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  type ContextContribution,
  contextEquality,
  readContextObservation,
  reviewContextVolume,
} from "./context-volume";
import { TELEMETRY_COVERAGE } from "./telemetry-coverage";

const MAX_ITEMS = 10000;
const MAX_MATCHES = 20000;
const MAX_BYTES = 8 * 1024 * 1024;
const cliNames = new Set(
  TELEMETRY_COVERAGE.filter((e) => e.surface === "cli").map((e) => e.id),
);
const mcpNames = new Set(
  TELEMETRY_COVERAGE.filter((e) => e.surface === "mcp").map((e) => e.id),
);
type Row = Record<string, unknown>;
const row = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};

/** Tokenize literal shell words only. Never evaluate commands or inspect script bodies. */
function shell(text: string): string[][] | null {
  if (text.length > 65536 || /<<|\$|`/.test(text)) return null;
  const commands: string[][] = [];
  let words: string[] = [],
    word = "",
    quote = "",
    active = false,
    redirect = false;
  const flush = () => {
    if (active && !redirect) words.push(word);
    if (active) redirect = false;
    word = "";
    active = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === "\\" && quote !== "'") {
      word += text[++i] ?? "";
      active = true;
    } else if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      active = true;
    } else if (/\s/.test(c)) {
      flush();
      if (c === "\n" && words.length) {
        commands.push(words);
        words = [];
      }
    } else if (c === ">" || c === "<") {
      if (active && /^\d+$/.test(word)) {
        word = "";
        active = false;
      }
      flush();
      if (text[i + 1] === c) i++;
      if (text[i + 1] === "&") i++;
      redirect = true;
    } else if (/[;&|]/.test(c)) {
      flush();
      if (words.length) commands.push(words);
      words = [];
    } else if (c === "#" && !active) {
      while (i < text.length && text[i] !== "\n") i++;
      flush();
      if (words.length) commands.push(words);
      words = [];
    } else {
      word += c;
      active = true;
    }
  }
  flush();
  if (quote || redirect) return null;
  if (words.length) commands.push(words);
  return commands;
}

interface Match {
  surface: "cli" | "mcp" | "shell";
  family: string;
  resource?: string;
}
function recognize(words: string[], cwd: string, depth = 0): Match[] | null {
  while (/^[A-Za-z_][\w]*=/.test(words[0] ?? "")) words = words.slice(1);
  const exe = (words[0] ?? "").split("/").at(-1);
  if (
    ["zsh", "bash", "sh"].includes(exe ?? "") &&
    /^-[a-z]*c[a-z]*$/.test(words[1] ?? "")
  ) {
    if (depth >= 2) return null;
    const commands = shell(words[2] ?? "");
    if (!commands) return null;
    const results: Match[] = [];
    for (const command of commands) {
      const matches = recognize(command, cwd, depth + 1);
      if (matches === null) return null;
      results.push(...matches);
    }
    return results;
  }
  let args: string[] | undefined;
  if (exe === "docket") args = words.slice(1);
  else if (["bun", "npm", "pnpm"].includes(exe ?? "")) {
    if (words[1] === "run" && words[2] === "docket")
      args = words.slice(3).filter((w, i) => !(i === 0 && w === "--"));
    else if (
      exe === "bun" &&
      /(?:^|\/)packages\/cli\/src\/index\.ts$/.test(words[1] ?? "")
    )
      args = words.slice(2);
  }
  if (args) {
    const family = cliNames.has(`${args[0]} ${args[1]}`)
      ? `${args[0]} ${args[1]}`
      : cliNames.has(args[0] ?? "")
        ? (args[0] as string)
        : "unknown";
    const matches: Match[] = [
      {
        surface: "cli",
        family:
          args.includes("--help") || args[0] === "help"
            ? family === "unknown"
              ? "help"
              : `${family} help`
            : family,
      },
    ];
    if (["source", "document read"].includes(family)) {
      const path = args[family === "source" ? 1 : 2];
      const read = path
        ? resource(path.replace(/^\/?workflows\//, "docket/workflows/"), cwd)
        : undefined;
      if (read)
        matches.push({
          surface: "cli",
          family: read.family,
          resource: read.path,
        });
    }
    return matches;
  }
  if (!["cat", "sed"].includes(exe ?? "")) return [];
  // sed only qualifies with explicit print mode; substitutions and arbitrary scripts do not.
  if (
    exe === "sed" &&
    !(words[1] === "-n" && /^[\d,$ ]+p$/.test(words[2] ?? ""))
  )
    return [];
  return words.slice(exe === "sed" ? 3 : 1).flatMap((path) => {
    const read = resource(path, cwd);
    return read
      ? [
          {
            surface: "shell" as const,
            family: read.family,
            resource: read.path,
          },
        ]
      : [];
  });
}
function resource(path: string, cwd: string) {
  if (/[*?[\]{}]/.test(path)) return undefined;
  const full = resolve(cwd || "/", path);
  if (/\/docket\/workflows\/[^/]+\.md$/.test(full))
    return { family: "workflow_read", path: full };
  if (/\/\.(?:agents|codex)\/skills\/docket-[^/]+\/SKILL\.md$/.test(full))
    return { family: "adapter_read", path: full };
  return undefined;
}

interface Evidence {
  ref: string;
  turn: number;
  item: number;
  surface: Match["surface"];
  family: string;
  resource: string | null;
  outcome: "success" | "error" | "unknown";
  durationMs: number | null;
  contextEpoch: number;
}

/** Read a supplied Codex read_thread JSON export. Raw strings never leave this function. */
export function analyzeDocketTrace(text: string) {
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new Error("trace exceeds 8 MiB limit");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("trace must be a read_thread JSON export");
  }
  const root = row(input);
  if (!Array.isArray(root.turns) || root.schemaVersion !== 1)
    throw new Error(
      "unsupported trace format: expected read_thread schemaVersion 1 with turns",
    );
  const salt = randomBytes(32);
  const opaque = (path: string) =>
    createHash("sha256").update(salt).update(path).digest("hex").slice(0, 24);
  const matches: Evidence[] = [];
  const contributions: ContextContribution[] = [];
  const compactions: { turn: number; item: number }[] = [];
  let items = 0,
    eligible = 0,
    skippedShell = 0,
    unsupportedTools = 0,
    omitted = 0;
  const turns = root.turns.map((v, original) => ({ value: row(v), original }));
  const turnIds = new Set<string>();
  for (const t of turns) {
    if (typeof t.value.id !== "string") continue;
    if (turnIds.has(t.value.id))
      throw new Error(
        "duplicate trace turns; supply nonoverlapping export pages",
      );
    turnIds.add(t.value.id);
  }
  const timestampOrder = turns.every(
    (t) =>
      typeof t.value.startedAt === "number" &&
      Number.isFinite(t.value.startedAt),
  );
  if (timestampOrder)
    turns.sort(
      (a, b) =>
        Number(a.value.startedAt) - Number(b.value.startedAt) ||
        a.original - b.original,
    );
  for (const [t, entry] of turns.entries()) {
    if (!Array.isArray(entry.value.items)) continue;
    let contextEpoch = 0;
    const itemIds = new Set<string>();
    for (const [i, raw] of entry.value.items.entries()) {
      if (++items > MAX_ITEMS) {
        omitted++;
        continue;
      }
      const call = row(raw);
      if (typeof call.id === "string") {
        if (itemIds.has(call.id))
          throw new Error(
            "duplicate trace items; supply nonoverlapping export pages",
          );
        itemIds.add(call.id);
      }
      if (call.type === "contextCompaction") {
        contextEpoch++;
        compactions.push({ turn: entry.original + 1, item: i + 1 });
      }
      let found: Match[] | null = [];
      if (
        call.type === "commandExecution" &&
        typeof call.command === "string"
      ) {
        eligible++;
        const tokens = shell(call.command);
        if (tokens === null) found = null;
        else
          for (const words of tokens) {
            const part = recognize(
              words,
              typeof call.cwd === "string" ? call.cwd : "",
            );
            if (part === null) {
              found = null;
              break;
            }
            found.push(...part);
          }
        if (found === null) {
          skippedShell++;
          continue;
        }
      } else if (call.type === "mcpToolCall") {
        eligible++;
        const tool =
          typeof call.tool === "string"
            ? call.tool
            : typeof call.name === "string"
              ? call.name
              : "";
        const name = tool.replace(/^mcp__docket__/, "");
        // Unqualified tool names need explicit server provenance.
        if (
          (tool.startsWith("mcp__docket__") || call.server === "docket") &&
          mcpNames.has(name)
        ) {
          found = [{ surface: "mcp", family: name }];
          const args = row(call.arguments);
          if (
            ["source_page", "document_read"].includes(name) &&
            typeof args.path === "string"
          ) {
            const read = resource(
              args.path.replace(/^\/?workflows\//, "docket/workflows/"),
              typeof call.cwd === "string"
                ? call.cwd
                : typeof row(root.thread).cwd === "string"
                  ? (row(root.thread).cwd as string)
                  : "",
            );
            if (read)
              found.push({
                surface: "mcp",
                family: read.family,
                resource: read.path,
              });
          }
        } else unsupportedTools++;
      }
      const outcome =
        call.exitCode === 0 ||
        (call.status === "completed" && call.type === "mcpToolCall")
          ? "success"
          : (typeof call.exitCode === "number" && call.exitCode !== 0) ||
              call.status === "failed"
            ? "error"
            : "unknown";
      if (found.length) {
        const observed = readContextObservation(call.docketContext);
        const output =
          typeof call.output === "string"
            ? call.output
            : typeof call.aggregatedOutput === "string"
              ? call.aggregatedOutput
              : null;
        contributions.push({
          ref: `turn:${entry.original + 1}/item:${i + 1}`,
          turn: entry.original + 1,
          item: i + 1,
          epoch: contextEpoch,
          family: found[0]?.family ?? "unknown",
          surface: found[0]?.surface ?? "unknown",
          resource: found.find((m) => m.resource)?.resource
            ? opaque(found.find((m) => m.resource)?.resource as string)
            : null,
          exportTextBytes: output === null ? null : Buffer.byteLength(output),
          outputCoverage: "partial-or-unknown",
          observed,
          invalidObservation:
            call.docketContext !== undefined && observed === undefined,
        });
      }
      for (const m of found) {
        if (matches.length >= MAX_MATCHES) {
          omitted++;
          continue;
        }
        matches.push({
          ref: `turn:${entry.original + 1}/item:${i + 1}/match:${matches.length + 1}`,
          turn: t + 1,
          item: i + 1,
          surface: m.surface,
          family: m.family,
          resource: m.resource ? opaque(m.resource) : null,
          outcome,
          contextEpoch,
          // A compound command's duration belongs to the whole call, never each match.
          durationMs:
            found.length === 1 &&
            typeof call.durationMs === "number" &&
            Number.isFinite(call.durationMs) &&
            call.durationMs >= 0
              ? call.durationMs
              : null,
        });
      }
    }
  }
  const groups = new Map<string, Evidence[]>();
  const contributionByRef = new Map(contributions.map((r) => [r.ref, r]));
  for (const match of matches) {
    const key = match.resource
      ? `${match.turn}/read/${match.resource}`
      : match.family === "lint"
        ? `${match.turn}/validation/lint`
        : `${match.turn}/${match.surface}/${match.family}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(match);
    groups.set(key, bucket);
  }
  const candidates = [...groups.values()]
    .filter((g) => new Set(g.map((m) => m.item)).size > 1)
    .map((g) => ({
      kind: g[0]?.resource
        ? "possible_repeated_read"
        : g.some((e) => e.outcome === "error")
          ? "possible_retry"
          : [
                "task start",
                "task stop",
                "task close",
                "task_start",
                "task_stop",
                "task_close",
              ].includes(g[0]?.family ?? "")
            ? "lifecycle_churn"
            : "repeated_command_family",
      family: g[0]?.family,
      surface: g[0]?.surface,
      surfaces: [...new Set(g.map((e) => e.surface))],
      turn: g[0]?.turn,
      resource: g[0]?.resource,
      n: g.length,
      calls: new Set(g.map((m) => m.item)).size,
      sourceEquality: contextEquality(
        [...new Set(g.map((m) => m.ref.split("/match:")[0]))].flatMap((ref) => {
          const r = ref && contributionByRef.get(ref);
          return r ? [r] : [];
        }),
        g[0]?.family === "lint" ? "lintInputVersion" : "sourceVersion",
      ),
      contextAvailability:
        new Set(g.map((m) => m.contextEpoch)).size > 1
          ? "compaction_observed_between_calls"
          : "unknown",
      evidence: g.slice(0, 20).map((m) => m.ref),
      omittedEvidence: Math.max(0, g.length - 20),
    }))
    .sort((a, b) => b.n - a.n);
  const totals = new Map<string, number>();
  for (const m of matches)
    totals.set(
      `${m.surface}/${m.family}`,
      (totals.get(`${m.surface}/${m.family}`) ?? 0) + 1,
    );
  const lintMatches = matches.filter((m) => m.family === "lint");
  const lintGroups = candidates.filter((c) => c.family === "lint");
  return {
    schema: "docket/trace-review-v1",
    method:
      "supplied read_thread export; recorded turn/item order, separate from telemetry workflow tokens",
    coverage: {
      turns: turns.length,
      turnOrder: timestampOrder
        ? "startedAt; original item order within turns"
        : "export order; chronological turn order unavailable",
      itemsInspected: Math.min(items, MAX_ITEMS),
      eligibleCalls: eligible,
      matchedCalls: new Set(matches.map((m) => `${m.turn}/${m.item}`)).size,
      docketMatches: matches.length,
      skippedShell,
      unsupportedTools,
      omitted,
      hasMore: row(root.page).hasMore === true,
      telemetryCorrelation: "unavailable",
      sourceVersions: contributions.some((r) => r.observed?.sourceVersion)
        ? "caller-supplied-partial-evidence"
        : "unavailable",
      host: "codex",
      otherHosts: "unsupported",
      executionOfShellSegments:
        "unknown; matches are attempted call text, not proof every segment ran",
    },
    lintReview: {
      calls: new Set(lintMatches.map((m) => `${m.turn}/${m.item}`)).size,
      repetitionGroups: lintGroups.slice(0, 30),
      omittedGroups: Math.max(0, lintGroups.length - 30),
      inputEquality: contextEquality(
        [...new Set(lintMatches.map((m) => m.ref.split("/match:")[0]))].flatMap(
          (ref) => {
            const r = ref && contributionByRef.get(ref);
            return r ? [r] : [];
          },
        ),
        "lintInputVersion",
      ),
      mutationCoverage: "unavailable",
    },
    contextVolume: reviewContextVolume(contributions, compactions, {
      hasMore: row(root.page).hasMore === true,
      omitted,
    }),
    candidates: candidates.slice(0, 30),
    omittedCandidates: Math.max(0, candidates.length - 30),
    families: [...totals].map(([family, n]) => ({ family, n })),
    sequence: matches.slice(0, 200),
    omittedSequence: Math.max(0, matches.length - 200),
    limitations: [
      "Investigation candidates, not proven waste, retries or task success.",
      "Same resource identity does not prove unchanged content; different turns are not grouped as redundant.",
      "Lint input equality is unknown unless explicit caller version evidence covers each call; intervening mutation coverage is unavailable. Repeated lint calls may be required after edits or lost evidence; code-only continuations cannot be established from this trace.",
      "Dynamic shell expansions, heredocs and arbitrary scripts are skipped; raw commands and outputs are never returned or stored.",
      "Only supplied pages are inspected. Input exports and any user-saved reports remain user-owned; telemetry deletion does not remove them.",
      "Telemetry date/project filters do not filter the supplied trace. No join with stored events or inference of sessions is performed.",
      "Resource IDs are salted per analysis and cannot link separate reports. No trace is added to telemetry storage or enrollment.",
    ],
  };
}

export function renderDocketTrace(
  report: ReturnType<typeof analyzeDocketTrace>,
) {
  return [
    `Docket trace: ${report.coverage.docketMatches} matches in ${report.coverage.eligibleCalls} eligible calls; ${report.candidates.length} investigation candidates.`,
    `Coverage gaps: ${report.coverage.skippedShell} skipped shell calls, ${report.coverage.unsupportedTools} unsupported tools, ${report.coverage.omitted} omitted items/matches; more pages: ${report.coverage.hasMore}.`,
    `Lint review: ${report.lintReview.calls} calls; ${report.lintReview.repetitionGroups.length} same-turn repetition groups (${report.lintReview.omittedGroups} omitted). Input equality ${report.lintReview.inputEquality}; mutation coverage unavailable.`,
    ...report.lintReview.repetitionGroups.map(
      (c) =>
        `Lint investigation: ${c.calls} calls in turn ${c.turn}; context ${c.contextAvailability}; ${c.evidence.join(", ")}`,
    ),
    ...report.candidates.map(
      (c) =>
        `${c.kind}: ${c.surfaces.join("+")}/${c.family}, ${c.n} matches across ${c.calls} calls in turn ${c.turn}; ${c.evidence.join(", ")}`,
    ),
    `Sequence: first ${report.sequence.length} matches (${report.omittedSequence} omitted); JSON includes ordinal evidence references.`,
    ...report.limitations,
  ].join("\n");
}
