#!/usr/bin/env bun

// docket — first thin client over @gitdocket/core. Every command is a core
// call plus formatting; agents pass --json, humans get columns.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendLog,
  applyIndex,
  type Bundle,
  buildContextPacket,
  type ContextPacket,
  createWorkItem,
  DEFAULT_BUNDLE,
  DOCKET_VERSION,
  type DocketConfig,
  docketIntent,
  findFreshnessWatermark,
  findRepoRoot,
  GitWorktreeIdCoordinator,
  isTerminalStatus,
  LocalFileStore,
  lintBundle,
  loadBundle,
  loadMetadataBundle,
  type Priority,
  parseConfig,
  parseStateOfPlay,
  READY_QUEUE_DESCRIPTION,
  readProjectGuidance,
  readyWorkItems,
  renderIndex,
  STATE_OF_PLAY_PATH,
  searchFresh,
  setEpic,
  setPriority,
  setRank,
  setStatus,
  sourcePage,
  verifyStatus,
  type WorkItem,
  type WorkItemType,
} from "@gitdocket/core";
import { scanActivity, taskLinkedCommitsSince } from "@gitdocket/core/cache";
import { deriveRepositoryOverview } from "@gitdocket/core/orientation";
import {
  type Dimensions,
  environmentAttribution,
  type Operation,
  observeOperation,
  Telemetry,
} from "@gitdocket/core/telemetry";
import { Command, CommanderError } from "commander";
import { trailerlessSince } from "./freshness";
import { refreshIndex } from "./indexing";
import { AGENT_TARGETS, type AgentTarget, runInit } from "./init";
import { renderOverview } from "./overview";
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

const activeTaskPath = (root: string): string =>
  join(root, ".docket", "active-task");

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

const program = new Command();
registerTelemetry(program, print);

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
    const { metadata } = await ctx();
    const b = await metadata();
    const ready = readyWorkItems(b).slice(0, opts.limit);
    if (opts.json) await print(JSON.stringify(ready.map(summarize), null, 2));
    else if (ready.length === 0)
      await print("nothing ready — check `docket task list --status blocked`");
    else for (const w of ready) await print(row(w));
  });

