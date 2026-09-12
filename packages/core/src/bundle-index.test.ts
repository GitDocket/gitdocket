import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle } from "./bundle";
import { BundleIndex } from "./bundle-index";
import { parseConfig } from "./config";
import { InMemoryFileStore, LocalFileStore } from "./filestore";
import { renderIndex } from "./indexmd";
import { lintBundle } from "./lint";
import { searchBundle } from "./search";
import { observeWork } from "./work-metrics";

const config = parseConfig();
const source = (
  id: number,
  status = "todo",
  body = "navigation storage",
  dep = "",
) =>
  `---\ntype: Task\nid: DKT-${id}\ntitle: Task ${id}\nstatus: ${status}\naliases: [OLD-${id}]\ndepends_on: [${dep}]\n---\n${body}\n`;

test("reserved structural files cause no concept reads or parses", async () => {
  const files = new InMemoryFileStore(
    new Map([
      ["a.md", source(1)],
      ["log.md", "unused"],
      ["nested/index.md", "unused"],
    ]),
  );
  const reads: string[] = [];
  const store = {
    ...files,
    list: () => files.list(),
    read: async (path: string) => {
      reads.push(path);
      return files.read(path);
    },
    write: (path: string, body: string) => files.write(path, body),
  };
  let parses = 0;
  const stop = observeWork((metric) => {
    if (metric === "parse") parses++;
  });
  try {
    expect((await loadBundle(store, config)).concepts).toHaveLength(1);
    expect(reads).toEqual(["a.md"]);
    expect(parses).toBe(1);
  } finally {
    stop();
  }
});

test("randomized edits preserve fresh graph, diagnostics, readiness, index and search", async () => {
  const files = new Map(
    Array.from({ length: 24 }, (_, i) => [
      `${String(i).padStart(2, "0")}.md`,
      source(i + 1, i % 3 ? "todo" : "done"),
    ]),
  );
  files.set("log.md", "# Log\n\n2026-09-11 DKT-1 navigation storage\nCafé\n");
  const store = new InMemoryFileStore(files);
  const index = new BundleIndex(store);
  const queries = [
    "navig stor",
    "dkt",
    "DKT-1",
    "dkt1",
    "DKT 1",
    "1",
    "#1",
    "OLD-1",
    "old1",
    "cafe",
    "caf",
    "—",
    "missing",
    "task todo",
    "nonexistent navigation",
  ];
  let seed = 142;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let round = 0; round < 35; round++) {
    const path = `${String(random() % 24).padStart(2, "0")}.md`;
    const id = (random() % 25) + 1;
    switch (round % 7) {
      case 0:
        files.set(
          path,
          source(id, "done", "[neighbor](/02.md) navig storage\nstorage navig"),
        );
        break;
      case 1:
        files.delete(path);
        break;
      case 2:
        files.set(path, "---\ntype: Task\nid: [bad\n---\n");
        break;
      case 3:
        files.set(path, source(1, "todo", "storage storage storage", "OLD-2"));
        break;
      case 4:
        files.set(path, source(id, "closed", "navig", "DKT-3"));
        break;
      case 5:
        files.set(`${path}-renamed.md`, files.get(path) ?? source(id));
        files.delete(path);
        break;
      case 6:
        files.set(
          "log.md",
          `# Log\n2026-09-11 DKT-${id} source change ${round}\n`,
        );
        break;
    }
    const currentConfig =
      round % 9 === 0 ? parseConfig("project: APP") : config;
    const snapshot = await index.refresh(currentConfig);
    const fresh = await loadBundle(store, currentConfig);
    expect(snapshot.bundle.concepts).toEqual(fresh.concepts);
    expect(snapshot.bundle.diagnostics).toEqual(fresh.diagnostics);
    expect(snapshot.bundle.statusById).toEqual(fresh.statusById);
    expect(snapshot.bundle.readyIds()).toEqual(fresh.readyIds());
    expect(renderIndex(snapshot.bundle)).toEqual(renderIndex(fresh));
    expect(await lintBundle(store, snapshot.bundle)).toEqual(
      await lintBundle(store, fresh),
    );
    for (const query of queries) {
      expect(snapshot.search.search(query, { limit: 5 })).toEqual(
        await searchBundle(store, fresh, query, { limit: 5 }),
      );
    }
  }
  index.close();
});

