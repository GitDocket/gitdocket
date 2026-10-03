import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig } from "./config";
import { InMemoryFileStore, LocalFileStore } from "./filestore";
import { editWorkItem, TaskEditError } from "./ops";

const path = "work/tasks/item.md";
const source = `---\ntype: Task\nid: DKT-1\naliases: [DKT-9]\nstatus: todo\npriority: 'p2' # keep the priority note\ncustom:\n  nested: 'unchanged' # nested note\ntimestamp: 2026-09-30T00:00:00Z\n---\n\n# Context\n\nPreserve this body.\n`;
const epic = "---\ntype: Epic\nid: DKT-2\nstatus: todo\n---\n";
const config = parseConfig();
const version = (text: string) =>
  createHash("sha256").update(text).digest("hex");
class Store extends InMemoryFileStore {
  writes = 0;
  constructor() {
    super(
      new Map([
        [path, source],
        ["work/epics/epic.md", epic],
      ]),
    );
  }
  override async write(p: string, text: string) {
    this.writes++;
    await super.write(p, text);
  }
}
test("invalid later fields never apply valid earlier changes", async () => {
  const store = new Store();
  for (const patch of [
    { priority: "p1", epic: "/missing.md" },
    { priority: "p1", rank: Infinity },
    { priority: "p1", epic: "" },
    { priority: "p1", unknown: true },
  ]) {
    const error = await editWorkItem(store, config, "DKT-1", patch).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(TaskEditError);
    expect(error.receipt()).toMatchObject({
      error: { code: "invalid-request" },
      mutation: "unchanged",
    });
    expect(await store.read(path)).toBe(source);
  }
  expect(store.writes).toBe(0);
});
test("one complete update preserves comments, quoting, body and timestamps; an equivalent retry is a no-op", async () => {
  const store = new Store();
  const patch = { priority: "p1", rank: 2.5, epic: "/work/epics/epic.md" };
  const result = await editWorkItem(
    store,
    config,
    "DKT-9",
    patch,
    version(source),
  );
  expect(result).toMatchObject({
    id: "DKT-1",
    changed: true,
    mutation: "applied",
    priority: { from: "p2", to: "p1" },
    rank: { from: null, to: 2.5 },
  });
  expect(store.writes).toBe(1);
  const saved = await store.read(path);
  expect(saved).toContain("priority: 'p1' # keep the priority note");
  expect(saved).toContain("custom:\n  nested: 'unchanged' # nested note");
  expect(saved).toContain("timestamp: 2026-09-30T00:00:00Z");
  expect(saved.split("\n---\n")[1]).toBe(source.split("\n---\n")[1]);
  expect(result.version).toBe(version(saved));
  expect(
    await editWorkItem(store, config, "DKT-1", patch, result.version),
  ).toMatchObject({
    changed: false,
    mutation: "unchanged",
    version: result.version,
  });
  expect(store.writes).toBe(1);
  expect(
    await editWorkItem(store, config, "DKT-1", { priority: "p1", rank: 7 }),
  ).toMatchObject({
    changed: true,
    priority: { from: "p1", to: "p1" },
    rank: { to: 7 },
  });
});
test("clearing a field retains its inline comment as authored commentary", async () => {
  const store = new Store();
  store.files.set(
    path,
    source.replace("custom:", "rank: 2 # retain this note\ncustom:"),
  );
  await editWorkItem(store, config, "DKT-1", { rank: null });
  expect(await store.read(path)).toContain("# retain this note\ncustom:");
  expect(await store.read(path)).not.toContain("rank:");
});
test("CRLF source keeps its line endings during scalar replacement and insertion", async () => {
  const store = new Store();
  store.files.set(path, source.replaceAll("\n", "\r\n"));
  await editWorkItem(store, config, "DKT-1", { priority: "p0", rank: 2 });
  const saved = await store.read(path);
  expect(saved).toContain(
    "priority: 'p0' # keep the priority note\r\nrank: 2\r\n",
  );
  expect(saved.replaceAll("\r\n", "")).not.toContain("\n");
});

test("clearing a block-style epic preserves its comment and the following field", async () => {
  const store = new Store();
  store.files.set(
    path,
    source.replace(
      "priority:",
      "epic: >- # retain this epic note\n  /work/epics/epic.md\npriority:",
    ),
  );
  await editWorkItem(store, config, "DKT-1", { epic: null });
  expect(await store.read(path)).toContain(
    "# retain this epic note\npriority: 'p2' # keep the priority note",
  );
  expect(await store.read(path)).toContain("custom:\n  nested:");
});