program
  .command("overview")
  .description(docketIntent("orientation").discovery)
  .option("--json", "machine-readable output")
  .action(async (opts: { json?: boolean }) => {
    const { root, store, config, metadata } = await ctx();
    const b = await metadata();
    const result = await deriveRepositoryOverview({
      root,
      store,
      config,
      bundle: b,
    });
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
  .description("conformance errors + PM-101 warnings")
  .option("--json", "machine-readable output")
  .option("--strict", "exit nonzero on warnings too")
  .action(async (opts: { json?: boolean; strict?: boolean }) => {
    const { root, store, config, bundle } = await ctx();
    const logSource = await store.read("log.md").catch(() => undefined);
    const watermark = logSource && findFreshnessWatermark(logSource);
    const stateOfPlaySource = await store
      .read(STATE_OF_PLAY_PATH)
      .catch(() => undefined);
    const stateOfPlay = stateOfPlaySource
      ? parseStateOfPlay(stateOfPlaySource).note
      : undefined;
    const b = await bundle();
    const diags = await lintBundle(store, b, {
      trailerlessCommits: watermark
        ? trailerlessSince(root, watermark.sha, config.git.trailer)
        : undefined,
      stateOfPlayCommitsAgo: stateOfPlay
        ? taskLinkedCommitsSince(root, config.git.trailer, stateOfPlay.asOf)
        : undefined,
      verifyMarkers: await scanRepoMarkers(root, config, b),
    });
    const errors = diags.filter((d) => d.severity === "error").length;
    if (opts.json) await print(JSON.stringify(diags, null, 2));
    else if (diags.length === 0) await print("clean");
    else
      for (const d of diags)
        await print(`${d.severity.padEnd(8)} ${d.path} — ${d.message}`);
    if (errors > 0 || (opts.strict && diags.length > 0)) process.exitCode = 1;
  });

program
  .command("index")
  .description(
    "regenerate index.md below its marker (lockfile pattern) and rebuild the .docket cache",
  )
  .option("--check", "fail if index.md is stale, write nothing (CI)")
  .action(async (opts: { check?: boolean }) => {
    const { root, store, config, bundle } = await ctx();
    const b = await bundle();
    const current = await store.read("index.md").catch(() => "");
    const next = applyIndex(current, renderIndex(b));

    if (opts.check) {
      if (next !== current) {
        console.error("index.md is stale — run `docket index`");
        process.exitCode = 1;
        return;
      }
      await print("index.md up to date");
      return;
    }

    const result = await refreshIndex(root, store, config, b);
    const verifyNote = config.verify
      ? `; ${result.verifyMarkerCount} verify marker(s)`
      : "";
    await print(
      `${result.indexChanged ? "index.md regenerated" : "index.md unchanged"}; cache rebuilt at .docket/cache.sqlite${verifyNote}`,
    );
  });

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
    "install an agent adapter; repeat for multiple targets (claude, codex)",
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
            "\nnative agent adapters skipped — rerun with --agent claude, --agent codex, or both",
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
        if (opts.json) {
          await print(JSON.stringify(report, null, 2));
        } else {
          if (report.items.length === 0) {
            await print("nothing vendored here to upgrade");
          }
          for (const item of report.items) {
            const note =
              item.action === "skipped"
                ? item.reason
                : item.action === "up-to-date"
                  ? (item.reason ?? report.available)
                  : `${item.from ?? "unversioned"} → ${report.available}`;
            await print(
              `${item.action.padEnd(12)} ${item.path}${note ? ` (${note})` : ""}`,
            );
          }
          if (report.conflicts.length > 0) {
            await print(
              `\n${report.conflicts.length} conflict(s) — resolve the markers, keeping local customizations where they still apply${report.filedTask ? ` (filed ${report.filedTask.id})` : ""}`,
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
      const { metadata } = await ctx();
      const b = await metadata();
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
      if (opts.json) await print(JSON.stringify(items.map(summarize), null, 2));
      else for (const w of items) await print(row(w));
    },
  );

task
  .command("create")
  .description("create a work item with the next numbered id")
  .requiredOption("--title <title>", "item title")
  .option("--type <type>", "Task or Epic", "Task")
  .option("--description <text>", "one-sentence description")
  .option("--epic <link>", "bundle-absolute link to the epic")
  .option("--deps <ids>", "comma-separated dependency ids")
  .option("--priority <p>", "p0..p3", "p2")
  .option("--rank <n>", "manual lane order — lower sorts first, unranked last")
  .option("--assignee <who>")
  .option("--tags <tags>", "comma-separated tags")
  .option("--json", "machine-readable output")
  .action(
    async (opts: Record<string, string | undefined> & { json?: boolean }) => {
      const { store, idCoordinator, config } = await ctx();
      if (opts.rank !== undefined && Number.isNaN(Number(opts.rank)))
        fail(new Error(`rank must be a number, got "${opts.rank}"`));
      try {
        const result = await createWorkItem(
          store,
          config,
          {
            title: opts.title as string,
            type: opts.type as WorkItemType,
            description: opts.description,
            epic: opts.epic,
            dependsOn: opts.deps?.split(",").map((s) => s.trim()),
            priority: opts.priority as Priority,
            rank: opts.rank === undefined ? undefined : Number(opts.rank),
            assignee: opts.assignee,
            tags: opts.tags?.split(",").map((s) => s.trim()),
          },
          idCoordinator,
        );
        if (opts.json) await print(JSON.stringify(result, null, 2));
        else await print(`created ${result.id} at ${result.path}`);
      } catch (error) {
        fail(error);
      }
    },
  );

task
  .command("start [id]")
  .description(
    "begin work: set the active task, move to in-progress, print the context packet (no id: top ready task)",
  )
  .option("--json", "machine-readable output")
  .action(async (given: string | undefined, opts: { json?: boolean }) => {
    const { root, store, config, metadata } = await ctx();
    const b = await metadata(true);
    let picked = false;
    let id = given;
    if (!id) {
      const top = readyWorkItems(b)[0];
      if (!top) {
        console.error(
          "nothing ready — no todo task has every dependency done; `docket task list` shows what's in flight or blocked",
        );
        process.exitCode = 1;
        return;
      }
      id = top.fm.id;
      picked = true;
    }
    const item = b.byId(id);
    if (item?.kind !== "work")
      return fail(new Error(`no work item with id ${id}`));
    if (item.fm.type === "Epic")
      return fail(
        new Error(`${item.fm.id} is an epic — start one of its tasks`),
      );
    try {
      const from = item.fm.status;
      const already = from === "in-progress";
      if (!already) await setStatus(store, config, item.fm.id, "in-progress");
      await mkdir(join(root, ".docket"), { recursive: true });
      await writeFile(activeTaskPath(root), `${item.fm.id}\n`, "utf8");

      const fresh = await metadata(true);
      const commits = scanActivity(root, config.git.trailer, fresh.byId)
        .filter((a) => a.taskId === item.fm.id)
        .map(({ sha, date, subject }) => ({ sha, date, subject }));
      const packet = await buildContextPacket(
        store,
        fresh,
        item.fm.id,
        commits,
      );

      if (opts.json) {
        await print(
          JSON.stringify(
            {
              picked,
              started: already ? null : { from, to: "in-progress" },
              ...packet,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (picked) await print(`picked ${item.fm.id} — top of the ready list`);
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

task
  .command("stop")
  .description("pause work: clear the active task (status untouched)")
  .action(async () => {
    const { root } = await ctx();
    const path = activeTaskPath(root);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === undefined) {
      await print("no active task");
      return;
    }
    await rm(path);
    const id = current.trim();
    await print(
      id
        ? `stopped ${id} — active task cleared, status untouched (finishing is \`docket task close\`)`
        : "active task cleared",
    );
  });

task
  .command("move <id> <status>")
  .description("change status (state machine enforced)")
  .option("--note <text>", "also append a dated Log entry")
  .option("--json", "machine-readable output")
  .action(
    async (
      id: string,
      status: string,
      opts: { note?: string; json?: boolean },
    ) => {
      const { store, config } = await ctx();
      try {
        const result = await setStatus(store, config, id, status, {
          note: opts.note,
        });
        if (opts.json) await print(JSON.stringify(result, null, 2));
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
        json?: boolean;
      },
    ) => {
      if (
        !opts.priority &&
        opts.rank === undefined &&
        !opts.clearRank &&
        !opts.epic &&
        !opts.clearEpic
      )
        fail(
          new Error(
            "nothing to edit — pass --priority, --rank, --clear-rank, --epic, or --clear-epic",
          ),
        );
      if (opts.rank !== undefined && Number.isNaN(Number(opts.rank)))
        fail(new Error(`rank must be a number, got "${opts.rank}"`));
      const { store, config } = await ctx();
      try {
        const results: string[] = [];
        const json: Record<string, unknown> = { id };
        if (opts.priority) {
          const r = await setPriority(store, config, id, opts.priority);
          json.id = r.id;
          json.priority = { from: r.from, to: r.to };
          results.push(`priority ${r.from} → ${r.to}`);
        }
        if (opts.rank !== undefined || opts.clearRank) {
          const r = await setRank(
            store,
            config,
            id,
            opts.clearRank ? null : Number(opts.rank),
          );
          json.id = r.id;
          json.rank = { from: r.from, to: r.to };
          results.push(`rank ${r.from ?? "none"} → ${r.to ?? "none"}`);
        }
        if (opts.epic || opts.clearEpic) {
          const r = await setEpic(
            store,
            config,
            id,
            opts.clearEpic ? null : (opts.epic as string),
          );
          json.id = r.id;
          json.epic = { from: r.from, to: r.to };
          results.push(`epic ${r.from ?? "none"} → ${r.to ?? "none"}`);
        }
        if (opts.json) await print(JSON.stringify(json, null, 2));
        else await print(`${json.id}: ${results.join(", ")}`);
      } catch (error) {
        fail(error);
      }
    },
  );

task
  .command("close <id>")
  .description(
    "complete work by default, or close it without completion with an explicit disposition",
  )
  .option("--note <text>", "closing Log entry")
  .option(
    "--without-completion",
    "move to closed instead of done (requires --note)",
  )
  .option("--json", "machine-readable output")
  .action(
    async (
      id: string,
      opts: {
        note?: string;
        withoutCompletion?: boolean;
        json?: boolean;
      },
    ) => {
      const { store, config } = await ctx();
      try {
        if (opts.withoutCompletion && !opts.note?.trim())
          throw new Error("--without-completion requires --note <reason>");
        const to = opts.withoutCompletion ? "closed" : "done";
        const result = await setStatus(store, config, id, to, {
          note: opts.note,
        });
        if (opts.json) await print(JSON.stringify(result, null, 2));
        else if (to === "closed")
          await print(
            `${result.id}: ${result.from} → closed — disposition recorded; acceptance criteria remain incomplete`,
          );
        else
          await print(
            `${result.id}: ${result.from} → done — now write the Outcome and reconcile docs`,
          );
      } catch (error) {
        fail(error);
      }
    },
  );

task
  .command("log <id> <entry>")
  .description("append a dated entry under # Log (newest first)")
  .action(async (id: string, entry: string) => {
    const { store, config } = await ctx();
    try {
      const { path } = await appendLog(store, config, id, entry);
      await print(`logged to ${path}`);
    } catch (error) {
      fail(error);
    }
  });

// Only static command names reach telemetry. No argument values are retained.
const cliOperations: Record<string, Operation> = {
  ready: "ready",
  overview: "overview",
  search: "search",
  source: "source_page",
  guidance: "project_guidance",
  lint: "lint",
  index: "index",
  verify: "verify",
  init: "init",
  upgrade: "upgrade",
  freshness: "freshness",
};
const taskOperations: Record<string, Operation> = {
  list: "task_list",
  create: "task_create",
  start: "task_start",
  stop: "task_stop",
  move: "set_status",
  edit: "task_edit",
  close: "task_close",
  log: "append_log",
};
const args = process.argv.slice(2);
const usageOperation =
  args[0] === "task"
    ? taskOperations[args[1] ?? ""]
    : cliOperations[args[0] ?? ""];
let telemetry: Telemetry | undefined;
if (usageOperation && !args.includes("--help") && !args.includes("-h")) {
  try {
    usageRoot = await findRepoRoot(process.cwd());
    if (usageRoot) telemetry = new Telemetry(usageRoot, "cli");
  } catch {
    /* Context errors are handled by the operation, not observation. */
  }
}
program.exitOverride();
try {
  if (usageOperation)
    await observeOperation(
      telemetry,
      usageOperation,
      async () => {
        await program.parseAsync();
      },
      {
        dimensions: () => usageDimensions,
        attribution: { ...environmentAttribution(), trigger: "explicit" },
        resultError: () => (process.exitCode ? "validation" : "none"),
      },
    );
  else await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
