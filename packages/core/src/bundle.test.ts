import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadBundle, loadRepo, readyWorkItems } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";

const EXAMPLE_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "examples",
  "basic",
);

const file = (
  id: string,
  status: string,
  deps: string[] = [],
  aliases: string[] = [],
) =>
  `---\ntype: Task\nid: ${id}\nstatus: ${status}\ndepends_on: [${deps.join(", ")}]\naliases: [${aliases.join(", ")}]\n---\n`;

describe("loadBundle (in-memory)", () => {
  test("readiness derives across the graph; aliases resolve", async () => {
    const store = new InMemoryFileStore(
      new Map([
        ["work/tasks/DKT-1-a.md", file("DKT-1", "done", [], ["OLD-9"])],
        ["work/tasks/DKT-2-b.md", file("DKT-2", "todo", ["OLD-9"])], // dep via alias
        ["work/tasks/DKT-3-c.md", file("DKT-3", "todo", ["DKT-2"])],
        ["index.md", "# reserved, no frontmatter"],
      ]),
    );
    const bundle = await loadBundle(store, parseConfig());
    expect(bundle.diagnostics).toHaveLength(0);
    expect(bundle.readyIds()).toEqual(["DKT-2"]); // DKT-3 waits on DKT-2
    expect(bundle.byId("OLD-9")?.fm.id).toBe("DKT-1");
  });

  test("duplicate ids are flagged", async () => {
    const store = new InMemoryFileStore(
      new Map([
        ["work/tasks/DKT-1-a.md", file("DKT-1", "todo")],
        ["work/tasks/DKT-1-b.md", file("DKT-1", "todo")],
      ]),
    );
    const bundle = await loadBundle(store, parseConfig());
    expect(
      bundle.diagnostics.some((d) => d.message.includes("duplicate id DKT-1")),
    ).toBe(true);
  });

  test("the canonical ready queue honors rank, priority, then stable task ID", async () => {
    const store = new InMemoryFileStore(
      new Map([
        [
          "work/tasks/a-first-path.md",
          "---\ntype: Task\nid: DKT-11\nstatus: todo\npriority: p1\nrank: 20\n---\n",
        ],
        [
          "work/tasks/b-second-path.md",
          "---\ntype: Task\nid: DKT-2\nstatus: todo\npriority: p1\nrank: 20\n---\n",
        ],
        [
          "work/tasks/c-ranked-first.md",
          "---\ntype: Task\nid: DKT-3\nstatus: todo\npriority: p3\nrank: 10\n---\n",
        ],
        [
          "work/tasks/d-rank-tie-priority.md",
          "---\ntype: Task\nid: DKT-4\nstatus: todo\npriority: p0\nrank: 20\n---\n",
        ],
        [
          "work/tasks/e-unranked-priority.md",
          "---\ntype: Task\nid: DKT-5\nstatus: todo\npriority: p0\n---\n",
        ],
        [
          "work/tasks/f-unranked-tail.md",
          "---\ntype: Task\nid: DKT-6\nstatus: todo\npriority: p2\n---\n",
        ],
      ]),
    );
    const bundle = await loadBundle(store, parseConfig());
    expect(readyWorkItems(bundle).map((item) => item.fm.id)).toEqual([
      "DKT-3",
      "DKT-4",
      "DKT-2",
      "DKT-11",
      "DKT-5",
      "DKT-6",
    ]);
  });
});

describe("synthetic example bundle", () => {
  test("parses clean: zero diagnostics", async () => {
    const bundle = await loadRepo(EXAMPLE_ROOT);
    expect(bundle.diagnostics).toEqual([]);
  });

  test("contains the known graph", async () => {
    const bundle = await loadRepo(EXAMPLE_ROOT);
    expect(bundle.workItems).toHaveLength(3);
    expect(bundle.byId("DEMO-1")?.fm.type).toBe("Epic");
    expect(bundle.byId("DEMO-3")?.fm.depends_on).toEqual(["DEMO-2"]);
    expect(bundle.byId("DEC-1")?.kind).toBe("decision");
  });

  test("readiness is internally consistent (robust as the bundle evolves)", async () => {
    const bundle = await loadRepo(EXAMPLE_ROOT);
    for (const id of bundle.readyIds()) {
      const item = bundle.byId(id);
      if (item?.kind !== "work")
        throw new Error(`ready id ${id} is not a work item`);
      expect(item.fm.status).toBe("todo");
      for (const dep of item.fm.depends_on) {
        expect(bundle.statusById.get(dep)).toBe("done");
      }
    }
  });
});
