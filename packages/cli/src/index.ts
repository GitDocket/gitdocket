#!/usr/bin/env bun

// docket — first thin client over @docket/core. Every command is a core
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
  isTerminalStatus,
  LocalFileStore,
  lintBundle,
  loadBundle,
  type Priority,
  parseConfig,
  parseStateOfPlay,
  READY_QUEUE_DESCRIPTION,
  readyWorkItems,
  renderIndex,
  STATE_OF_PLAY_PATH,
  searchBundle,
  setEpic,
  setPriority,
  setRank,
  setStatus,
  verifyStatus,
  type WorkItem,
  type WorkItemType,
} from "@docket/core";
import { scanActivity, taskLinkedCommitsSince } from "@docket/core/cache";
import { deriveRepositoryOverview } from "@docket/core/orientation";
import { Command } from "commander";
import { trailerlessSince } from "./freshness";
import { refreshIndex } from "./indexing";
import { AGENT_TARGETS, type AgentTarget, runInit } from "./init";
import { renderOverview } from "./overview";
import { runUpgrade } from "./upgrade";
import { scanRepoMarkers } from "./verify";

interface Ctx {
  root: string;
  store: LocalFileStore;
  config: DocketConfig;
  bundle: () => Promise<Bundle>;
}

async function ctx(): Promise<Ctx> {
  const root = await findRepoRoot(process.cwd());
  if (!root) {
    console.error("no docket.yaml found here or in any parent directory");
    process.exit(1);
  }
  const config = parseConfig(await readFile(join(root, "docket.yaml"), "utf8"));
  const store = new LocalFileStore(join(root, config.bundle));
  return { root, store, config, bundle: () => loadBundle(store, config) };
}

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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
};

const activeTaskPath = (root: string): string =>
  join(root, ".docket", "active-task");

// One screenful: header lines for the structure, then the body verbatim.
function printPacket(packet: ContextPacket): void {
  const { task, epic, deps, linked, commits } = packet;
  console.log(`\n${task.fm.id} — ${task.fm.title ?? ""}`);
  console.log(`${task.fm.status} · ${task.fm.priority ?? "p2"} · ${task.path}`);
  if (epic)
    console.log(
      `epic: ${epic.id ?? epic.path} — ${epic.title ?? ""} (${epic.status ?? "?"})`,
    );
  if (deps.length > 0)
    console.log(
      `deps: ${deps.map((d) => `${d.id} ${d.status ?? "missing!"}`).join(" · ")}`,
    );
  console.log(`\n${task.body}`);
  if (linked.length > 0) {
    console.log("\nlinked:");
    for (const l of linked)
      console.log(
        `  /${l.path} — ${[l.title, l.description].filter(Boolean).join(" — ")}`,
      );
  }
  if (commits.length > 0) {
    console.log("\ncommits:");
    for (const c of commits.slice(0, 10))
      console.log(`  ${c.sha.slice(0, 7)} ${c.date.slice(0, 10)} ${c.subject}`);
    if (commits.length > 10) console.log(`  … ${commits.length - 10} more`);
  }
}

const program = new Command();

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
  .action(async (opts: { json?: boolean }) => {
    const { bundle } = await ctx();
    const b = await bundle();
    const ready = readyWorkItems(b);
    if (opts.json) console.log(JSON.stringify(ready.map(summarize), null, 2));
    else if (ready.length === 0)
      console.log("nothing ready — check `docket task list --status blocked`");
    else for (const w of ready) console.log(row(w));
  });

