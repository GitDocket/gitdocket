import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStore, parseConfig } from "@gitdocket/core";
import { refreshIndex } from "./indexing";

let root: string, store: LocalFileStore;
const config = parseConfig(
  "project: FIX\nbundle: docket\nverify:\n  tests: ['tests/*.ts']\n",
);
const source = (status = "todo", body = "Original.") =>
  `---\ntype: Task\nid: FIX-1\ntitle: Original\nstatus: ${status}\n---\n\n${body}\n`;
const git = (...args: string[]) => {
  const p = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      ...args,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(p.exitCode).toBe(0);
};
const refresh = (options = {}) => refreshIndex(root, store, config, options);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-index-refresh-"));
  await mkdir(join(root, "docket"));
  await mkdir(join(root, "tests"));
  store = new LocalFileStore(join(root, "docket"));
  await store.write("task.md", source());
  await store.write(
    "spec.md",
    "---\ntype: Spec\ntitle: Specification\n---\n\nContract.\n",
  );
  await writeFile(
    join(root, "tests/one.ts"),
    `// ${"docket:" + "verifies"} /spec.md\n`,
  );
  git("init");
  git("add", "docket");
  git("commit", "-m", "Baseline", "-m", "Task: FIX-1");
});
afterEach(() => rm(root, { recursive: true, force: true }));
test("fresh equal observations avoid physical cache/index writes; force rebuild remains explicit", async () => {
  expect((await refresh()).cache).toBe("rebuilt");
  const path = join(root, ".docket/cache.sqlite");
  const before = await stat(path);
  const bytes = await readFile(path);
  const same = await refresh();
  expect(same).toMatchObject({
    changed: false,
    indexChanged: false,
    cache: "unchanged",
    refresh: {
      git: "available",
      work: {
        markerScans: 1,
        gitScans: 1,
        cacheBuilds: 0,
        indexWrites: 0,
        cacheWrites: 0,
      },
    },
  });
  expect(await readFile(path)).toEqual(bytes);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  expect((await refresh({ rebuild: true })).refresh).toMatchObject({
    reason: "requested-rebuild",
    work: { cacheBuilds: 1, cacheWrites: 2 },
  });
});
test("source bytes, task state, marker changes, Git history and configuration refresh independent cache inputs", async () => {
  await refresh();
  await store.write("task.md", source("todo", "Changed body."));
  expect(await refresh()).toMatchObject({
    indexChanged: false,
    cache: "rebuilt",
  });
  await store.write("task.md", source("done"));
  expect(await refresh()).toMatchObject({
    indexChanged: true,
    cache: "rebuilt",
  });
  await writeFile(join(root, "tests/one.ts"), "// No markers.\n");
  expect(await refresh()).toMatchObject({
    indexChanged: false,
    cache: "rebuilt",
    verifyMarkerCount: 0,
  });
  git("commit", "--allow-empty", "-m", "Another activity", "-m", "Task: FIX-1");
  expect((await refresh()).cache).toBe("rebuilt");
  let db = new Database(join(root, ".docket/cache.sqlite"), { readonly: true });
  expect(db.query("SELECT count(*) AS count FROM activity").get()).toEqual({
    count: 2,
  });
  db.close();
  const other = parseConfig(
    "project: FIX\nbundle: docket\ngit:\n  trailer: Work\n",
  );
  expect((await refreshIndex(root, store, other)).cache).toBe("rebuilt");
  db = new Database(join(root, ".docket/cache.sqlite"), { readonly: true });
  expect(db.query("SELECT count(*) AS count FROM activity").get()).toEqual({
    count: 0,
  });
  db.close();
  await refresh();
  git("branch", "another-ref");
  expect((await refresh()).refresh.work.gitScans).toBe(1);
});
test("corrupt/missing receipts and altered cache bytes cannot justify reuse; staged failure preserves prior cache and retry recovers", async () => {
  await refresh();
  const cache = join(root, ".docket/cache.sqlite"),
    receipt = join(root, ".docket/cache-refresh.json");
  const before = await readFile(cache);
  const oldReceipt = await readFile(receipt);
  await store.write("task.md", source("done"));
  await expect(
    refresh({
      beforePublish: async () => {
        throw new Error("Interrupted before publication");
      },
    }),
  ).rejects.toThrow("Interrupted");
  expect(await readFile(cache)).toEqual(before);
  expect(await readFile(receipt)).toEqual(oldReceipt);
  expect((await refresh()).cache).toBe("rebuilt");
  expect((await refresh()).cache).toBe("unchanged");
  await store.write("task.md", source("todo", "Later source."));
  await expect(
    refresh({
      afterCachePublish: async () => {
        throw new Error("Interrupted after cache publication");
      },
    }),
  ).rejects.toThrow("Interrupted after");
  expect((await refresh()).cache).toBe("rebuilt");
  expect((await refresh()).cache).toBe("unchanged");
  await writeFile(cache, "Corrupt cache");
  expect((await refresh()).cache).toBe("rebuilt");
  await writeFile(receipt, "{}");
  expect((await refresh()).cache).toBe("rebuilt");
  await rm(receipt);
  expect((await refresh()).cache).toBe("rebuilt");
});
test("unavailable Git never produces an unchanged freshness claim", async () => {
  await rm(join(root, ".git"), { recursive: true });
  await refresh();
  expect(await refresh()).toMatchObject({
    cache: "rebuilt",
    refresh: { git: "unavailable", reason: "changed-or-unavailable-evidence" },
  });
});
test("the actual CLI check is read-only, JSON no-op is bounded, and rebuild forces cache work", async () => {
  await writeFile(join(root, "docket.yaml"), "project: FIX\nbundle: docket\n");
  const cli = (...args: string[]) =>
    Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "index.ts"),
        "index",
        ...args,
        "--json",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
  const stale = cli("--check");
  expect(stale.exitCode).toBe(1);
  expect(JSON.parse(stale.stdout.toString()).stale).toBe(true);
  await expect(stat(join(root, ".docket/cache.sqlite"))).rejects.toThrow();
  expect(cli().exitCode).toBe(0);
  const same = cli();
  expect(same.exitCode).toBe(0);
  expect(JSON.parse(same.stdout.toString())).toMatchObject({
    changed: false,
    cache: "unchanged",
    refresh: { work: { cacheBuilds: 0 } },
  });
  expect(same.stdout.byteLength).toBeLessThan(8193);
  expect(JSON.parse(cli("--rebuild").stdout.toString()).cache).toBe("rebuilt");
  expect(cli("--check", "--rebuild").exitCode).toBe(1);
});