test("stale versions and concurrent non-cooperating edits do not get overwritten", async () => {
  const store = new Store();
  await expect(
    editWorkItem(store, config, "DKT-1", { priority: "p0" }, "0".repeat(64)),
  ).rejects.toMatchObject({ code: "source-conflict", mutation: "unchanged" });
  class ChangingStore extends Store {
    reads = 0;
    override async read(p: string) {
      if (p === path && ++this.reads === 3)
        this.files.set(path, `${source}\nExternal edit.\n`);
      return super.read(p);
    }
  }
  const changing = new ChangingStore();
  await expect(
    editWorkItem(changing, config, "DKT-1", { priority: "p0" }),
  ).rejects.toMatchObject({ code: "source-conflict", mutation: "unchanged" });
  expect(changing.writes).toBe(0);
  expect(await changing.read(path)).toContain("External edit.");
});
test("write failures distinguish observed original, applied, different and unreadable source without claiming rollback", async () => {
  for (const mode of ["before", "after", "partial", "unreadable"] as const) {
    class Failing extends Store {
      attempted = false;
      override async write(p: string, text: string) {
        this.attempted = true;
        if (mode === "after") this.files.set(p, text);
        if (mode === "partial") this.files.set(p, text.slice(0, 25));
        throw new Error("simulated interrupted write");
      }
      override async read(p: string) {
        if (this.attempted && mode === "unreadable")
          throw new Error("unreadable");
        return super.read(p);
      }
    }
    const store = new Failing();
    const failure = await editWorkItem(store, config, "DKT-1", {
      priority: "p0",
      rank: 3,
    }).catch((e) => e);
    expect(failure).toMatchObject({
      code: "write-failed",
      mutation:
        mode === "before"
          ? "unchanged"
          : mode === "after"
            ? "applied"
            : "unknown",
    });
    expect(failure.receipt().recovery).toBeDefined();
  }
});
test("a lock-release failure after a successful write never reports unchanged", async () => {
  class ReleaseFailure extends Store {
    async withMutation<T>(operation: () => Promise<T>): Promise<T> {
      await operation();
      throw new Error("release failed");
    }
  }
  const store = new ReleaseFailure();
  await expect(
    editWorkItem(store, config, "DKT-1", { priority: "p0" }),
  ).rejects.toMatchObject({ code: "unavailable", mutation: "applied" });
  expect(await store.read(path)).toContain("priority: 'p0'");
});
test("separate cooperating filesystem stores serialize disjoint complete patches", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-atomic-fields-"));
  try {
    await mkdir(join(root, "work/tasks"), { recursive: true });
    await writeFile(join(root, path), source);
    await Promise.all([
      editWorkItem(new LocalFileStore(root), config, "DKT-1", {
        priority: "p0",
      }),
      editWorkItem(new LocalFileStore(root), config, "DKT-1", { rank: 11 }),
    ]);
    const saved = await readFile(join(root, path), "utf8");
    expect(saved).toContain("priority: 'p0'");
    expect(saved).toContain("rank: 11");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("CLI rejects conflicting flags and an invalid later field with structured unchanged receipts and no marker changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-atomic-cli-"));
  try {
    await mkdir(join(root, "docket/work/tasks"), { recursive: true });
    await mkdir(join(root, ".docket"));
    await writeFile(
      join(root, "docket.yaml"),
      "project: DKT\nbundle: docket\n",
    );
    await writeFile(join(root, "docket", path), source);
    await writeFile(join(root, ".docket/active-task"), "DKT-99\n");
    const call = async (...args: string[]) => {
      const p = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../cli/src/index.ts"),
          "task",
          "edit",
          "DKT-1",
          ...args,
          "--json",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [code, out, err] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      expect(err).toBe("");
      return { code, data: JSON.parse(out) };
    };
    for (const args of [
      ["--priority", "p1", "--epic", "/missing.md"],
      ["--rank", "1", "--clear-rank"],
      ["--epic", "/missing.md", "--clear-epic"],
      ["--priority", "p1", "--rank", "NaN"],
    ]) {
      expect(await call(...args)).toMatchObject({
        code: 1,
        data: { error: { code: "invalid-request" }, mutation: "unchanged" },
      });
      expect(await readFile(join(root, "docket", path), "utf8")).toBe(source);
      expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
        "DKT-99\n",
      );
    }
    const first = await call("--priority", "p1", "--rank", "4");
    expect(first).toMatchObject({
      code: 0,
      data: { changed: true, mutation: "applied" },
    });
    expect(
      await call(
        "--priority",
        "p1",
        "--rank",
        "4",
        "--expected-version",
        first.data.version,
      ),
    ).toMatchObject({ code: 0, data: { changed: false } });
    expect(
      await call("--priority", "p0", "--expected-version", version(source)),
    ).toMatchObject({
      code: 1,
      data: { error: { code: "source-conflict" }, mutation: "unchanged" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
