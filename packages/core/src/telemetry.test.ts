import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attributionFromMcpMeta,
  resolveAttribution,
  Telemetry,
  TelemetryStore,
} from "./telemetry";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "docket-telemetry-"));
  dirs.push(dir);
  const root = join(dir, "project");
  const storage = join(dir, "observations");
  return {
    root,
    storage,
    store: new TelemetryStore(root, storage),
    telemetry: new Telemetry(root, "mcp", storage),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const event = {
  operation: "search",
  durationMs: 12,
  outcome: "success",
} as const;
test("disabled by default, project scoped, independent from cache, immediate disable and re-enable", () => {
  const { store, telemetry, root, storage } = fixture();
  telemetry.record(event);
  expect(store.events()).toEqual([]);
  expect(store.status().enabled).toBe(false);
  const before = store.enable();
  telemetry.record(event);
  expect(store.events()).toHaveLength(2);
  new Telemetry(`${root}-other`, "mcp", storage).record(event);
  expect(store.events(true)).toHaveLength(2);
  store.disable();
  telemetry.record(event);
  expect(store.events()).toHaveLength(2);
  expect(store.enable().project).toBe(before.project);
  telemetry.record(event);
  expect(store.events()).toHaveLength(3);
  store.delete();
  telemetry.record(event);
  expect(store.events()).toEqual([]);
  expect(store.enable().project).not.toBe(before.project);
});
test("schema strips prohibited fields, rejects invalid/unsupported data; token is hashed", () => {
  const { store, telemetry, storage } = fixture();
  store.enable();
  telemetry.record({ ...event, query: "PRIVATE_CONTENT" } as typeof event, {
    workflow: "PRIVATE_TOKEN",
    host: "PRIVATE_HOST",
  });
  expect(store.events()).toHaveLength(2);
  expect(JSON.stringify(store.events())).not.toMatch(/PRIVATE/);
  const first = store.events()[0];
  if (!first) throw new Error("missing observation");
  expect(store.append(() => [{ ...first, schema: 999 }])).toBe("dropped");
  expect(store.append(() => [{ ...first, durationMs: Infinity }])).toBe(
    first.kind === "operation" ? "dropped" : "written",
  );
  expect(
    readFileSync(join(storage, "usage.sqlite")).includes(
      Buffer.from("PRIVATE"),
    ),
  ).toBe(false);
});
test("operation/resource bounds and age retention are independent; full deletion rotates identity", () => {
  const { store, telemetry, root, storage } = fixture();
  const before = store.enable({ operationLimit: 3, runtimeLimit: 2 });
  for (let i = 0; i < 8; i++) new Telemetry(root, "mcp", storage).record(event);
  expect(store.events().filter((e) => e.kind === "operation")).toHaveLength(3);
  expect(store.events().filter((e) => e.kind === "runtime")).toHaveLength(2);
  const db = new Database(join(storage, "usage.sqlite"));
  db.exec("UPDATE events SET time=0");
  db.close();
  expect(store.events()).toEqual([]);
  telemetry.record(event);
  store.delete(true);
  expect(store.events(true)).toEqual([]);
  expect(store.enable().project).not.toBe(before.project);
});
test("busy store drops immediately; no queued shutdown work; next append reports loss", () => {
  const { store, telemetry, storage } = fixture();
  store.enable();
  const db = new Database(join(storage, "usage.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  expect(store.status().enabled).toBe(true);
  expect(store.events()).toEqual([]);
  const start = performance.now();
  telemetry.record(event);
  expect(performance.now() - start).toBeLessThan(100);
  db.exec("ROLLBACK");
  db.close();
  telemetry.record(event);
  expect(store.events().find((e) => e.kind === "operation")?.dropped).toBe(1);
});
test("inaccessible storage and project-local storage cannot affect observations", () => {
  const { root, storage } = fixture();
  writeFileSync(storage, "not a directory");
  expect(() => new Telemetry(root, "cli", storage).record(event)).not.toThrow();
  expect(() => new TelemetryStore(root, join(root, "events"))).toThrow(
    "outside",
  );
  expect(() =>
    new Telemetry(root, "cli", join(root, "events")).record(event),
  ).not.toThrow();
});
test("concurrent processes cannot corrupt storage or exceed retention", async () => {
  const { root, storage, store } = fixture();
  store.enable({ operationLimit: 30 });
  const source = `import { Telemetry } from ${JSON.stringify(join(import.meta.dir, "telemetry.ts"))}; const t=new Telemetry(${JSON.stringify(root)},'cli',${JSON.stringify(storage)}); for(let i=0;i<30;i++) t.record(${JSON.stringify(event)});`;
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, "-e", source], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    ).map(async (p) => ({
      exit: await p.exited,
      stderr: await new Response(p.stderr).text(),
    })),
  );
  expect(results).toEqual(
    Array.from({ length: 4 }, () => ({ exit: 0, stderr: "" })),
  );
  const events = store.events();
  expect(events.length).toBeGreaterThan(0);
  expect(
    events.filter((e) => e.kind === "operation").length,
  ).toBeLessThanOrEqual(30);
  const db = new Database(join(storage, "usage.sqlite"));
  expect(db.query("PRAGMA integrity_check").get()).toEqual({
    integrity_check: "ok",
  });
  db.close();
});

