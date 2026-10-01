import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle } from "./bundle";
import { compactContextPacket, compactEpicRoute } from "./compact-packet";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { buildContextPacket, buildEpicSupervisionRoute } from "./packet";

test("large pickup preserves dependency/authority counts, source versions and mandatory continuations without another mutation", async () => {
  const deps = Array.from({ length: 80 }, (_, i) => `FIX-${i + 2}`);
  const sources = new Map([
    [
      "work/task.md",
      `---\ntype: Task\nid: FIX-1\ntitle: Large task\nstatus: in-progress\ndepends_on: [${deps.join(", ")}]\n---\n\n${"私".repeat(16000)}\n`,
    ],
    [
      "reference/project-guidance.md",
      "---\ntype: Reference\ntitle: Guidance\n---\n\nRequired testing standard.\n",
    ],
  ]);
  for (const id of deps.slice(0, -1))
    sources.set(
      `${id}.md`,
      `---\ntype: Task\nid: ${id}\nstatus: done\n---\n\nQualified.\n`,
    );
  const store = new InMemoryFileStore(sources),
    bundle = await loadBundle(store, parseConfig("project: FIX\n"));
  const packet = await buildContextPacket(store, bundle, "FIX-1");
  const before = new Map(store.files);
  const r = compactContextPacket(packet, {
    picked: false,
    started: null,
    telemetryWorkflow: "same-workflow",
  });
  expect(Buffer.byteLength(JSON.stringify(r, null, 2))).toBeLessThanOrEqual(
    32768,
  );
  expect(r.schema).toBe("docket-pickup/v1");
  expect(r).toMatchObject({
    changed: false,
    mutation: "unchanged",
    contextComplete: false,
    deps: { total: 80, omitted: 48, nonDone: 1, unresolved: 1 },
    guidance: { status: "present", sourceIncluded: true },
  });
  expect(r.requiredReads.map((p) => p.kind)).toEqual([
    "task-body",
    "dependencies",
  ]);
  expect(
    r.requiredReads.find((p) => p.kind === "dependencies")?.statuses?.cliArgs,
  ).toEqual(["task", "list", "--all", "--json"]);
  expect(r.task.version).toBe(packet.task.version);
  expect(store.files).toEqual(before);
});
test("bounded large epic route stays non-mutating and requires complete criteria before dispatch", async () => {
  const store = new InMemoryFileStore(
    new Map([
      [
        "epic.md",
        `---\ntype: Epic\nid: FIX-1\ntitle: Large epic\nstatus: todo\n---\n\n${"Accepted scope. ".repeat(1000)}\n`,
      ],
    ]),
  );
  const bundle = await loadBundle(store, parseConfig("project: FIX\n")),
    before = new Map(store.files);
  const r = compactEpicRoute(
    await buildEpicSupervisionRoute(store, bundle, "FIX-1"),
  );
  expect(r).toMatchObject({
    outcome: "route",
    changed: false,
    mutation: "unchanged",
    contextComplete: false,
  });
  expect(r.requiredReads).toHaveLength(1);
  expect(store.files).toEqual(before);
});
test("actual CLI retains legacy full packets, supports bounded continuation and preserves one pickup workflow on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-compact-pickup-"));
  try {
    await mkdir(join(root, "docket"));
    await writeFile(
      join(root, "docket.yaml"),
      "project: FIX\nbundle: docket\n",
    );
    await writeFile(
      join(root, "docket/task.md"),
      `---\ntype: Task\nid: FIX-1\ntitle: Large task\nstatus: todo\n---\n\n${"私".repeat(12000)}\n`,
    );
    const call = (...args: string[]) => {
      const p = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "../../cli/src/index.ts"),
          ...args,
          "--json",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(p.exitCode).toBe(0);
      return {
        bytes: p.stdout.byteLength,
        data: JSON.parse(p.stdout.toString()),
      };
    };
    const full = call("task", "start", "FIX-1"),
      compact = call("task", "start", "FIX-1", "--compact");
    expect(full.bytes).toBeGreaterThan(32768);
    expect(full.data.task.body).toHaveLength(12000);
    expect(compact.bytes).toBeLessThanOrEqual(32769);
    expect(compact.data.telemetryWorkflow).toBe(full.data.telemetryWorkflow);
    expect(compact.data.contextComplete).toBe(false);
    expect(compact.data.started).toBeNull();
    const source = call("source", compact.data.task.path);
    expect(source.data.sourceHash).toBe(compact.data.task.version);
    expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
      "FIX-1\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guidance continuation starts at the omitted page and omitted title intent is explicit", async () => {
  const store = new InMemoryFileStore(
    new Map([
      [
        "task.md",
        `---\ntype: Task\nid: FIX-1\ntitle: ${"Long title ".repeat(80)}\nstatus: todo\n---\n\nRequired scope.\n`,
      ],
      [
        "reference/project-guidance.md",
        `---\ntype: Reference\ntitle: Guidance\n---\n\n${"Required standard. ".repeat(1200)}\n`,
      ],
    ]),
  );
  const packet = await buildContextPacket(
    store,
    await loadBundle(store, parseConfig("project: FIX\n")),
    "FIX-1",
  );
  const r = compactContextPacket(packet, {
    picked: true,
    started: null,
    telemetryWorkflow: "qualified",
  });
  expect(r.contextComplete).toBe(false);
  expect(r.suggestedSessionTitle).toBeNull();
  expect(r.titleIntentOmitted).toBe(true);
  const required = r.requiredReads.find((p) => p.kind === "project-guidance");
  expect(required?.route.mcp.arguments.cursor).toEqual(
    packet.guidance.source?.nextCursor,
  );
  expect(required?.route.cliArgs).toContain("--cursor");
  expect(Buffer.byteLength(JSON.stringify(r, null, 2))).toBeLessThanOrEqual(
    32768,
  );
});
