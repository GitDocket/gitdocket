#!/usr/bin/env bun
import { GitEvidenceIndex } from "@gitdocket/core/cache";

// docket — first thin client over @gitdocket/core. Every command is a core
// call plus formatting; agents pass --json, humans get columns.

import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  appendLog,
  applyDocumentMove,
  applyIndex,
  applyReconciliation,
  type Bundle,
  BundleIndex,
  buildContextPacket,
  buildEpicSupervisionRoute,
  type ContextPacket,
  compactContextPacket,
  compactEpicRoute,
  compactWriteReceipt,
  createDecision,
  createDocument,
  createWorkItem,
  DEFAULT_BUNDLE,
  DOCKET_VERSION,
  type DocketConfig,
  docketIntent,
  editDocument,
  editWorkItem,
  errorReceipt,
  findFreshnessWatermark,
  findRepoRoot,
  GitWorktreeIdCoordinator,
  InMemoryFileStore,
  isTerminalStatus,
  type LintOptions,
  LocalFileStore,
  lintBundle,
  lintSummary,
  loadBundle,
  loadMetadataBundle,
  makeLintReport,
  overviewDriftOutcome,
  type Priority,
  parseConfig,
  parseStateOfPlay,
  planDocumentMove,
  planReconciliation,
  READY_QUEUE_DESCRIPTION,
  readDocumentSection,
  readEditableDocument,
  readLintBaseline,
  readProjectGuidance,
  readReconciliationSource,
  readWorkflowFreshness,
  readyWorkItems,
  recoverDocumentMove,
  recoverReconciliation,
  renderIndex,
  STATE_OF_PLAY_PATH,
  searchFresh,
  setStatus,
  sourcePage,
  stopActiveTask,
  TaskEditError,
  taskDriftOutcome,
  taskDriftReceipt,
  taskProgressLabel,
  validateLintSummaryOptions,
  verifyStatus,
  type WorkItem,
  type WorkItemType,
  withActiveTaskLock,
  withTaskProgress,
  writeLintReport,
} from "@gitdocket/core";
import { scanActivity, taskLinkedCommitsSince } from "@gitdocket/core/cache";
import { deriveRepositoryOverview } from "@gitdocket/core/orientation";
import {
  checkoutWorkflowToken,
  cliOperation,
  createWorkflowToken,
  type Dimensions,
  environmentAttribution,
  errorCategory,
  observeOperation,
  recordOperationOutcome,
  resolveAttribution,
  searchOutcome,
  Telemetry,
} from "@gitdocket/core/telemetry";
import { Command, CommanderError } from "commander";
import type { ExtensionDiscoveryReport } from "./extension-discovery";
import { registerExtensions } from "./extensions";
import { trailerlessSince } from "./freshness";
import { refreshIndex } from "./indexing";
import { AGENT_TARGETS, type AgentTarget, runInit } from "./init";
import { renderOverview } from "./overview";
import { pickupConflict } from "./pickup-conflict";
import { registerTelemetry } from "./telemetry";
import { runUpgrade } from "./upgrade";
import { scanRepoMarkers } from "./verify";

interface Ctx {
  root: string;
  store: LocalFileStore;
  idCoordinator: GitWorktreeIdCoordinator;
  config: DocketConfig;
  bundle: () => Promise<Bundle>;
  metadata: (reuse?: boolean) => Promise<Bundle>;
}

let usageDimensions: Partial<Dimensions> = { indexState: "uninitialized" };
let usageRoot: string | null | undefined;
let usageResponseBytes = 0;
const measuredBundle = async (load: () => Promise<Bundle>) => {
  const bundle = await load();
  usageDimensions = {
    indexState: "metadata",
    concepts: bundle.concepts.length,
  };
  return bundle;
};

async function ctx(): Promise<Ctx> {
  const root = usageRoot ?? (await findRepoRoot(process.cwd()));
  if (!root) {
    throw new Error("no docket.yaml found here or in any parent directory");
  }
  const config = parseConfig(await readFile(join(root, "docket.yaml"), "utf8"));
  const store = new LocalFileStore(join(root, config.bundle));
  return {
    root,
    store,
    idCoordinator: new GitWorktreeIdCoordinator(root),
    config,
    bundle: () => measuredBundle(() => loadBundle(store, config)),
    metadata: (reuse = false) =>
      measuredBundle(() => loadMetadataBundle(store, config, { cache: reuse })),
  };
}