program
  .command("overview")
  .description(docketIntent("orientation").discovery)
  .option("--json", "machine-readable output")
  .action(async (opts: { json?: boolean }) => {
    const { root, store, config, bundle } = await ctx();
    const b = await bundle();
    const result = await deriveRepositoryOverview({
      root,
      store,
      config,
      bundle: b,
    });
    const { narrative, ...model } = result;
    console.log(
      opts.json
        ? JSON.stringify(result, null, 2)
        : renderOverview(model, narrative),
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
    const { store, bundle } = await ctx();
    const hits = await searchBundle(store, await bundle(), parts.join(" "), {
      limit: Number(opts.limit) || 20,
    });
    if (opts.json) console.log(JSON.stringify(hits, null, 2));
    else if (hits.length === 0) console.log("no hits");
    else
      for (const h of hits)
        console.log(
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
    if (opts.json) console.log(JSON.stringify(diags, null, 2));
    else if (diags.length === 0) console.log("clean");
    else
      for (const d of diags)
        console.log(`${d.severity.padEnd(8)} ${d.path} — ${d.message}`);
    if (errors > 0 || (opts.strict && diags.length > 0)) process.exit(1);
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
        process.exit(1);
      }
      console.log("index.md up to date");
      return;
    }

    const result = await refreshIndex(root, store, config, b);
    const verifyNote = config.verify
      ? `; ${result.verifyMarkerCount} verify marker(s)`
      : "";
    console.log(
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
      console.log(
        "verify is not configured — add a `verify:` section with a `tests:` glob list to docket.yaml",
      );
      return;
    }
    const b = await bundle();
    const rows = verifyStatus(b, await scanRepoMarkers(root, config, b));
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("no specs and no markers found");
      return;
    }
    for (const r of rows) {
      console.log(`/${r.spec} — ${r.title ?? r.type}`);
      if (r.unverified) {
        console.log("  ⚠ nothing verifies this");
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
        console.log(`  ✓ ${source}${note}`);
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
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        for (const s of report.steps) {
          const notes = [
            ...(s.reason ? [s.reason] : []),
            ...(s.gitignored ? ["gitignored — local only"] : []),
          ];
          const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";
          console.log(`${s.action.padEnd(7)} ${s.path}${note}`);
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
          console.log(
            "\nwarning: this repo gitignores native agent adapter files, so they won't travel on clone. The tracked fallback still does: bundle workflows + AGENTS.md. Narrow the relevant ignore rules to share native adapters.",
          );
        }
        if (report.adopt.length > 0) {
          console.log(
            `\n${report.adopt.length} existing file(s) lack \`type\` frontmatter — proposed types (agent: review and apply, never move files):`,
          );
          for (const a of report.adopt)
            console.log(`  ${a.path} → type: ${a.proposedType}`);
        }
        if (agents.length === 0) {
          console.log(
            "\nnative agent adapters skipped — rerun with --agent claude, --agent codex, or both",
          );
        }
        console.log(
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
          console.log(JSON.stringify(report, null, 2));
        } else {
          if (report.items.length === 0) {
            console.log("nothing vendored here to upgrade");
          }
          for (const item of report.items) {
            const note =
              item.action === "skipped"
                ? item.reason
                : item.action === "up-to-date"
                  ? (item.reason ?? report.available)
                  : `${item.from ?? "unversioned"} → ${report.available}`;
            console.log(
              `${item.action.padEnd(12)} ${item.path}${note ? ` (${note})` : ""}`,
            );
          }
          if (report.conflicts.length > 0) {
            console.log(
              `\n${report.conflicts.length} conflict(s) — resolve the markers, keeping local customizations where they still apply${report.filedTask ? ` (filed ${report.filedTask.id})` : ""}`,
            );
          }
          if (report.dryRun) console.log("\ndry run — nothing written");
        }
        if (report.conflicts.length > 0) process.exit(1);
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
    const { startServe } = await import("@docket/web");
    try {
      const server = await startServe(root, config, {
        port: Number(opts.port),
        watch: opts.watch,
        commit: opts.commit,
      });
      const modes = [opts.watch && "watch", opts.commit && "commit"]
        .filter(Boolean)
        .join(", ");
      console.log(`docket serve → ${server.url}${modes ? ` (${modes})` : ""}`);
    } catch (error) {
      fail(error);
    }
  });

const task = program.command("task").description("work item operations");

task
  .command("list")
  .description(
    "list open work items (done and closed hidden by default — see --all)",
  )
  .option("--status <status>", "filter by status")
  .option("--epic <id>", "filter by epic id")
  .option("--type <type>", "Task or Epic")
  .option("--all", "include done and closed items")
  .option("--json", "machine-readable output")
  .action(
    async (opts: {
      status?: string;
      epic?: string;
      type?: string;
      all?: boolean;
      json?: boolean;
    }) => {
      const { bundle } = await ctx();
      const b = await bundle();
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
      if (opts.json) console.log(JSON.stringify(items.map(summarize), null, 2));
      else for (const w of items) console.log(row(w));
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
      const { store, config } = await ctx();
      if (opts.rank !== undefined && Number.isNaN(Number(opts.rank)))
        fail(new Error(`rank must be a number, got "${opts.rank}"`));
      try {
        const result = await createWorkItem(store, config, {
          title: opts.title as string,
          type: opts.type as WorkItemType,
          description: opts.description,
          epic: opts.epic,
          dependsOn: opts.deps?.split(",").map((s) => s.trim()),
          priority: opts.priority as Priority,
          rank: opts.rank === undefined ? undefined : Number(opts.rank),
          assignee: opts.assignee,
          tags: opts.tags?.split(",").map((s) => s.trim()),
        });
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`created ${result.id} at ${result.path}`);
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
    const { root, store, config, bundle } = await ctx();
    const b = await bundle();
    let picked = false;
    let id = given;
    if (!id) {
      const top = readyWorkItems(b)[0];
      if (!top) {
        console.error(
          "nothing ready — no todo task has every dependency done; `docket task list` shows what's in flight or blocked",
        );
        process.exit(1);
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

      const fresh = await bundle();
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
        console.log(
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
      if (picked) console.log(`picked ${item.fm.id} — top of the ready list`);
      console.log(
        already
          ? `${item.fm.id} is already in-progress — resuming (active task set)`
          : `${item.fm.id}: ${from} → in-progress (active task set)`,
      );
      printPacket(packet);
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
      console.log("no active task");
      return;
    }
    await rm(path);
    const id = current.trim();
    console.log(
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
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else console.log(`${result.id}: ${result.from} → ${result.to}`);
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
        if (opts.json) console.log(JSON.stringify(json, null, 2));
        else console.log(`${json.id}: ${results.join(", ")}`);
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
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else if (to === "closed")
          console.log(
            `${result.id}: ${result.from} → closed — disposition recorded; acceptance criteria remain incomplete`,
          );
        else
          console.log(
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
      console.log(`logged to ${path}`);
    } catch (error) {
      fail(error);
    }
  });

program.parse();
