import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, setPriority, setRank } from "@gitdocket/core";
import { createRepoContext, type RepoContext } from "./state";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
const task = (title = "Task", status = "todo") =>
  "---\ntype: Task\nid: DKT-1\ntitle: " +
  title +
  "\nstatus: " +
  status +
  "\n---\nBody\n";
async function fixture(onBuild?: () => void) {
  const root = await mkdtemp(join(tmpdir(), "docket-state-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "task.md"), task());
  const ctx = createRepoContext(root, parseConfig("bundle: docs/"), {
    onBuild,
  });
  cleanup.push(() => ctx.close());
  return { root, ctx };
}
const status = (ctx: Awaited<ReturnType<RepoContext["acquire"]>>) =>
  ctx.state.db.query("SELECT status FROM concepts WHERE id='DKT-1'").get();

test("cold readers share one build; unchanged and after-idle reads reuse the published generation", async () => {
  let builds = 0;
  const { ctx } = await fixture(() => builds++);
  const leases = await Promise.all(
    Array.from({ length: 4 }, () => ctx.acquire()),
  );
  expect(builds).toBe(1);
  expect(new Set(leases.map((lease) => lease.state)).size).toBe(1);
  for (const lease of leases) lease.release();
  await Bun.sleep(25);
  const first = await ctx.state();
  const second = await ctx.refresh();
  expect(second).toBe(first);
  expect(builds).toBe(1);
});

test("background checks preserve fast reads while explicit invalidation waits for current state", async () => {
  const { root, ctx } = await fixture();
  const original = await ctx.state();
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const version = ctx.store.version.bind(ctx.store);
  let once = true;
  ctx.store.version = async (path) => {
    if (once) {
      once = false;
      enter();
      await gate;
    }
    return version(path);
  };
  await writeFile(join(root, "docs", "task.md"), task("Changed outside"));
  const refresh = ctx.refresh({ background: true });
  await entered;
  const warm = await ctx.acquire();
  expect(warm.state).toBe(original);
  warm.release();
  ctx.invalidate(["task.md"]);
  let delivered = false;
  const current = ctx.acquire().then((lease) => {
    delivered = true;
    return lease;
  });
  await Bun.sleep(10);
  expect(delivered).toBeFalse();
  resume();
  await refresh;
  const lease = await current;
  expect(lease.state.bundle.byId("DKT-1")?.fm.title).toBe("Changed outside");
  lease.release();
});

test("close while configuration is being read prevents publication and mutation", async () => {
  const { root } = await fixture();
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ctx = createRepoContext(root, parseConfig("bundle: docs/"), {
    loadConfig: async () => {
      enter();
      await gate;
      return parseConfig("bundle: other/");
    },
  });
  cleanup.push(() => ctx.close());
  const read = ctx.state();
  let wrote = false;
  const write = ctx.mutate(async () => {
    wrote = true;
  });
  await entered;
  ctx.close();
  resume();
  expect(
    (await Promise.allSettled([read, write])).every(
      (result) => result.status === "rejected",
    ),
  ).toBeTrue();
  expect(wrote).toBeFalse();
});

test("an older leased database survives refresh and closes only after release", async () => {
  const { root, ctx } = await fixture();
  const first = await ctx.acquire();
  await writeFile(join(root, "docs", "task.md"), task("New", "in-progress"));
  ctx.invalidate(["task.md"]);
  const second = await ctx.acquire();
  expect(status(first)).toEqual({ status: "todo" });
  expect(status(second)).toEqual({ status: "in-progress" });
  expect(first.state.sources.get("task.md")).toContain("title: Task");
  expect(second.state.sources.get("task.md")).toContain("title: New");
  first.release();
  first.release();
  expect(() => status(first)).toThrow();
  ctx.close();
  expect(status(second)).toEqual({ status: "in-progress" });
  second.release();
  expect(() => status(second)).toThrow();
});

test("invalidations during a blocked file read converge without publishing the superseded state", async () => {
  const { root, ctx } = await fixture();
  await ctx.state();
  const observed: string[] = [];
  ctx.subscribe(() => {
    observed.push("published");
  });
  let entered!: () => void;
  let resume!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const read = ctx.store.read.bind(ctx.store);
  let once = true;
  ctx.store.read = async (path) => {
    const source = await read(path);
    if (once && path === "task.md") {
      once = false;
      entered();
      await gate;
    }
    return source;
  };
  await writeFile(join(root, "docs", "task.md"), task("Intermediate"));
  ctx.invalidate(["task.md"]);
  const first = ctx.acquire();
  await blocked;
  await writeFile(join(root, "docs", "task.md"), task("Latest"));
  ctx.invalidate(["task.md"]);
  const second = ctx.acquire();
  resume();
  const [a, b] = await Promise.all([first, second]);
  expect(a.state).toBe(b.state);
  expect(a.state.bundle.byId("DKT-1")?.fm.title).toBe("Latest");
  expect(observed).toHaveLength(1);
  a.release();
  b.release();
});

test("failed refresh retains explicit last-known state, retries, and shutdown rejects pending publication", async () => {
  const { root, ctx } = await fixture();
  const before = await ctx.state();
  await rename(join(root, "docs"), join(root, "hidden"));
  await expect(ctx.refresh()).rejects.toThrow();
  const stale = await ctx.acquire();
  expect(stale.state).toBe(before);
  expect(stale.error).toBeDefined();
  stale.release();
  await rename(join(root, "hidden"), join(root, "docs"));
  expect(await ctx.refresh()).toBe(before);
  const pending = ctx.refresh();
  ctx.close();
  await expect(pending).rejects.toThrow();
  await expect(ctx.acquire()).rejects.toThrow("closed");
});

test("configuration replacement keeps old readers coherent and mutations target the current root", async () => {
  const { root, ctx } = await fixture();
  const before = await ctx.acquire();
  await mkdir(join(root, "next"));
  await writeFile(
    join(root, "next", "task.md"),
    task("Other root").replace("DKT-1", "NEW-1"),
  );
  await writeFile(join(root, "docket.yaml"), "project: NEW\nbundle: next/\n");
  await ctx.refresh();
  const after = await ctx.acquire();
  expect(before.state.config.project).toBe("DKT");
  expect(before.state.store.root).toBe(join(root, "docs/"));
  expect(after.state.config.project).toBe("NEW");
  expect(after.state.sources.get("task.md")).toContain("Other root");
  await Promise.all([
    ctx.mutate((store, config) => setPriority(store, config, "NEW-1", "p0")),
    ctx.mutate((store, config) => setRank(store, config, "NEW-1", 3)),
  ]);
  const latest = await ctx.acquire();
  expect(latest.state.bundle.byId("NEW-1")?.fm).toMatchObject({
    priority: "p0",
    rank: 3,
  });
  expect(await Bun.file(join(root, "docs", "task.md")).text()).not.toContain(
    "priority:",
  );
  before.release();
  after.release();
  latest.release();
});

test("partial write failures invalidate already-written files; invalid config cannot authorize a write", async () => {
  const { root, ctx } = await fixture();
  await ctx.state();
  await expect(
    ctx.mutate(async (store) => {
      await store.write("task.md", task("Applied"));
      throw new Error("later step failed");
    }),
  ).rejects.toThrow("later step failed");
  const lease = await ctx.acquire();
  expect(lease.state.bundle.byId("DKT-1")?.fm.title).toBe("Applied");
  lease.release();
  await writeFile(join(root, "docket.yaml"), "bundle: [invalid");
  let attempted = false;
  await expect(
    ctx.mutate(async () => {
      attempted = true;
    }),
  ).rejects.toThrow();
  expect(attempted).toBeFalse();
});

test("verification files outside the bundle participate in reconciliation", async () => {
  const { root, ctx } = await fixture();
  await writeFile(
    join(root, "docket.yaml"),
    "bundle: docs/\nverify:\n  tests: [test.ts]\n",
  );
  const before = await ctx.refresh();
  expect(
    before.db.query("SELECT count(*) AS count FROM verifications").get(),
  ).toEqual({ count: 0 });
  await writeFile(join(root, "test.ts"), "// docket:verifies /task.md\n");
  const after = await ctx.refresh();
  expect(after.bundle).toBe(before.bundle);
  expect(
    after.db.query("SELECT count(*) AS count FROM verifications").get(),
  ).toEqual({ count: 1 });
});