const print = async (value: string): Promise<void> => {
  const bytes = Buffer.from(`${value}\n`, "utf8");
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(bytes.subarray(offset, offset + 65536), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  usageResponseBytes += bytes.length;
  recordOperationOutcome({ responseBytes: usageResponseBytes });
};

const integer = (value: string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(`expected a nonnegative integer, got "${value}"`);
  return n;
};

const row = (w: WorkItem): string =>
  [
    w.fm.id.padEnd(8),
    w.fm.status.padEnd(12),
    (w.fm.priority ?? "p2").padEnd(4),
    w.fm.title ?? "",
  ].join(" ");

const summarize = (w: WorkItem) => ({
  id: w.fm.id,
  type: w.fm.type,
  title: w.fm.title,
  status: w.fm.status,
  priority: w.fm.priority,
  rank: w.fm.rank,
  epic: w.fm.epic,
  depends_on: w.fm.depends_on,
  path: w.path,
});

const fail = (error: unknown): never => {
  throw error;
};

async function closureCommit(
  root: string,
  store: LocalFileStore,
  config: DocketConfig,
  id: string,
  revision: string,
) {
  if (!/^[a-f0-9]{7,64}$/.test(revision))
    throw new Error("Expected a closure commit hash.");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const commit = git("rev-parse", "--verify", `${revision}^{commit}`).trim();
  git("merge-base", "--is-ancestor", commit, "HEAD");
  const bundle = await loadMetadataBundle(store, config);
  const item = bundle.byId(id);
  if (
    item?.kind !== "work" ||
    item.fm.type !== "Task" ||
    !isTerminalStatus(item.fm.status)
  )
    throw new Error("Task is not terminal.");
  const trailer = `${config.git.trailer}: ${id}`;
  const trailers = git("show", "-s", "--format=%(trailers:only,unfold)", commit)
    .trim()
    .split(/\r?\n/);
  if (!trailers.includes(trailer))
    throw new Error("Closure task trailer missing.");
  const path = join(config.bundle, item.path).replaceAll("\\", "/");
  if (git("show", `${commit}:${path}`) !== (await store.read(item.path)))
    throw new Error("Task source differs from the closure commit.");
}

async function closureFeedback(root: string, id: string) {
  const base = {
    narrative: "must precede close",
    activeTaskRetained: null as boolean | null,
    cleanup: { state: "unavailable" } as object,
  };
  try {
    return await withActiveTaskLock(root, async ({ state }) => ({
      ...base,
      activeTaskRetained: state.id === id,
      cleanup:
        state.id === id
          ? {
              state: "matching-active-task",
              after: "closure commit",
              surface: "cli",
              args: [
                "task",
                "stop",
                id,
                ...(state.token ? ["--workflow-token", state.token] : []),
                "--after-commit",
                "<closure-commit-sha>",
                "--json",
              ],
            }
          : {
              state: state.id ? "different-active-task" : "no-active-marker",
              action: "leave unrelated lifecycle state untouched",
            },
    }));
  } catch {
    return base;
  }
}

// One screenful: header lines for the structure, then the body verbatim.
async function printPacket(packet: ContextPacket): Promise<void> {
  const { task, epic, deps, linked, commits } = packet;
  await print(`\n${task.fm.id} — ${task.fm.title ?? ""}`);
  await print(`${task.fm.status} · ${task.fm.priority ?? "p2"} · ${task.path}`);
  if (epic)
    await print(
      `epic: ${epic.id ?? epic.path} — ${epic.title ?? ""} (${epic.status ?? "?"})`,
    );
  if (deps.length > 0)
    await print(
      `deps: ${deps.map((d) => `${d.id} ${d.status ?? "missing!"}`).join(" · ")}`,
    );
  for (const warning of packet.drift?.warnings ?? [])
    await print(`warning (${warning.code}): ${warning.message}`);
  if (
    packet.instructions &&
    packet.instructions.status !== "current" &&
    packet.instructions.status !== "absent"
  )
    await print(
      `instructions ${packet.instructions.status}: ${packet.instructions.reason}`,
    );
  await print(`\n${task.body}`);
  if (linked.length > 0) {
    await print("\nlinked:");
    for (const l of linked)
      await print(
        `  /${l.path} — ${[l.title, l.description].filter(Boolean).join(" — ")}`,
      );
  }
  if (commits.length > 0) {
    await print("\ncommits:");
    for (const c of commits.slice(0, 10))
      await print(`  ${c.sha.slice(0, 7)} ${c.date.slice(0, 10)} ${c.subject}`);
    if (commits.length > 10) await print(`  … ${commits.length - 10} more`);
  }
  await print(
    `\nproject guidance: ${packet.guidance.status} — ${packet.guidance.path}`,
  );
  if (packet.guidance.source) await print(packet.guidance.source.text);
  for (const diagnostic of packet.guidance.diagnostics)
    await print(`${diagnostic.severity}: ${diagnostic.message}`);
  if (packet.guidance.source?.nextCursor)
    await print(
      `Continue with docket source ${packet.guidance.path} --cursor '${JSON.stringify(packet.guidance.source.nextCursor)}' --json`,
    );
}

async function readTaskProgress(b: Bundle, root: string, config: DocketConfig) {
  const owner = new GitEvidenceIndex(root, config.git.trailer, {
    bundlePath: config.bundle,
  });
  try {
    return (await owner.snapshot(b.byId)).git.taskProgress;
  } finally {
    owner.close();
  }
}

const program = new Command();
program.exitOverride();
program.configureOutput({
  writeErr: (value) => {
    if (!process.argv.includes("--json") && !process.argv.includes("--compact"))
      process.stderr.write(value);
  },
});
registerTelemetry(program, print);
registerExtensions(program, async () => (await ctx()).store.root, print);

program
  .name("docket")
  .description(
    "LLM-first docs + tasks: one OKF bundle, agents operate it, humans review it",
  )
  .version(DOCKET_VERSION);

program
  .command("ready")
  .description(READY_QUEUE_DESCRIPTION)
  .option("--json", "machine-readable output")
  .option("--limit <n>", "return the first n ready tasks", integer)
  .action(async (opts: { json?: boolean; limit?: number }) => {
    const { metadata, root, config } = await ctx();
    const b = await metadata();
    const progress = await readTaskProgress(b, root, config);
    const ready = readyWorkItems(b).slice(0, opts.limit);
    if (opts.json)
      await print(
        JSON.stringify(
          ready.map((w) => withTaskProgress(summarize(w), progress)),
          null,
          2,
        ),
      );
    else if (ready.length === 0)
      await print("nothing ready — check `docket task list --status blocked`");
    else
      for (const w of ready) {
        const p = progress?.tasks.find((p) => p.id === w.fm.id);
        await print(row(w) + (p ? ` — ${taskProgressLabel(p)}` : ""));
      }
    if (!opts.json && progress && !progress.complete)
      await print(
        "Worktree progress is partial; run docket task progress for details.",
      );
  });

program
  .command("overview")
  .description(docketIntent("orientation").discovery)
  .option("--json", "machine-readable output")
  .option("--full", "return the compatibility evidence model (requires --json)")
  .action(async (opts: { json?: boolean; full?: boolean }) => {
    if (opts.full && !opts.json) throw new Error("--full requires --json");
    const { root, store, config, metadata } = await ctx();
    const b = await metadata();
    if (opts.json && !opts.full) {
      const brief = await deriveRepositoryOverview({
        root,
        store,
        config,
        bundle: b,
        view: "brief",
      });
      recordOperationOutcome(overviewDriftOutcome(brief.coordination));
      await print(JSON.stringify(brief, null, 2));
      return;
    }
    const result = await deriveRepositoryOverview({
      root,
      store,
      config,
      bundle: b,
    });
    recordOperationOutcome(overviewDriftOutcome(result.coordination));
    const { narrative, git, ...model } = result;
    await print(
      opts.json
        ? JSON.stringify(result, null, 2)
        : renderOverview(model, narrative, git),
    );
  });

program
  .command("search")
  .description(
    "ranked text search across the bundle — tokenized terms, title/id boosted, best-first",
  )
  .argument("<query...>", "search terms (quoting optional)")
  .option("--limit <n>", "max hits after ranking", "20")
  .option("--json", "machine-readable output")
  .action(async (parts: string[], opts: { limit: string; json?: boolean }) => {
    const { store, config } = await ctx();
    const hits = await searchFresh(store, config, parts.join(" "), {
      limit: Number(opts.limit) || 20,
    });
    recordOperationOutcome(
      searchOutcome(hits.length, null, Number(opts.limit) || 20),
    );
    if (opts.json) await print(JSON.stringify(hits, null, 2));
    else if (hits.length === 0) await print("no hits");
    else
      for (const h of hits)
        await print(
          `${`${h.path}:${h.line}`.padEnd(52)} ${(h.id ?? "").padEnd(8)} ${h.text}`,
        );
  });

program
  .command("lint")
  .description(
    "complete global validation with optional bounded summary and saved evidence",
  )
  .option(
    "--json",
    "machine-readable output; default retains the complete diagnostic array",
  )
  .option(
    "--strict",
    "exit nonzero on any global warning, including hidden warnings",
  )
  .option("--summary", "bounded counts and prioritized source references")
  .option(
    "--changed-path <path>",
    "present warnings on this exact bundle/repo diagnostic path; all errors remain selected",
    (value: string, values: string[]) => [...values, value],
    [],
  )
  .option(
    "--baseline <file>",
    "compare a complete saved lint report; unavailable evidence remains explicit",
  )
  .option(
    "--report <file>",
    "atomically save complete versioned evidence to an owned file",
  )
  .option("--offset <n>", "summary continuation offset", integer, 0)
  .option("--limit <n>", "summary detail bound (1–32)", integer, 8)
  .action(
    async (opts: {
      json?: boolean;
      strict?: boolean;
      summary?: boolean;
      changedPath: string[];
      baseline?: string;
      report?: string;
      offset: number;
      limit: number;
    }) => {
      validateLintSummaryOptions({
        paths: opts.changedPath,
        offset: opts.offset,
        limit: opts.limit,
      });
      const { root, store, config } = await ctx();
      const now = new Date();
      const snapshot = await new BundleIndex(store).refresh(config);
      const lintStore = new InMemoryFileStore(new Map(snapshot.sources));
      const b = snapshot.bundle;
      usageDimensions = { indexState: "metadata", concepts: b.concepts.length };
      const logSource = snapshot.sources.get("log.md");
      const watermark = logSource && findFreshnessWatermark(logSource);
      const stateOfPlaySource = snapshot.sources.get(STATE_OF_PLAY_PATH);
      const stateOfPlay = stateOfPlaySource
        ? parseStateOfPlay(stateOfPlaySource).note
        : undefined;
      const inputs: LintOptions = {
        now,
        trailerlessCommits: watermark
          ? trailerlessSince(root, watermark.sha, config.git.trailer)
          : undefined,
        stateOfPlayCommitsAgo: stateOfPlay
          ? taskLinkedCommitsSince(root, config.git.trailer, stateOfPlay.asOf)
          : undefined,
        verifyMarkers: await scanRepoMarkers(root, config, b),
      };
      const diags = await lintBundle(lintStore, b, inputs);
      const errors = diags.filter((d) => d.severity === "error").length;
      const summaryRequested =
        opts.summary ||
        opts.changedPath.length > 0 ||
        opts.baseline !== undefined ||
        opts.offset > 0;
      if (summaryRequested || opts.report !== undefined) {
        const report = makeLintReport(
          diags,
          snapshot.sources,
          config,
          inputs,
          await realpath(root),
          now,
        );
        const baseline =
          opts.baseline !== undefined
            ? await readLintBaseline(opts.baseline)
            : undefined;
        const artifact =
          opts.report !== undefined
            ? await writeLintReport(opts.report, report)
            : undefined;
        if (summaryRequested) {
          const result = lintSummary(report, baseline, {
            paths: opts.changedPath,
            offset: opts.offset,
            limit: opts.limit,
            artifact,
          });
          if (opts.json) await print(JSON.stringify(result, null, 2));
          else {
            await print(
              `${result.global.error} errors, ${result.global.warning} warnings globally; ${result.selection.shown}/${result.selection.total} selected findings shown (${result.selection.omitted} omitted). Baseline: ${result.baseline.status}.`,
            );
            await print(
              `Delta: ${result.delta.introduced ?? "unknown"} introduced, ${result.delta.preExisting ?? "unknown"} pre-existing, ${result.delta.resolved ?? "unknown"} resolved. Complete details: docket lint --json${artifact ? `; saved report: ${artifact.path}` : ""}`,
            );
            for (const d of result.diagnostics)
              await print(
                `${d.severity} [${d.code}; ${d.state}] ${d.path}${d.line ? `:${d.line}` : ""} — ${d.message}`,
              );
          }
        } else if (opts.json) await print(JSON.stringify(diags, null, 2));
        else
          for (const d of diags)
            await print(`${d.severity} [${d.code}] ${d.path} — ${d.message}`);
      } else if (opts.json) await print(JSON.stringify(diags, null, 2));
      else if (!diags.length) await print("clean");
      else
        for (const d of diags)
          await print(`${d.severity} [${d.code}] ${d.path} — ${d.message}`);
      if (errors > 0 || (opts.strict && diags.length > 0)) process.exitCode = 1;
    },
  );

program
  .command("index")
  .description(
    "refresh index.md and the derived cache; reuse only matching fresh inputs and cache bytes",
  )
  .option("--check", "fail if index.md is stale, write nothing (CI)")
  .option("--json", "machine-readable index and cache outcome")
  .option("--rebuild", "force a complete derived-cache rebuild")
  .action(
    async (opts: { check?: boolean; json?: boolean; rebuild?: boolean }) => {
      const { root, store, config, bundle } = await ctx();

      if (opts.check) {
        if (opts.rebuild)
          throw new TaskEditError(
            "invalid-request",
            "--check cannot be combined with --rebuild.",
          );
        const b = await bundle();
        const current = await store.read("index.md").catch(() => "");
        const next = applyIndex(current, renderIndex(b));
        if (opts.json) {
          await print(
            JSON.stringify(
              {
                schema: "docket-receipt/v1",
                operation: "index",
                ok: next === current,
                changed: false,
                mutation: "unchanged",
                paths: [],
                indexChanged: false,
                cache: "not-requested",
                stale: next !== current,
              },
              null,
              2,
            ),
          );
          if (next !== current) process.exitCode = 1;
          return;
        }
        if (next !== current) {
          console.error("index.md is stale — run `docket index`");
          process.exitCode = 1;
          return;
        }
        await print("index.md up to date");
        return;
      }

      const result = await refreshIndex(root, store, config, {
        rebuild: opts.rebuild,
      });
      if (opts.json) {
        await print(
          JSON.stringify(
            compactWriteReceipt("index", {
              ...result,
            }),
            null,
            2,
          ),
        );
        return;
      }
      const verifyNote = config.verify
        ? `; ${result.verifyMarkerCount} verify marker(s)`
        : "";
      await print(
        `${result.indexChanged ? "index.md regenerated" : "index.md unchanged"}; cache ${result.cache}${verifyNote}`,
      );
    },
  );

const verify = program
  .command("verify")
  .description(
    "verification linkage — derived from docket:verifies markers; Docket never runs tests",
  );

verify
  .command("status")
  .description(
    "presence per spec: which files claim to verify each spec, and which specs nothing verifies",
  )
  .option("--json", "machine-readable output")
  .action(async (opts: { json?: boolean }) => {
    const { root, config, bundle } = await ctx();
    if (!config.verify) {
      await print(
        "verify is not configured — add a `verify:` section with a `tests:` glob list to docket.yaml",
      );
      return;
    }
    const b = await bundle();
    const rows = verifyStatus(b, await scanRepoMarkers(root, config, b));
    if (opts.json) {
      await print(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      await print("no specs and no markers found");
      return;
    }
    for (const r of rows) {
      await print(`/${r.spec} — ${r.title ?? r.type}`);
      if (r.unverified) {
        await print("  ⚠ nothing verifies this");
        continue;
      }
      // Presence marks only: distinct source files, anchors noted.
      const byFile = new Map<string, string[]>();
      for (const s of r.sources) {
        const anchors = byFile.get(s.source) ?? [];
        if (s.anchor) anchors.push(s.anchor);
        byFile.set(s.source, anchors);
      }
      for (const [source, anchors] of byFile) {
        const note =
          anchors.length > 0
            ? ` (${anchors.map((a) => `#${a}`).join(", ")})`
            : "";
        await print(`  ✓ ${source}${note}`);
      }
    }
  });

program
  .command("init")
  .description(
    "adopt Docket in place: config, bundle scaffold, trailer hook — additive, idempotent",
  )
  .option("--project <key>", "ID key for work items (default: from dir name)")
  .option("--bundle <dir>", "bundle directory", DEFAULT_BUNDLE)
  .option("--claude", "install the Claude Code adapter (compatibility alias)")
  .option("--codex", "install the Codex adapter (alias for --agent codex)")
  .option(
    "--agent <target>",
    "install an agent adapter; repeat for multiple targets (claude, codex, cursor)",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .option("--json", "machine-readable output")
  .action(
    async (opts: {
      project?: string;
      bundle?: string;
      claude?: boolean;
      codex?: boolean;
      agent?: string[];
      json?: boolean;
    }) => {
      try {
        const requested = [
          ...(opts.agent ?? []).flatMap((value) => value.split(",")),
          ...(opts.claude ? ["claude"] : []),
          ...(opts.codex ? ["codex"] : []),
        ].map((value) => value.trim().toLowerCase());
        const unknown = requested.filter(
          (value) => !AGENT_TARGETS.includes(value as AgentTarget),
        );
        if (unknown.length > 0)
          throw new Error(
            `unknown agent target: ${unknown.join(", ")} (supported: ${AGENT_TARGETS.join(", ")})`,
          );
        const agents = [...new Set(requested as AgentTarget[])];
        // Preserve the original interactive offer: accepting it opts into the
        // Claude adapter. Other targets are explicit and composable via flags.
        const interactive =
          !opts.json && process.stdin.isTTY && process.stdout.isTTY;
        if (
          agents.length === 0 &&
          interactive &&
          confirm(
            "Install the Claude Code adapter? Writes skills, MCP registration, and allow rules.",
          )
        ) {
          agents.push("claude");
        }
        const report = await runInit(process.cwd(), {
          project: opts.project,
          bundle: opts.bundle,
          agents,
        });
        await reportExtensionDiscovery(report.extensionDiscovery, opts.json);
        if (opts.json) {
          await print(JSON.stringify(report, null, 2));
          return;
        }
        for (const s of report.steps) {
          const notes = [
            ...(s.reason ? [s.reason] : []),
            ...(s.gitignored ? ["gitignored — local only"] : []),
          ];
          const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";
          await print(`${s.action.padEnd(7)} ${s.path}${note}`);
        }
        if (
          report.steps.some(
            (s) =>
              (s.step === "claude" ||
                s.step === "codex" ||
                s.step === "cursor" ||
                s.step === "skills") &&
              s.gitignored,
          )
        ) {
          await print(
            "\nwarning: this repo gitignores native agent adapter files, so they won't travel on clone. The tracked fallback still does: bundle workflows + AGENTS.md. Narrow the relevant ignore rules to share native adapters.",
          );
        }
        if (report.adopt.length > 0) {
          await print(
            `\n${report.adopt.length} existing file(s) lack \`type\` frontmatter — proposed types (agent: review and apply, never move files):`,
          );
          for (const a of report.adopt)
            await print(`  ${a.path} → type: ${a.proposedType}`);
        }
        if (agents.length === 0) {
          await print(
            "\nnative agent adapters skipped — rerun with --agent claude, --agent codex, --agent cursor, or a combination",
          );
        }
        await print(
          report.adopt.length > 0
            ? "\nnext: review and apply the adoption worklist above, then commit the new files"
            : "\nnext: commit the new files",
        );
      } catch (error) {
        fail(error);
      }
    },
  );

program
  .command("upgrade")
  .description(
    "upgrade vendored docket content: regenerate marked adapters, 3-way merge workflows against their origin",
  )
  .option("--dry-run", "report without writing")
  .option(
    "--file-task",
    "on conflict, file a reconcile task in this repo's tracker",
  )
  .option("--json", "machine-readable output")
  .action(
    async (opts: { dryRun?: boolean; fileTask?: boolean; json?: boolean }) => {
      try {
        const report = await runUpgrade(process.cwd(), {
          dryRun: opts.dryRun,
          fileTask: opts.fileTask,
        });
        await reportExtensionDiscovery(report.extensionDiscovery, opts.json);
        if (opts.json) {
          await print(JSON.stringify(report, null, 2));
        } else {
          if (report.items.length === 0) {
            await print("nothing vendored here to upgrade");
          }
          for (const item of report.items) {
            const note = item.reviewRequired
              ? item.reason
              : item.action === "skipped"
                ? item.reason
                : item.action === "up-to-date"
                  ? (item.reason ?? report.available)
                  : `${item.from ?? "unversioned"} → ${report.available}`;
            await print(
              `${(item.reviewRequired ? "review" : item.action).padEnd(12)} ${item.path}${note ? ` (${note})` : ""}`,
            );
          }
          if (report.conflicts.length > 0) {
            await print(
              `\n${report.conflicts.length} conflict(s) — resolve the markers, keeping local customizations where they still apply${report.filedTask ? ` (filed ${report.filedTask.id})` : ""}`,
            );
          }
          if (report.reviewRequired.length > 0) {
            await print(
              `\n${report.reviewRequired.length} item(s) require review — retained differences may be stale or customized instructions. Compare with the current shipped workflow; a current origin stamp does not certify its contents.`,
            );
          }
          if (report.dryRun) await print("\ndry run — nothing written");
        }
        if (report.conflicts.length > 0) process.exitCode = 1;
      } catch (error) {
        fail(error);
      }
    },
  );

async function reportExtensionDiscovery(
  report: ExtensionDiscoveryReport | undefined,
  json: boolean | undefined,
) {
  if (!report) return;
  if (!report.ok) process.exitCode = 1;
  if (!json)
    for (const diagnostic of report.diagnostics) {
      await print(
        `extension ${diagnostic.severity} [${diagnostic.code}]: ${diagnostic.message} ${diagnostic.remediation}`,
      );
    }
}

program
  .command("serve")
  .description(
    "local renderer — wiki, board, epic rollups over the live working tree",
  )
  .option("--port <n>", "port to listen on", "4180")
  .option("--watch", "dev mode: rebuild client assets on change, reload tabs")
  .option(
    "--commit",
    "commit each UI write to git, scoped to the files it touched",
  )
  .action(async (opts: { port: string; watch?: boolean; commit?: boolean }) => {
    const { root, config } = await ctx();
    // Lazy: keeps react/hono out of every other command's startup.
    const { startServe } = await import("@gitdocket/web");
    try {
      const server = await startServe(root, config, {
        port: Number(opts.port),
        watch: opts.watch,
        commit: opts.commit,
      });
      const modes = [opts.watch && "watch", opts.commit && "commit"]
        .filter(Boolean)
        .join(", ");
      await print(`docket serve → ${server.url}${modes ? ` (${modes})` : ""}`);
    } catch (error) {
      fail(error);
    }
  });

const task = program.command("task").description("work item operations");

const reconcile = program
  .command("reconcile")
  .description(
    "Review and reconcile selected Docket records from local Git evidence",
  );
reconcile
  .command("plan")
  .requiredOption(
    "--input <file>",
    "JSON selection: sourceRef, optional sourceRoot/saved/baseRef, and paths",
  )
  .option("--offset <n>", "Plan page offset", "0")
  .option("--json", "Bounded source-bound review plan")
  .action(async (opts: { input: string; offset: string }) => {
    const { store, config, root } = await ctx();
    const result = await planReconciliation(
      store,
      config,
      root,
      JSON.parse(await readFile(opts.input, "utf8")),
      Number(opts.offset),
    );
    recordOperationOutcome({
      resultCount: result.items.length,
      resultTotal: result.total,
      truncated: result.omitted ? "results" : "none",
    });
    await print(JSON.stringify(result, null, 2));
  });
reconcile
  .command("source <path> <side>")
  .requiredOption("--input <file>", "The reviewed JSON selection")
  .requiredOption("--version <sha>", "Expected plan version")
  .option("--offset <n>", "Exact source page offset", "0")
  .option("--json", "Bounded exact source page")
  .action(
    async (
      path: string,
      side: string,
      opts: { input: string; version: string; offset: string },
    ) => {
      if (!["base", "local", "incoming", "proposed"].includes(side))
        throw new Error("invalid source side");
      const { store, config, root } = await ctx();
      const result = await readReconciliationSource(
        store,
        config,
        root,
        JSON.parse(await readFile(opts.input, "utf8")),
        opts.version,
        path,
        side as "base" | "local" | "incoming" | "proposed",
        Number(opts.offset),
      );
      await print(JSON.stringify(result, null, 2));
    },
  );
reconcile
  .command("apply")
  .requiredOption(
    "--input <file>",
    "JSON selection, expectedVersion and one reviewed choice per path",
  )
  .option("--json", "Compact application/recovery receipt")
  .action(async (opts: { input: string }) => {
    const { store, config, root } = await ctx();
    const result = await applyReconciliation(
      store,
      config,
      root,
      JSON.parse(await readFile(opts.input, "utf8")),
    );
    recordOperationOutcome({
      resultCount: result.writes,
      resultTotal: result.changedPaths,
      saveState: result.state === "noop" ? "unchanged" : "saved_locally",
      ...("error" in result && result.error?.code === "source-conflict"
        ? { failureReason: "source_changed" as const }
        : {}),
    });
    await print(JSON.stringify(result, null, 2));
    if (result.state === "recovery_required") process.exitCode = 1;
  });
reconcile
  .command("recover <token>")
  .option("--json", "Compact recovery/no-op receipt")
  .action(async (token: string) => {
    const { store, config, root } = await ctx();
    const result = await recoverReconciliation(store, config, root, token);
    recordOperationOutcome({
      resultCount: result.writes,
      resultTotal: result.changedPaths,
      saveState: result.state === "noop" ? "unchanged" : "saved_locally",
      ...("error" in result && result.error?.code === "source-conflict"
        ? { failureReason: "source_changed" as const }
        : {}),
    });
    await print(JSON.stringify(result, null, 2));
    if (result.state === "recovery_required") process.exitCode = 1;
  });

program
  .command("guidance")
  .description(
    "read optional project guidance and source links without tracker coordination",
  )
  .option(
    "--json",
    "exact source page, availability, diagnostics and continuation cursor",
  )
  .action(async (opts: { json?: boolean }) => {
    const { store, config } = await ctx();
    const guidance = await readProjectGuidance(store, config);
    if (opts.json) await print(JSON.stringify(guidance, null, 2));
    else {
      await print(`Project guidance: ${guidance.status} — ${guidance.path}`);
      if (guidance.source) await print(guidance.source.text);
      for (const diagnostic of guidance.diagnostics)
        await print(`${diagnostic.severity}: ${diagnostic.message}`);
      if (guidance.source?.nextCursor)
        await print(
          `Continue with docket source ${guidance.path} --cursor '${JSON.stringify(guidance.source.nextCursor)}' --json`,
        );
    }
  });

const document = program
  .command("document")
  .description("Create and revise ordinary wiki sources without tracking work");
document
  .command("move-plan <from> <to>")
  .description(
    "Inspect an ordinary wiki path move and supported link repairs without writing",
  )
  .option(
    "--json",
    "machine-readable plan with version, affected paths and blockers",
  )
  .action(async (from: string, to: string) => {
    const { store, config } = await ctx();
    await print(
      JSON.stringify(await planDocumentMove(store, config, from, to), null, 2),
    );
  });
document
  .command("move-apply")
  .description(
    "Apply a reviewed move with from/to/expectedVersion from a JSON request file",
  )
  .requiredOption(
    "--input <file>",
    "JSON containing only from, to and expectedVersion from move-plan",
  )
  .option("--json", "machine-readable completion or recovery receipt")
  .action(async (opts: { input: string }) => {
    const { store, config } = await ctx();
    const result = await applyDocumentMove(
      store,
      config,
      JSON.parse(await readFile(opts.input, "utf8")),
    );
    await print(JSON.stringify(result, null, 2));
    if (result.state !== "complete") process.exitCode = 1;
  });
document
  .command("move-recover <token>")
  .description(
    "Resume a journaled move after validating every original or planned source",
  )
  .option("--json", "machine-readable completion or recovery receipt")
  .action(async (token: string) => {
    const { store, config } = await ctx();
    const result = await recoverDocumentMove(store, config, token);
    await print(JSON.stringify(result, null, 2));
    if (result.state !== "complete") process.exitCode = 1;
  });
document
  .command("create")
  .description(
    "Create a Reference, Spec or Playbook exclusively from a JSON request file",
  )
  .requiredOption(
    "--input <file>",
    "JSON containing path, type, title, body and optional description/tags",
  )
  .option("--json", "machine-readable result")
  .option(
    "--compact",
    "versioned write receipt without the authored body; document read returns complete content",
  )
  .action(
    async (opts: { input: string; json?: boolean; compact?: boolean }) => {
      const { store, config } = await ctx();
      const result = await createDocument(
        store,
        config,
        JSON.parse(await readFile(opts.input, "utf8")),
      );
      await print(
        opts.json || opts.compact
          ? JSON.stringify(
              opts.compact
                ? compactWriteReceipt("document_create", result)
                : result,
              null,
              2,
            )
          : `Created ${result.document.path}. Run docket index to refresh discovery.`,
      );
    },
  );
document
  .command("read <path>")
  .description(
    "Read a complete editable body or one section with the whole-source version",
  )
  .option(
    "--section <heading>",
    "read one level-one section, not a complete body draft",
  )
  .option("--json", "machine-readable result")
  .action(async (path: string, opts: { section?: string }) => {
    const { store, config } = await ctx();
    await print(
      JSON.stringify(
        opts.section !== undefined
          ? await readDocumentSection(store, config, path, opts.section)
          : await readEditableDocument(store, config, path),
        null,
        2,
      ),
    );
  });
document
  .command("edit <path>")
  .description(
    "Save an expectedVersion and body/section/title/description patch from a JSON file",
  )
  .requiredOption("--input <file>", "JSON containing expectedVersion and patch")
  .option("--json", "machine-readable result")
  .option(
    "--compact",
    "versioned write receipt without the authored body; document read returns complete content",
  )
  .action(async (path: string, opts: { input: string; compact?: boolean }) => {
    const { root, store, config, metadata } = await ctx();
    const b = await metadata(true);
    const item = b.workItems.find(
      (item) => item.path === path && item.fm.type === "Task",
    );
    const advisory = item
      ? {
          drift: taskDriftReceipt(
            item.fm.id,
            await readTaskProgress(b, root, config),
          ),
          instructions: await readWorkflowFreshness(store),
        }
      : {};
    if (advisory.drift)
      recordOperationOutcome(taskDriftOutcome(advisory.drift));
    const result = {
      ...(await editDocument(
        store,
        config,
        path,
        JSON.parse(await readFile(opts.input, "utf8")),
      )),
      ...advisory,
    };
    await print(
      JSON.stringify(
        opts.compact ? compactWriteReceipt("document_edit", result) : result,
        null,
        2,
      ),
    );
  });

program
  .command("source <path>")
  .description(
    "read an exact bounded Markdown page, including log.md, with source provenance",
  )
  .option(
    "--cursor <json>",
    "continuation cursor returned by the preceding page",
  )
  .option(
    "--max-chars <n>",
    "page size in UTF-16 units (maximum 32768)",
    integer,
  )
  .option("--json", "machine-readable page and continuation cursor")
  .action(
    async (
      path: string,
      opts: { cursor?: string; maxChars?: number; json?: boolean },
    ) => {
      const { store } = await ctx();
      // Resolve only an exact inventory member; never pass arbitrary paths to read.
      if (!(await store.list()).includes(path))
        throw new Error(`not found: ${path}`);
      const page = sourcePage(new Map([[path, await store.read(path)]]), path, {
        cursor: opts.cursor === undefined ? undefined : JSON.parse(opts.cursor),
        maxChars: opts.maxChars,
      });
      if (!page) throw new Error(`not found: ${path}`);
      recordOperationOutcome({
        responseBytes: Buffer.byteLength(page.text),
        truncated: page.nextCursor ? "response" : "none",
      });
      await print(
        opts.json
          ? JSON.stringify(page, null, 2)
          : `${path}:${page.startLine}-${page.endLine} (${page.sourceHash})\n${page.text}`,
      );
    },
  );

task
  .command("list")
  .description(
    "list open work items (done and closed hidden by default — see --all)",
  )
  .option("--status <status>", "filter by status")
  .option("--epic <id>", "filter by epic id")
  .option("--type <type>", "Task or Epic")
  .option("--all", "include done and closed items")
  .option(
    "--limit <n>",
    "return at most n matching items (omit for full export)",
    integer,
  )
  .option("--offset <n>", "skip n matching items", integer, 0)
  .option("--json", "machine-readable output")
  .action(
    async (opts: {
      status?: string;
      epic?: string;
      type?: string;
      all?: boolean;
      json?: boolean;
      limit?: number;
      offset: number;
    }) => {
      const { metadata, root, config } = await ctx();
      const b = await metadata();
      const progress = await readTaskProgress(b, root, config);
      let items = b.workItems;
      // History hides by default — it lives in git and the wiki.
      if (opts.status) items = items.filter((w) => w.fm.status === opts.status);
      else if (!opts.all)
        items = items.filter((w) => !isTerminalStatus(w.fm.status));
      if (opts.type) items = items.filter((w) => w.fm.type === opts.type);
      if (opts.epic) {
        const epic = b.byId(opts.epic);
        items = items.filter(
          (w) => epic && w.fm.epic?.includes(`/${epic.fm.id}-`),
        );
      }
      // Terminal history newest-first, open items in bundle order.
      const ts = (w: WorkItem): string =>
        typeof w.fm.timestamp === "string" ? w.fm.timestamp : "";
      items = [
        ...items.filter((w) => !isTerminalStatus(w.fm.status)),
        ...items
          .filter((w) => isTerminalStatus(w.fm.status))
          .sort((a, z) => ts(z).localeCompare(ts(a))),
      ];
      items = items.slice(
        opts.offset,
        opts.limit === undefined ? undefined : opts.offset + opts.limit,
      );
      if (opts.json)
        await print(
          JSON.stringify(
            items.map((w) => withTaskProgress(summarize(w), progress)),
            null,
            2,
          ),
        );
      else {
        for (const w of items) {
          const p = progress?.tasks.find((p) => p.id === w.fm.id);
          await print(row(w) + (p ? ` — ${taskProgressLabel(p)}` : ""));
        }
        if (progress?.tasks.some((p) => p.localStatus === null))
          await print("Tasks found only elsewhere: use docket task progress.");
        if (progress && !progress.complete)
          await print(
            "Worktree progress is partial; use docket task progress for details.",
          );
      }
    },
  );

task
  .command("progress [id]")
  .description(
    "Read task progress across local worktrees and refs; never changes recorded status",
  )
  .option("--json", "machine-readable output")
  .action(async (id: string | undefined, opts: { json?: boolean }) => {
    const { metadata, root, config } = await ctx();
    const b = await metadata();
    const evidence = await readTaskProgress(b, root, config);
    const tasks = (evidence?.tasks ?? []).filter((p) => !id || p.id === id);
    if (opts.json)
      await print(
        JSON.stringify(
          {
            ...evidence,
            tasks,
            observations: tasks.flatMap((p) => p.observations),
            ...(!evidence
              ? {
                  complete: false,
                  diagnostics: ["Git task progress unavailable"],
                }
              : {}),
          },
          null,
          2,
        ),
      );
    else {
      for (const p of tasks)
        await print(
          `${p.id} ${p.title} — ${taskProgressLabel(p)}${p.localStatus === null ? " · only in another checkout/ref" : ""}`,
        );
      if (!tasks.length)
        await print("No task progress observed in admitted sources.");
      for (const d of evidence?.diagnostics ?? [
        "Git task progress unavailable",
      ])
        await print(d);
      if (evidence) await print(`Observed ${evidence.observedAt}`);
    }
  });

task
  .command("create")
  .description("create a work item with the next numbered id")
  .option("--title <title>", "item title for the legacy skeleton route")
  .option(
    "--input <file>",
    "Complete JSON CreateInput, including optional authored body; cannot mix with creation flags",
  )
  .option("--type <type>", "Task or Epic", "Task")
  .option("--description <text>", "one-sentence description")
  .option("--epic <link>", "bundle-absolute link to the epic")
  .option("--deps <ids>", "comma-separated dependency ids")
  .option("--priority <p>", "p0..p3", "p2")
  .option("--rank <n>", "manual lane order — lower sorts first, unranked last")
  .option("--assignee <who>")
  .option("--tags <tags>", "comma-separated tags")
  .option("--json", "machine-readable output")
  .option(
    "--compact",
    "versioned write receipt; complete content remains available through document read",
  )
  .action(
    async (
      opts: Record<string, string | undefined> & {
        json?: boolean;
        compact?: boolean;
      },
      command: Command,
    ) => {
      if (!opts.input && opts.title === undefined)
        command.error("required option '--title <title>' not specified", {
          code: "commander.missingMandatoryOptionValue",
        });
      const { store, idCoordinator, config } = await ctx();
      if (opts.rank !== undefined && Number.isNaN(Number(opts.rank)))
        fail(new Error(`rank must be a number, got "${opts.rank}"`));
      try {
        const fields = [
          "title",
          "type",
          "description",
          "epic",
          "deps",
          "priority",
          "rank",
          "assignee",
          "tags",
        ];
        if (
          opts.input &&
          fields.some((field) => command.getOptionValueSource(field) === "cli")
        )
          throw new TaskEditError(
            "invalid-request",
            "Use structured input or creation flags, without mixing them.",
          );
        const input = opts.input
          ? JSON.parse(await readFile(opts.input, "utf8"))
          : {
              title: opts.title as string,
              type: opts.type as WorkItemType,
              description: opts.description,
              epic: opts.epic,
              dependsOn: opts.deps?.split(",").map((s) => s.trim()),
              priority: opts.priority as Priority,
              rank: opts.rank === undefined ? undefined : Number(opts.rank),
              assignee: opts.assignee,
              tags: opts.tags?.split(",").map((s) => s.trim()),
            };
        const result = await createWorkItem(
          store,
          config,
          input,
          idCoordinator,
        );
        if (opts.json || opts.compact)
          await print(
            JSON.stringify(
              opts.compact
                ? compactWriteReceipt("task_create", result)
                : result,
              null,
              2,
            ),
          );
        else await print(`created ${result.id} at ${result.path}`);
      } catch (error) {
        fail(error);
      }
    },
  );

program
  .command("decision")
  .description("record decisions without starting tracked work")
  .command("create")
  .description(
    "record an accepted Decision in decisions/ using the configured decision prefix",
  )
  .requiredOption("--title <title>", "decision title")
  .option("--description <text>", "one-sentence description")
  .option(
    "--context <text>",
    "context, relevant links and alternatives considered",
  )
  .option("--decision <text>", "accepted choice and why")
  .option("--consequences <text>", "tradeoffs and follow-up effects")
  .option("--tags <tags>", "comma-separated tags")
  .option("--json", "machine-readable output")
  .option(
    "--compact",
    "versioned decision creation receipt with source version",
  )
  .action(async (opts) => {
    const { store, config, idCoordinator } = await ctx();
    try {
      const result = await createDecision(
        store,
        config,
        { ...opts, tags: opts.tags?.split(",").map((s: string) => s.trim()) },
        idCoordinator,
      );
      if (opts.json || opts.compact)
        await print(
          JSON.stringify(
            opts.compact
              ? compactWriteReceipt("decision_create", result)
              : result,
            null,
            2,
          ),
        );
      else await print(`created ${result.id} at ${result.path}`);
    } catch (error) {
      fail(error);
    }
  });

task
  .command("start [id]")
  .description(
    "begin work: set the active task, move to in-progress, print the context packet (no id: top ready task)",
  )
  .option("--json", "machine-readable output")
  .option(
    "--compact",
    "bounded versioned pickup packet with explicit source continuations",
  )
  .action(
    async (
      given: string | undefined,
      opts: { json?: boolean; compact?: boolean },
    ) => {
      const { root, store, config, metadata } = await ctx();
      const b = await metadata(true);
      let picked = false;
      let id = given;
      if (!id) {
        const top = readyWorkItems(b)[0];
        if (!top) {
          throw new TaskEditError(
            "invalid-request",
            "Nothing ready: no todo task has every dependency done; task list shows unfinished work.",
          );
        }
        id = top.fm.id;
        picked = true;
      }
      const item = b.byId(id);
      if (item?.kind !== "work")
        return fail(
          new TaskEditError("invalid-request", `no work item with id ${id}`),
        );
      if (item.fm.type === "Epic") {
        try {
          const route = await buildEpicSupervisionRoute(store, b, item.fm.id);
          if (opts.json || opts.compact)
            await print(
              JSON.stringify(
                opts.compact ? compactEpicRoute(route) : route,
                null,
                2,
              ),
            );
          else {
            await print(
              `${item.fm.id} is an epic — route to the docket-epic workflow`,
            );
            await print(
              `no status or active task changed; supervise ready child tasks under ${route.suggestedSessionTitle}`,
            );
          }
        } catch (error) {
          fail(error);
        }
        return;
      }
      const progress = await readTaskProgress(b, root, config);
      const drift = taskDriftReceipt(item.fm.id, progress);
      recordOperationOutcome(taskDriftOutcome(drift));
      await withActiveTaskLock(root, async (lease) => {
        const active = lease.state.id;
        if (active && active !== item.fm.id) {
          const conflict = pickupConflict(root, config.bundle, active, item);
          if (opts.json)
            await print(
              JSON.stringify(
                {
                  error: conflict,
                  drift,
                  instructions: await readWorkflowFreshness(store),
                },
                null,
                2,
              ),
            );
          else {
            await print(conflict.message);
            await print(
              `For an explicitly authorized hand-off: ${conflict.handoff.command}, then ${conflict.handoff.nextCommand}`,
            );
            await print(
              "For parallel tracked work, propose a separate linked worktree and confirm before creating it unless isolation is already explicitly authorized.",
            );
            await print(`Suggested path: ${conflict.isolation.path}`);
            await print(
              `Suggested branch: ${conflict.isolation.branch} (adapt to project branch guidance)`,
            );
            await print(
              `Starting point: ${conflict.isolation.startingPoint}; later integrate the separate branch explicitly.`,
            );
            for (const issue of conflict.isolation.issues)
              await print(`Resolve first: ${issue}`);
            await print(
              `Git recipe: ${conflict.isolation.command ?? conflict.isolation.commandTemplate}`,
            );
            await print(`Agent prompt: ${conflict.isolation.agentPrompt}`);
          }
          process.exitCode = 1;
          return;
        }
        if (!lease.state.id && lease.state.token)
          throw new TaskEditError(
            "source-conflict",
            "An orphan workflow token requires review before pickup; no status or marker changed.",
          );
        try {
          const from = item.fm.status;
          const already = from === "in-progress";
          if (!already)
            await setStatus(store, config, item.fm.id, "in-progress");
          const telemetryWorkflow =
            (already ? lease.state.token : null) ?? createWorkflowToken();
          await lease.write(item.fm.id, telemetryWorkflow);

          const fresh = await metadata(true);
          const commits = scanActivity(root, config.git.trailer, fresh.byId)
            .filter((a) => a.taskId === item.fm.id)
            .map(({ sha, date, subject }) => ({ sha, date, subject }));
          const packet = await buildContextPacket(
            store,
            fresh,
            item.fm.id,
            commits,
            progress,
          );

          if (opts.json || opts.compact) {
            await print(
              JSON.stringify(
                opts.compact
                  ? compactContextPacket(packet, {
                      picked,
                      started: already ? null : { from, to: "in-progress" },
                      telemetryWorkflow,
                    })
                  : {
                      picked,
                      started: already ? null : { from, to: "in-progress" },
                      telemetryWorkflow,
                      ...packet,
                    },
                null,
                2,
              ),
            );
            return;
          }
          if (picked)
            await print(`picked ${item.fm.id} — top of the ready list`);
          await print(
            already
              ? `${item.fm.id} is already in-progress — resuming (active task set)`
              : `${item.fm.id}: ${from} → in-progress (active task set)`,
          );
          await printPacket(packet);
        } catch (error) {
          fail(error);
        }
      });
    },
  );

task
  .command("stop [id]")
  .description(
    "clear a matching active task without changing status; bare stop remains compatible",
  )
  .option(
    "--workflow-token <token>",
    "guard against another pickup of the same task",
  )
  .option(
    "--after-commit <sha>",
    "require the committed terminal task source and trailer before cleanup (requires id)",
  )
  .option("--json", "machine-readable scoped cleanup receipt")
  .action(
    async (
      id: string | undefined,
      opts: { json?: boolean; workflowToken?: string; afterCommit?: string },
    ) => {
      const { root, store, config } = await ctx();
      if (opts.afterCommit !== undefined && !id)
        throw new TaskEditError(
          "invalid-request",
          "--after-commit requires a named task.",
        );
      const result = await stopActiveTask(root, {
        id,
        workflowToken: opts.workflowToken,
        ...(opts.afterCommit !== undefined
          ? {
              verifyCommit: () =>
                closureCommit(
                  root,
                  store,
                  config,
                  id as string,
                  opts.afterCommit as string,
                ),
            }
          : {}),
      });
      if (!result.ok) {
        process.exitCode = 1;
        usageError = new TaskEditError(
          ["marker-mismatch", "workflow-mismatch"].includes(
            result.cleanup.disposition,
          )
            ? "source-conflict"
            : [
                  "state-unavailable",
                  "cleanup-failed",
                  "cleared-with-error",
                ].includes(result.cleanup.disposition)
              ? "unavailable"
              : "invalid-request",
          result.error?.message ?? "Lifecycle cleanup refused.",
          result.mutation === "partial" || result.mutation === "unknown"
            ? "unknown"
            : "unchanged",
        );
      }
      await print(
        opts.json
          ? JSON.stringify(compactWriteReceipt("task_stop", result), null, 2)
          : result.ok
            ? `${result.cleanup.disposition}${result.activeTaskId ? ` ${result.activeTaskId}` : ""} — status untouched`
            : (result.error?.message ?? "Active-task cleanup failed."),
      );
    },
  );

task
  .command("move <id> <status>")
  .description("change status (state machine enforced)")
  .option(
    "--note <text>",
    "append a dated Log entry (required for closing or reopening closed work)",
  )
  .option("--json", "machine-readable output")
  .option("--compact", "versioned compact receipt without authored content")
  .action(
    async (
      id: string,
      status: string,
      opts: { note?: string; json?: boolean; compact?: boolean },
    ) => {
      const { store, config } = await ctx();
      try {
        const result = await setStatus(store, config, id, status, {
          note: opts.note,
        });
        if (opts.json || opts.compact)
          await print(
            JSON.stringify(
              opts.compact ? compactWriteReceipt("set_status", result) : result,
              null,
              2,
            ),
          );
        else await print(`${result.id}: ${result.from} → ${result.to}`);
      } catch (error) {
        fail(error);
      }
    },
  );

task
  .command("edit <id>")
  .description("edit fields in place (status has `move`; ready stays derived)")
  .option("--priority <p>", "p0..p3")
  .option("--rank <n>", "manual lane order — lower sorts first, unranked last")
  .option("--clear-rank", "remove the rank (back to the unranked tail)")
  .option("--epic <link>", "bundle-absolute link to the new epic")
  .option("--clear-epic", "remove the epic link")
  .option(
    "--expected-version <version>",
    "refuse if the complete source version changed",
  )
  .option("--json", "machine-readable output")
  .action(
    async (
      id: string,
      opts: {
        priority?: string;
        rank?: string;
        clearRank?: boolean;
        epic?: string;
        clearEpic?: boolean;
        expectedVersion?: string;
        json?: boolean;
      },
    ) => {
      try {
        if (
          (opts.rank !== undefined && opts.clearRank) ||
          (opts.epic !== undefined && opts.clearEpic)
        )
          throw new TaskEditError(
            "invalid-request",
            "A field cannot be set and cleared in the same request.",
          );
        if (opts.rank !== undefined && !opts.rank.trim())
          throw new TaskEditError(
            "invalid-request",
            "Rank must be a finite number.",
          );
        const { root, store, config, metadata } = await ctx();
        const b = await metadata(true);
        const item = b.byId(id);
        const advisory =
          item?.kind === "work" && item.fm.type === "Task"
            ? {
                drift: taskDriftReceipt(
                  item.fm.id,
                  await readTaskProgress(b, root, config),
                ),
                instructions: await readWorkflowFreshness(store),
              }
            : {};
        if (advisory.drift)
          recordOperationOutcome(taskDriftOutcome(advisory.drift));
        const result = {
          ...(await editWorkItem(
            store,
            config,
            id,
            {
              ...(opts.priority !== undefined
                ? { priority: opts.priority }
                : {}),
              ...(opts.rank !== undefined || opts.clearRank
                ? { rank: opts.clearRank ? null : Number(opts.rank) }
                : {}),
              ...(opts.epic !== undefined || opts.clearEpic
                ? { epic: opts.clearEpic ? null : opts.epic }
                : {}),
            },
            opts.expectedVersion,
          )),
          ...advisory,
        };
        if (opts.json) await print(JSON.stringify(result, null, 2));
        else
          await print(
            `${result.id}: ${result.changed ? "fields updated" : "unchanged"}`,
          );
      } catch (error) {
        if (opts.json) {
          const failure =
            error instanceof TaskEditError
              ? error
              : new TaskEditError(
                  "unavailable",
                  error instanceof Error
                    ? error.message
                    : "Task edit unavailable.",
                );
          await print(JSON.stringify(failure.receipt(), null, 2));
          process.exitCode = 1;
        } else fail(error);
      }
    },
  );

task
  .command("close <id>")
  .description(
    "record terminal state after preparing Outcome/Disposition and docs; retain active state until validation and commit",
  )
  .option("--note <text>", "closing Log entry")
  .option(
    "--without-completion",
    "move to closed instead of done (requires --note)",
  )
  .option("--json", "machine-readable output")
  .option("--compact", "versioned compact closure receipt")
  .action(
    async (
      id: string,
      opts: {
        note?: string;
        withoutCompletion?: boolean;
        json?: boolean;
        compact?: boolean;
      },
    ) => {
      const { root, store, config } = await ctx();
      try {
        if (opts.withoutCompletion && !opts.note?.trim())
          throw new TaskEditError(
            "invalid-request",
            "--without-completion requires --note <reason>",
          );
        const to = opts.withoutCompletion ? "closed" : "done";
        const result = await setStatus(store, config, id, to, {
          note: opts.note,
        });
        const closure = await closureFeedback(root, result.id);
        if (opts.json || opts.compact)
          await print(
            JSON.stringify(
              opts.compact
                ? compactWriteReceipt("task_close", {
                    ...result,
                    closure,
                  })
                : { ...result, closure },
              null,
              2,
            ),
          );
        else {
          await print(
            `${result.id}: ${result.from} → ${to} — refresh discovery, validate and commit prepared narrative/docs/state/log. Lifecycle state unchanged.`,
          );
          const cleanup = closure.cleanup as { args?: string[]; state: string };
          await print(
            cleanup.args
              ? `After commit: docket ${cleanup.args.join(" ")}`
              : `Cleanup: ${cleanup.state}; leave unrelated lifecycle state untouched.`,
          );
        }
      } catch (error) {
        fail(error);
      }
    },
  );

task
  .command("log <id> <entry>")
  .description("append a dated entry under # Log (newest first)")
  .option("--json", "machine-readable append receipt")
  .action(async (id: string, entry: string, opts: { json?: boolean }) => {
    const { store, config } = await ctx();
    try {
      const result = await appendLog(store, config, id, entry);
      await print(
        opts.json
          ? JSON.stringify(compactWriteReceipt("append_log", result), null, 2)
          : `logged to ${result.path}`,
      );
    } catch (error) {
      fail(error);
    }
  });

// Only static command names reach telemetry. No argument values are retained.
const args = process.argv.slice(2);
const usageOperation = cliOperation(args);
let telemetry: Telemetry | undefined;
if (usageOperation && !args.includes("--help") && !args.includes("-h")) {
  try {
    usageRoot = await findRepoRoot(process.cwd());
    if (usageRoot) telemetry = new Telemetry(usageRoot, "cli");
  } catch {
    /* Context errors are handled by the operation, not observation. */
  }
}
let usageError: unknown;
const runCli = async () => {
  try {
    await program.parseAsync();
  } catch (error) {
    usageError = error;
    if (error instanceof CommanderError && error.exitCode === 0) {
      process.exitCode = 0;
      return;
    }
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
    if (args.includes("--json") || args.includes("--compact"))
      await print(
        JSON.stringify(
          errorReceipt(
            usageOperation ?? "unknown",
            error,
            error instanceof CommanderError,
          ),
          null,
          2,
        ),
      );
    else if (!(error instanceof CommanderError))
      console.error(error instanceof Error ? error.message : String(error));
  }
};
try {
  if (usageOperation)
    await observeOperation(telemetry, usageOperation, runCli, {
      dimensions: () => usageDimensions,
      attribution: () => {
        const launch = environmentAttribution();
        return resolveAttribution({
          launch: {
            ...launch,
            trigger: "explicit",
            workflow:
              launch.workflow ??
              (usageRoot ? checkoutWorkflowToken(usageRoot) : undefined),
          },
        });
      },
      resultError: () =>
        process.exitCode
          ? usageError
            ? errorCategory(usageError)
            : "validation"
          : "none",
      resultOutcome: () => ({ responseBytes: usageResponseBytes }),
    });
  else await runCli();
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