test("async-local work counts do not mix concurrent operations", async () => {
  const { observeOperation } = await import("./telemetry");
  const { recordWork } = await import("./work-metrics");
  const { store, telemetry } = fixture();
  store.enable();
  await Promise.all(
    [1, 10].map((n) =>
      observeOperation(
        telemetry,
        "search",
        async () => {
          recordWork("parse", n);
          await Bun.sleep(2);
          recordWork("searchDocument", n);
        },
        { attribution: { workflow: String(n) } },
      ),
    ),
  );
  const work = store
    .events()
    .filter((e) => e.kind === "operation")
    .map((e) => e.work?.parse)
    .sort((a, b) => (a ?? 0) - (b ?? 0));
  expect(work).toEqual([1, 10]);
});

test("per-request attribution overrides launch defaults; invalid claims stay unknown", () => {
  const { store, telemetry } = fixture();
  store.enable();
  telemetry.record(event, {
    actor: "agent",
    host: "cursor",
  });
  telemetry.record(event, {
    actor: "not-an-actor",
    host: "codex",
  });
  telemetry.record(event, {
    actor: "human",
    host: "claude",
  });
  const ops = store.events().filter((e) => e.kind === "operation");
  expect(ops.map((e) => [e.actor, e.host])).toEqual([
    ["agent", "cursor"],
    ["unknown", "codex"],
    ["human", "claude"],
  ]);
});

test("explicit request claims beat launch defaults and do not fall back when invalid", () => {
  expect(
    resolveAttribution({
      launch: { actor: "agent", host: "cursor" },
      request: { actor: "human", host: "claude" },
    }),
  ).toEqual({ actor: "human", host: "claude" });
  expect(
    resolveAttribution({
      launch: { actor: "agent", host: "cursor" },
      request: { actor: "nope" },
    }),
  ).toEqual({ actor: "nope", host: "cursor" });
  expect(
    resolveAttribution({
      launch: { actor: "agent", host: "codex", trigger: "explicit" },
    }),
  ).toEqual({ actor: "agent", host: "codex", trigger: "explicit" });
});

test("MCP meta ignores launch workflow so a long-lived process does not join unrelated work", () => {
  expect(
    attributionFromMcpMeta(undefined, {
      actor: "agent",
      host: "cursor",
      workflow: "launch-wide",
    }),
  ).toEqual({ actor: "agent", host: "cursor", trigger: "explicit" });
  expect(
    attributionFromMcpMeta(
      { "docket/workflow": "request-a" },
      { actor: "agent", host: "cursor", workflow: "launch-wide" },
    ),
  ).toEqual({
    actor: "agent",
    host: "cursor",
    trigger: "explicit",
    workflow: "request-a",
  });
});

test("optional outcome fields distinguish missing from zero and keep historical records readable", () => {
  const { store, telemetry } = fixture();
  store.enable();
  telemetry.record(event);
  telemetry.record({
    ...event,
    resultCount: 0,
    resultTotal: 0,
    truncated: "none",
    saveState: "unchanged",
  });
  const ops = store
    .events()
    .filter((entry) => entry.kind === "operation")
    .slice(-2);
  expect(ops[0]?.resultCount).toBeNull();
  expect(ops[0]?.saveState).toBeNull();
  expect(ops[1]?.resultCount).toBe(0);
  expect(ops[1]?.truncated).toBe("none");
  expect(ops[1]?.saveState).toBe("unchanged");
  expect(
    store.append(() => [
      {
        ...ops[0],
        resultCount: "PRIVATE",
      },
    ]),
  ).toBe("dropped");
});
