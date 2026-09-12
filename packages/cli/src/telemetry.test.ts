import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore } from "@gitdocket/core/telemetry";

const cli = join(import.meta.dir, "index.ts");
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
    expect(store.events().filter((e) => e.kind === "operation")).toHaveLength(
      3,
    );
    expect(JSON.stringify(store.events())).not.toMatch(/PRIVATE|DKT-1/);
    expect((await run(["telemetry", "events", "--json"])).exit).toBe(0);
    expect(store.events().filter((e) => e.kind === "operation")).toHaveLength(
      3,
    );
    const report = await run(["telemetry", "report", "--json"]);
    expect(report.exit).toBe(0);
    expect(JSON.parse(report.stdout).coverage.observedOperations).toBe(3);
    expect((await run(["telemetry", "report"])).stdout).toContain(
      "Local usage: 3 operations",
    );
    expect(
      (await run(["telemetry", "report", "--since", "invalid"])).exit,
    ).toBe(1);
    expect(store.events().filter((e) => e.kind === "operation")).toHaveLength(
      3,
    );
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