test("local versions detect rapid same-size writes and atomic replacement; warm refresh reads nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-incremental-"));
  class CountingStore extends LocalFileStore {
    reads = 0;
    override read(path: string) {
      this.reads++;
      return super.read(path);
    }
  }
  const store = new CountingStore(root);
  const index = new BundleIndex(store);
  let parses = 0;
  const stop = observeWork((metric) => {
    if (metric === "parse") parses++;
  });
  try {
    await store.write("a.md", source(1));
    await store.write("b.md", source(2, "todo", "body", "DKT-1"));
    const first = await index.refresh(config);
    expect(parses).toBe(2);
    store.reads = 0;
    parses = 0;
    expect(await index.refresh(config)).toBe(first);
    expect(store.reads).toBe(0);
    expect(parses).toBe(0);
    await store.write("a.md", source(1, "done")); // same byte length
    const second = await index.refresh(config);
    expect(store.reads).toBe(1);
    expect(parses).toBe(1);
    expect(second.bundle.readyIds()).toEqual(["DKT-2"]);
    expect(second.bundle.byId("DKT-2")).toBe(first.bundle.byId("DKT-2"));
    expect(first.bundle.readyIds()).toEqual(["DKT-1"]); // reader remains coherent
    await writeFile(join(root, "swap"), source(9));
    await rename(join(root, "swap"), join(root, "a.md"));
    const third = await index.refresh(config);
    expect(third.bundle.byId("DKT-1")).toBeUndefined();
    expect(third.search.search("DKT9")[0]?.id).toBe("DKT-9");
    await rename(join(root, "a.md"), join(root, "new.md"));
    await rm(join(root, "b.md"));
    const fourth = await index.refresh(config);
    expect(fourth.bundle.concepts.map((c) => c.path)).toEqual(["new.md"]);
    expect(fourth.search.search("9")[0]?.path).toBe("new.md");
    expect(third.search.search("9")[0]?.path).toBe("a.md");
  } finally {
    stop();
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded reads, failed builds, and close never publish partial generations", async () => {
  class Store extends InMemoryFileStore {
    active = 0;
    peak = 0;
    fail = false;
    override async read(path: string) {
      this.active++;
      this.peak = Math.max(this.active, this.peak);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (this.fail && path === "2.md") throw new Error("read failed");
        return await super.read(path);
      } finally {
        this.active--;
      }
    }
  }
  const store = new Store(
    new Map(Array.from({ length: 40 }, (_, i) => [`${i}.md`, source(i + 1)])),
  );
  const index = new BundleIndex(store);
  const first = await index.refresh(config);
  expect(store.peak).toBeGreaterThan(1);
  expect(store.peak).toBeLessThanOrEqual(16);
  store.fail = true;
  await expect(index.refresh(config)).rejects.toThrow("read failed");
  expect(index.snapshot).toBe(first);
  expect(store.active).toBe(0);
  store.fail = false;
  expect(await index.refresh(config)).toBe(first);
  const pending = index.refresh(config);
  index.close();
  await expect(pending).rejects.toThrow();
  expect(index.snapshot).toBeUndefined();
});

test("search preserves collating path ties and empty generic neighbor IDs after edits", async () => {
  const store = new InMemoryFileStore(
    new Map([
      ["e\u0301.md", source(1, "todo", "shared [empty](/empty.md)")],
      ["é.md", source(2, "todo", "shared")],
      ["empty.md", '---\ntype: Note\nid: ""\ntitle: Empty\n---\nshared'],
    ]),
  );
  const index = new BundleIndex(store);
  for (let round = 0; round < 2; round++) {
    const snapshot = await index.refresh(config);
    expect(snapshot.search.search("shared")).toEqual(
      await searchBundle(store, await loadBundle(store, config), "shared"),
    );
    await store.write(
      "e\u0301.md",
      `${await store.read("e\u0301.md")}\nchanged`,
    );
  }
  index.close();
});

test("close during a file read drains the batch and prevents publication", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class Store extends InMemoryFileStore {
    override async read(path: string) {
      entered.resolve();
      await release.promise;
      return super.read(path);
    }
  }
  const index = new BundleIndex(new Store(new Map([["a.md", source(1)]])));
  const pending = index.refresh(config);
  await entered.promise;
  index.close();
  release.resolve();
  await expect(pending).rejects.toThrow();
  expect(index.snapshot).toBeUndefined();
});

test("exact event paths avoid unrelated metadata reads; full reconciliation recovers missed events", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-events-"));
  class Store extends LocalFileStore {
    versions: string[] = [];
    override version(path: string) {
      this.versions.push(path);
      return super.version(path);
    }
  }
  const store = new Store(root);
  const index = new BundleIndex(store);
  try {
    await store.write("a.md", source(1));
    await store.write("b.md", source(2));
    await index.refresh(config);
    await store.write(".hidden.md", source(999));
    expect(
      (
        await index.refresh(config, { changedPaths: [".hidden.md"] })
      ).bundle.byId("DKT-999"),
    ).toBeUndefined();
    store.versions = [];
    await store.write("a.md", source(1, "done"));
    const changed = await index.refresh(config, { changedPaths: ["a.md"] });
    expect(changed.bundle.readyIds()).toEqual(["DKT-2"]);
    expect(new Set(store.versions)).toEqual(new Set(["a.md"]));
    await store.write("b.md", source(2, "done")); // missed event
    expect(
      (await index.refresh(config, { changedPaths: [] })).bundle.readyIds(),
    ).toEqual(["DKT-2"]);
    expect((await index.refresh(config)).bundle.readyIds()).toEqual([]);
    await rename(join(root, "a.md"), join(root, "new.md"));
    const renamed = await index.refresh(config, {
      changedPaths: ["a.md", "new.md"],
    });
    expect(renamed.bundle.concepts.map((item) => item.path)).toEqual([
      "b.md",
      "new.md",
    ]);
    expect(renamed.bundle.concepts).toEqual(
      (await loadBundle(store, config)).concepts,
    );
    await store.write("nested/a.md", source(50));
    await index.refresh(config, { changedPaths: ["nested"] });
    await rename(join(root, "nested"), join(root, "moved"));
    expect(
      (await index.refresh(config, { changedPaths: ["nested", "moved"] }))
        .bundle.concepts,
    ).toEqual((await loadBundle(store, config)).concepts);
    expect(
      (await index.refresh(parseConfig("project: APP"), { changedPaths: [] }))
        .bundle.diagnostics,
    ).toEqual(
      (await loadBundle(store, parseConfig("project: APP"))).diagnostics,
    );
  } finally {
    index.close();
    await rm(root, { recursive: true, force: true });
  }
});
