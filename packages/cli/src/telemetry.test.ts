import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OperationEvent,
  TELEMETRY_COVERAGE,
  TelemetryStore,
} from "@gitdocket/core/telemetry";

const cli = join(import.meta.dir, "index.ts");

function operations(store: TelemetryStore): OperationEvent[] {
  return store
    .events()
    .filter((event): event is OperationEvent => event.kind === "operation");
}
test("CLI controls and observations preserve stdout, errors and exit codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-cli-telemetry-"));
  const root = join(dir, "project");
  const storage = join(dir, "usage");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docket.yaml"), "bundle: docs/\n");
  await writeFile(
    join(root, "docs/task.md"),
    "---\ntype: Task\nid: DKT-1\ntitle: PRIVATE_TITLE\nstatus: todo\n---\nPRIVATE_BODY",
  );
  const run = async (args: string[], directory = storage) => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: root,
      env: { ...process.env, DOCKET_TELEMETRY_DIR: directory },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  };
  const store = new TelemetryStore(root, storage);
  try {
    const disabled = await run(["ready", "--json"]);
    const bad = await run(["ready", "--limit", "bad"]);
    expect(store.events()).toEqual([]);
    expect((await run(["telemetry", "enable", "--json"])).exit).toBe(0);
    expect(await run(["ready", "--json"])).toEqual(disabled);
    expect(await run(["ready", "--limit", "bad"])).toEqual(bad);
    expect((await run(["search", "PRIVATE_BODY", "--json"])).exit).toBe(0);
    expect(operations(store)).toHaveLength(3);
    const search = operations(store).find((e) => e.operation === "search");
    expect(search?.resultCount).toBeGreaterThan(0);
    expect(search?.truncated).toBe("none");
    expect(JSON.stringify(store.events())).not.toMatch(/PRIVATE|DKT-1/);
    expect((await run(["telemetry", "events", "--json"])).exit).toBe(0);
    expect(operations(store)).toHaveLength(3);
    const report = await run(["telemetry", "report", "--json"]);
    expect(report.exit).toBe(0);
    const parsed = JSON.parse(report.stdout);
    expect(parsed.coverage.observedOperations).toBe(3);
    expect(parsed.windows.hours24.coverage.observedOperations).toBe(3);
    expect(parsed.windows.fullPilot.coverage.observedOperations).toBe(3);
    expect(typeof parsed.asOf).toBe("number");
    expect((await run(["telemetry", "report"])).stdout).toContain(
      "Local usage: 3 operations",
    );
    expect((await run(["telemetry", "report"])).stdout).toContain(
      "Last 24 hours:",
    );
    expect(
      (await run(["telemetry", "report", "--since", "invalid"])).exit,
    ).toBe(1);
    expect(operations(store)).toHaveLength(3);
    await run(["telemetry", "disable"]);
    expect(await run(["ready", "--json"])).toEqual(disabled);
    await writeFile(join(dir, "unavailable"), "file");
    expect(await run(["ready", "--json"], join(dir, "unavailable"))).toEqual(
      disabled,
    );
    const sample = store.events()[0];
    if (!sample) throw new Error("missing fixture observation");
    await run(["telemetry", "delete", "--all"]);
    expect(store.events()).toEqual([]);
    expect(store.status().project).toBeNull();
    const enrollment = store.enable();
    const db = new Database(join(storage, "usage.sqlite"));
    try {
      db.transaction(() => {
        for (let i = 0; i < 250; i++) {
          const row = {
            ...sample,
            id: randomUUID(),
            project: enrollment.project,
          };
          db.query("INSERT INTO events VALUES (?,?,?,?,?)").run(
            row.id,
            row.kind ?? "operation",
            row.time ?? Date.now(),
            row.project,
            JSON.stringify(row),
          );
        }
      })();
    } finally {
      db.close();
    }
    const exported = await run(["telemetry", "events", "--json"]);
    expect(exported.exit).toBe(0);
    expect(exported.stdout.length).toBeGreaterThan(65536);
    expect(JSON.parse(exported.stdout)).toHaveLength(250);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test("CLI launch env can attribute a process; unset env stays unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-cli-attr-"));
  const root = join(dir, "project");
  const storage = join(dir, "usage");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docket.yaml"), "bundle: docs/\n");
  await writeFile(
    join(root, "docs/task.md"),
    "---\ntype: Task\nid: DKT-1\nstatus: todo\n---\n",
  );
  const run = async (extra: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      DOCKET_TELEMETRY_DIR: storage,
      ...extra,
    };
    if (!("DOCKET_TELEMETRY_ACTOR" in extra)) delete env.DOCKET_TELEMETRY_ACTOR;
    if (!("DOCKET_TELEMETRY_HOST" in extra)) delete env.DOCKET_TELEMETRY_HOST;
    const child = Bun.spawn([process.execPath, cli, "ready", "--json"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
  };
  const store = new TelemetryStore(root, storage);
  try {
    expect(
      await Bun.spawn(
        [process.execPath, cli, "telemetry", "enable", "--json"],
        {
          cwd: root,
          env: { ...process.env, DOCKET_TELEMETRY_DIR: storage },
          stdout: "pipe",
          stderr: "pipe",
        },
      ).exited,
    ).toBe(0);
    await run();
    await run({
      DOCKET_TELEMETRY_ACTOR: "agent",
      DOCKET_TELEMETRY_HOST: "codex",
    });
    const ops = operations(store);
    expect(ops.map((event) => [event.actor, event.host])).toEqual([
      ["unknown", "unknown"],
      ["agent", "codex"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI checkout workflow tokens correlate later commands and rotate after stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-cli-workflow-"));
  const root = join(dir, "project");
  const storage = join(dir, "usage");
  await mkdir(root, { recursive: true });
  const run = async (args: string[]) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      DOCKET_TELEMETRY_DIR: storage,
    };
    delete env.DOCKET_TELEMETRY_WORKFLOW;
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    return { exit, stdout };
  };
  const store = new TelemetryStore(root, storage);
  try {
    expect((await run(["init", "--project", "WF", "--json"])).exit).toBe(0);
    expect((await run(["telemetry", "enable", "--json"])).exit).toBe(0);
    const created = await run([
      "task",
      "create",
      "--title",
      "Correlate me",
      "--json",
    ]);
    const id = JSON.parse(created.stdout).id as string;
    const started = await run(["task", "start", id, "--json"]);
    expect(typeof JSON.parse(started.stdout).telemetryWorkflow).toBe("string");
    const startEvent = operations(store).find(
      (event) => event.operation === "task_start",
    );
    expect(startEvent?.workflow).toBeTruthy();
    await run(["ready", "--json"]);
    await run(["ready", "--json"]);
    const first = operations(store)
      .filter((event) => event.operation === "ready")
      .map((event) => event.workflow);
    expect(first[0]).toBeTruthy();
    expect(first[1]).toBe(first[0]);
    await run(["task", "stop"]);
    await run(["ready", "--json"]);
    const afterStop = operations(store).filter(
      (event) => event.operation === "ready",
    );
    expect(afterStop.at(-1)?.workflow).toBeNull();
    const restarted = await run(["task", "start", id, "--json"]);
    expect(JSON.parse(restarted.stdout).telemetryWorkflow).not.toBe(
      JSON.parse(started.stdout).telemetryWorkflow,
    );
    await run(["ready", "--json"]);
    const afterRestart = operations(store).filter(
      (event) => event.operation === "ready",
    );
    expect(afterRestart.at(-1)?.workflow).toBeTruthy();
    expect(afterRestart.at(-1)?.workflow).not.toBe(first[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI extension discovery and lifecycle commands are observed without package names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-cli-ext-tel-"));
  const root = join(dir, "project");
  const storage = join(dir, "usage");
  await mkdir(root, { recursive: true });
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: root,
      env: { ...process.env, DOCKET_TELEMETRY_DIR: storage },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    return { exit, stdout };
  };
  const store = new TelemetryStore(root, storage);
  try {
    expect((await run(["init", "--project", "EX", "--json"])).exit).toBe(0);
    expect((await run(["telemetry", "enable", "--json"])).exit).toBe(0);
    expect((await run(["extension", "list", "--json"])).exit).toBe(0);
    const listed = operations(store).filter(
      (event) => event.operation === "extension_list",
    );
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toMatch(/tiny|package/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function helpCommands(text: string): string[] {
  const names: string[] = [];
  let inCommands = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("Commands:")) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    const match = line.match(/^ {2}([a-z][\w-]*)/);
    if (match?.[1] && match[1] !== "help") names.push(match[1]);
  }
  return names;
}

test("CLI commands are inventoried so new commands cannot skip coverage review", async () => {
  const help = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return new Response(child.stdout).text();
  };
  const top = helpCommands(await help([]));
  const nested = {
    task: helpCommands(await help(["task"])),
    extension: helpCommands(await help(["extension"])),
    telemetry: helpCommands(await help(["telemetry"])),
    verify: helpCommands(await help(["verify"])),
  };
  const discovered = [
    ...top,
    ...nested.task.map((name) => `task ${name}`),
    ...nested.extension.map((name) => `extension ${name}`),
    ...nested.telemetry.map((name) => `telemetry ${name}`),
    ...nested.verify.map((name) => `verify ${name}`),
  ].sort();
  const inventoried = TELEMETRY_COVERAGE.filter(
    (entry) =>
      entry.surface === "cli" &&
      entry.id !== "freshness" &&
      entry.status !== "uninstrumented",
  )
    .map((entry) => entry.id)
    .sort();
  expect(discovered).toEqual(inventoried);
});
