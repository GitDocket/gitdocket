import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { applyIndex, INDEX_MARKER, renderIndex } from "./indexmd";

const config = parseConfig();

const files = {
  "specs/alpha.md":
    "---\ntype: Spec\ntitle: Alpha\ndescription: the first spec\n---\n\nx\n",
  "decisions/DEC-1-old.md":
    "---\ntype: Decision\ntitle: Old way\nid: DEC-1\nstatus: superseded\n---\n\nx\n",
  "decisions/DEC-2-new.md":
    "---\ntype: Decision\ntitle: New way\nid: DEC-2\n---\n\nx\n",
  "work/epics/DKT-1-e.md":
    "---\ntype: Epic\ntitle: The epic\nid: DKT-1\nstatus: in-progress\nspec: /specs/alpha.md\n---\n\nx\n",
  "work/tasks/DKT-2-a.md":
    "---\ntype: Task\ntitle: Done thing\nid: DKT-2\nstatus: done\nepic: /work/epics/DKT-1-e.md\n---\n\nx\n",
  "work/tasks/DKT-3-b.md":
    "---\ntype: Task\ntitle: Ready thing\nid: DKT-3\nstatus: todo\nepic: /work/epics/DKT-1-e.md\ndepends_on: [DKT-2]\n---\n\nx\n",
  "work/tasks/DKT-10-c.md":
    "---\ntype: Task\ntitle: Orphan\nid: DKT-10\nstatus: blocked\n---\n\nx\n",
  "work/tasks/DKT-11-closed.md":
    "---\ntype: Task\ntitle: Closed thing\nid: DKT-11\nstatus: closed\n---\n\nx\n",
};

const bundle = () =>
  loadBundle(new InMemoryFileStore(new Map(Object.entries(files))), config);

describe("renderIndex", () => {
  test("renders sections deterministically with status markers", async () => {
    const b = await bundle();
    const body = renderIndex(b);
    expect(body).toBe(renderIndex(b)); // deterministic
    expect(body).toContain(
      "## Specs\n\n- [Alpha](/specs/alpha.md) — the first spec",
    );
    expect(body).toContain(
      "- ~~[DEC-1 — Old way](/decisions/DEC-1-old.md)~~ *(superseded)*",
    );
    expect(body).toContain("- [DEC-2 — New way](/decisions/DEC-2-new.md)");
    expect(body).toContain(
      "### [The epic](/work/epics/DKT-1-e.md) *(in-progress)*",
    );
    expect(body).toContain("- ✅ [DKT-2 — Done thing](/work/tasks/DKT-2-a.md)");
    expect(body).toContain(
      "- [DKT-3 — Ready thing](/work/tasks/DKT-3-b.md) *(ready)*",
    );
    expect(body).toContain("### No epic");
    expect(body).toContain("- 🚫 [DKT-10 — Orphan](/work/tasks/DKT-10-c.md)");
    expect(body).toContain(
      "- ⏹️ [DKT-11 — Closed thing](/work/tasks/DKT-11-closed.md) *(closed)*",
    );
  });

  test("ids sort numerically, not lexically", async () => {
    const body = renderIndex(await bundle());
    expect(body.indexOf("DKT-3 —")).toBeLessThan(body.indexOf("DKT-10 —"));
  });

  test("fully-done epics collapse to a rollup; active epics order by liveness", async () => {
    const task = (
      id: number,
      epic: string,
      status: string,
      extra = "",
    ): [string, string] => [
      `work/tasks/DKT-${id}-t.md`,
      `---\ntype: Task\ntitle: T${id}\nid: DKT-${id}\nstatus: ${status}\nepic: /work/epics/${epic}.md\n${extra}---\n\nx\n`,
    ];
    const b = await loadBundle(
      new InMemoryFileStore(
        new Map([
          [
            "work/epics/DKT-1-finished.md",
            "---\ntype: Epic\ntitle: Finished\nid: DKT-1\nstatus: done\n---\n\nx\n",
          ],
          [
            "work/epics/DKT-2-active.md",
            "---\ntype: Epic\ntitle: Active\nid: DKT-2\nstatus: in-progress\n---\n\nx\n",
          ],
          task(
            3,
            "DKT-1-finished",
            "done",
            "timestamp: 2026-06-01T00:00:00Z\n",
          ),
          task(
            4,
            "DKT-1-finished",
            "done",
            "timestamp: 2026-06-02T00:00:00Z\n",
          ),
          // active epic: done-old, done-new, in-progress, ready todo
          task(5, "DKT-2-active", "done", "timestamp: 2026-07-01T00:00:00Z\n"),
          task(6, "DKT-2-active", "done", "timestamp: 2026-07-15T00:00:00Z\n"),
          task(7, "DKT-2-active", "in-progress"),
          task(8, "DKT-2-active", "todo"),
        ]),
      ),
      config,
    );
    const body = renderIndex(b);

    // Collapsed: rollup line, no task list under the finished epic.
    expect(body).toContain("✅ all 2 tasks done");
    expect(body).not.toContain("DKT-3 —");
    expect(body).not.toContain("DKT-4 —");

    // Liveness: in-progress, then ready todo, then done newest-first.
    const at = (id: number) => body.indexOf(`DKT-${id} —`);
    expect(at(7)).toBeLessThan(at(8));
    expect(at(8)).toBeLessThan(at(6));
    expect(at(6)).toBeLessThan(at(5));

    expect(body).toBe(renderIndex(b)); // still deterministic
  });
});

describe("applyIndex", () => {
  test("preserves the preamble above the marker, owns everything below", () => {
    const current = `---\nokf_version: "0.1"\n---\n\n# Hello\n\nprose.\n\n${INDEX_MARKER}\n\nstale old body\n`;
    const next = applyIndex(current, "fresh body");
    expect(next).toBe(
      `---\nokf_version: "0.1"\n---\n\n# Hello\n\nprose.\n\n${INDEX_MARKER}\n\nfresh body\n`,
    );
  });

  test("appends a marker to an unmarked file; seeds an empty one", () => {
    expect(applyIndex("# Mine\n", "body")).toBe(
      `# Mine\n\n${INDEX_MARKER}\n\nbody\n`,
    );
    expect(applyIndex("", "body")).toBe(`# Index\n\n${INDEX_MARKER}\n\nbody\n`);
  });

  test("regeneration is idempotent", async () => {
    const body = renderIndex(await bundle());
    const once = applyIndex("# Docket\n", body);
    expect(applyIndex(once, body)).toBe(once);
  });
});
