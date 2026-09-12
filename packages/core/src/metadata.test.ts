import { expect, test } from "bun:test";
import { loadBundle, loadMetadataBundle, readyWorkItems } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { parseConcept, parseMetadataConcept } from "./parse";
import { buildSchemas } from "./schema";

const config = parseConfig();
const schemas = buildSchemas(config);
const standard = `---\ntype: Task\nid: DKT-1\nstatus: todo\naliases: [OLD-1]\ncustom: yes\n---\n\n# Outcome\n\nKept [link](/spec.md).\n`;

test("metadata projection preserves canonical frontmatter, diagnostics and summaries", () => {
  const sources = [
    standard,
    standard.replaceAll("\n", "\r\n"),
    `\uFEFF${standard}`,
    standard.replaceAll("---\n", "---  \n"),
    standard.slice(0, standard.lastIndexOf("---") + 3),
    standard.replace("status: todo", "status: unknown"),
    standard.replace("custom: yes", "custom: [broken"),
    standard.replace("type: Task", "type: Decision\ncontext: custom"),
    "---\n- list\n---\nbody",
    "---\nnull\n---\nbody",
    "---\ntype: Task\nid: DKT-1\n",
    "# Heading\n---\ntype: Task\n---\n",
    `${standard}\n\`\`\`md\n---\nquoted\n---\n\`\`\`\n`,
  ];
  for (const source of sources) {
    const full = parseConcept("task.md", source, schemas);
    const projected = parseMetadataConcept("task.md", source, schemas);
    expect(projected).toEqual({
      ...full,
      ...(full.concept ? { concept: { ...full.concept, links: [] } } : {}),
    });
  }
});

test("metadata keeps canonical alias/duplicate lookup and readiness without reading history", async () => {
  const store = new InMemoryFileStore(
    new Map([
      ["a.md", standard],
      ["b.md", standard.replace("DKT-1", "DKT-2").replace("OLD-1", "DKT-1")],
      [
        "c.md",
        standard
          .replace("DKT-1", "DKT-3")
          .replace("status: todo", "status: todo\ndepends_on: [OLD-1]"),
      ],
      ["log.md", "history".repeat(10000)],
    ]),
  );
  const reads: string[] = [];
  const read = store.read.bind(store);
  store.read = async (path) => {
    reads.push(path);
    return read(path);
  };
  const full = await loadBundle(store, config);
  const projected = await loadMetadataBundle(store, config);
  expect(projected.diagnostics).toEqual(full.diagnostics);
  expect(readyWorkItems(projected).map((w) => w.fm)).toEqual(
    readyWorkItems(full).map((w) => w.fm),
  );
  for (const id of ["DKT-1", "OLD-1", "DKT-2", "missing", "", "../../task"])
    expect(projected.byId(id)?.fm).toEqual(full.byId(id)?.fm);
  expect(reads).not.toContain("log.md");
});

test("versioned metadata reuses unchanged results and revalidates edits, config, deletions and failed reads", async () => {
  const store = new (class extends InMemoryFileStore {
    reads = 0;
    fail = false;
    async version(path: string) {
      return this.files.get(path) ?? "missing";
    }
    override async read(path: string) {
      this.reads++;
      if (this.fail) throw new Error("unavailable");
      return super.read(path);
    }
  })(new Map([["a.md", standard]]));
  await loadMetadataBundle(store, config);
  store.reads = 0;
  await loadMetadataBundle(store, config);
  expect(store.reads).toBe(0);
  await store.write("a.md", standard.replace("status: todo", "status: done"));
  store.fail = true;
  await expect(loadMetadataBundle(store, config)).rejects.toThrow(
    "unavailable",
  );
  store.fail = false;
  expect(
    (await loadMetadataBundle(store, config)).byId("DKT-1")?.fm.status,
  ).toBe("done");
  store.reads = 0;
  await loadMetadataBundle(store, { ...config, project: "OTHER" });
  expect(store.reads).toBe(1);
  store.files.delete("a.md");
  expect((await loadMetadataBundle(store, config)).concepts).toHaveLength(0);
});

test("one-shot metadata reads avoid unused version/cache work and still read current source", async () => {
  const store = new (class extends InMemoryFileStore {
    async version(): Promise<string> {
      throw new Error("version should not be requested");
    }
  })(new Map([["a.md", standard]]));
  expect(
    (await loadMetadataBundle(store, config, { cache: false })).byId("DKT-1")
      ?.fm.status,
  ).toBe("todo");
  await store.write("a.md", standard.replace("status: todo", "status: done"));
  expect(
    (await loadMetadataBundle(store, config, { cache: false })).byId("DKT-1")
      ?.fm.status,
  ).toBe("done");
});
