import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import {
  appendLog,
  createWorkItem,
  setEpic,
  setPriority,
  setRank,
  setStatus,
  slugify,
} from "./ops";

const config = parseConfig();

const task = (id: string, status: string) =>
  `---\ntype: Task\ntitle: t${id}\nid: ${id}\nstatus: ${status}\ntimestamp: 2026-07-21T00:00:00Z\n---\n\n# Context\n\nx\n`;

const seed = () =>
  new InMemoryFileStore(
    new Map([
      ["work/tasks/DKT-1-a.md", task("DKT-1", "todo")],
      ["work/tasks/DKT-4-b.md", task("DKT-4", "in-progress")],
    ]),
  );

describe("createWorkItem", () => {
  test("assigns next numbered id and the file round-trips clean", async () => {
    const store = seed();
    const result = await createWorkItem(store, config, {
      title: "Add idempotency keys to checkout",
      epic: "/work/epics/DKT-2-example.md",
      dependsOn: ["DKT-4"],
      priority: "p1",
    });
    expect(result.id).toBe("DKT-5"); // max(1, 4) + 1
    expect(result.path).toBe(
      "work/tasks/DKT-5-add-idempotency-keys-to-checkout.md",
    );

    const bundle = await loadBundle(store, config);
    expect(bundle.diagnostics).toEqual([]); // created file is conformant
    const created = bundle.byId("DKT-5");
    if (created?.kind !== "work") throw new Error("expected work item");
    expect(created.fm.status).toBe("todo");
    expect(created.fm.depends_on).toEqual(["DKT-4"]);
  });

  test("epics land in work/epics/", async () => {
    const store = seed();
    const result = await createWorkItem(store, config, {
      title: "Big theme",
      type: "Epic",
    });
    expect(result.path).toStartWith("work/epics/");
  });

  test("slugify handles punctuation and length", () => {
    expect(slugify("core: parser, zod schemas & FileStore!")).toBe(
      "core-parser-zod-schemas-filestore",
    );
    expect(slugify("")).toBe("item");
  });
});

describe("setStatus", () => {
  test("valid transition updates only the status and timestamp lines", async () => {
    const store = seed();
    const result = await setStatus(store, config, "DKT-1", "in-progress");
    expect(result).toMatchObject({
      id: "DKT-1",
      from: "todo",
      to: "in-progress",
    });
    const text = await store.read("work/tasks/DKT-1-a.md");
    expect(text).toContain("status: in-progress");
    expect(text).toContain("# Context\n\nx"); // body untouched
    expect(text).not.toContain("2026-07-21T00:00:00Z"); // timestamp bumped
  });

  test("state machine is enforced; done and closed are terminal", async () => {
    const store = seed();
    await setStatus(store, config, "DKT-4", "done");
    expect(setStatus(store, config, "DKT-4", "todo")).rejects.toThrow(
      "invalid transition",
    );
    expect(setStatus(store, config, "DKT-1", "in-review")).rejects.toThrow(
      "invalid transition",
    );
    expect(setStatus(store, config, "DKT-1", "flying")).rejects.toThrow(
      "unknown status",
    );

    const closed = seed();
    expect(setStatus(closed, config, "DKT-1", "closed")).rejects.toThrow(
      "requires a disposition note",
    );
    await setStatus(closed, config, "DKT-1", "closed", {
      note: "Superseded by DKT-9.",
    });
    expect(setStatus(closed, config, "DKT-1", "todo")).rejects.toThrow(
      "invalid transition",
    );
    expect(await closed.read("work/tasks/DKT-1-a.md")).toContain(
      "— Superseded by DKT-9.",
    );

    const blocked = seed();
    await setStatus(blocked, config, "DKT-1", "blocked");
    await expect(
      setStatus(blocked, config, "DKT-1", "closed", {
        note: "External dependency was retired.",
      }),
    ).resolves.toMatchObject({ from: "blocked", to: "closed" });
  });

  test("resolves aliases and rejects unknown ids", async () => {
    const store = new InMemoryFileStore(
      new Map([
        [
          "work/tasks/DKT-2-x.md",
          `---\ntype: Task\ntitle: x\nid: DKT-2\naliases: [TASK-old]\nstatus: todo\n---\n`,
        ],
      ]),
    );
    const result = await setStatus(store, config, "TASK-old", "in-progress");
    expect(result.id).toBe("DKT-2"); // canonical id returned
    expect(setStatus(store, config, "DKT-99", "done")).rejects.toThrow(
      "no work item",
    );
  });
});

const EPIC = `---\ntype: Epic\ntitle: Theme\nid: DKT-2\nstatus: in-progress\ntimestamp: 2026-07-21T00:00:00Z\n---\n\n# E\n`;

const seedWithEpic = () =>
  new InMemoryFileStore(
    new Map([
      ["work/tasks/DKT-1-a.md", task("DKT-1", "todo")],
      ["work/tasks/DKT-4-b.md", task("DKT-4", "in-progress")],
      ["work/epics/DKT-2-theme.md", EPIC],
    ]),
  );

describe("setPriority", () => {
  test("edits a CLI-created file in place with identical field order", async () => {
    const store = seedWithEpic();
    const { id, path } = await createWorkItem(store, config, {
      title: "Full house",
      epic: "/work/epics/DKT-2-theme.md",
      dependsOn: ["DKT-4"],
      priority: "p2",
    });
    const result = await setPriority(store, config, id, "p0");
    expect(result).toMatchObject({ from: "p2", to: "p0" });
    // Byte-for-byte the shape createWorkItem writes, only the value changed.
    expect(await store.read(path)).toContain(
      "status: todo\nepic: /work/epics/DKT-2-theme.md\ndepends_on: [DKT-4]\npriority: p0\ntimestamp:",
    );
  });

  test("inserts a missing priority line after status; timestamp untouched", async () => {
    const store = seed();
    const result = await setPriority(store, config, "DKT-1", "p1");
    expect(result).toMatchObject({ from: "p2", to: "p1" }); // schema default
    const text = await store.read("work/tasks/DKT-1-a.md");
    expect(text).toContain("status: todo\npriority: p1\ntimestamp:");
    expect(text).toContain("2026-07-21T00:00:00Z"); // not a status transition
  });

  test("rejects unknown values, no-op edits, and unknown ids", async () => {
    const store = seed();
    expect(setPriority(store, config, "DKT-1", "p9")).rejects.toThrow(
      "unknown priority",
    );
    expect(setPriority(store, config, "DKT-1", "p2")).rejects.toThrow(
      "already p2",
    );
    expect(setPriority(store, config, "DKT-99", "p1")).rejects.toThrow(
      "no work item",
    );
  });
});

describe("setRank", () => {
  test("inserts after priority in a CLI-created file, replaces, and clears", async () => {
    const store = seed();
    const { id, path } = await createWorkItem(store, config, {
      title: "Ranked",
      priority: "p1",
      rank: 20,
    });
    expect(await store.read(path)).toContain("priority: p1\nrank: 20\n");

    // Fractional midpoints survive the YAML round-trip.
    const moved = await setRank(store, config, id, 12.5);
    expect(moved).toMatchObject({ from: 20, to: 12.5 });
    expect(await store.read(path)).toContain("priority: p1\nrank: 12.5\n");

    const cleared = await setRank(store, config, id, null);
    expect(cleared).toMatchObject({ from: 12.5, to: null });
    expect(await store.read(path)).not.toContain("rank:");
  });

  test("inserts a missing rank line after status when nothing else anchors", async () => {
    const store = seed();
    await setRank(store, config, "DKT-1", 30);
    const text = await store.read("work/tasks/DKT-1-a.md");
    expect(text).toContain("status: todo\nrank: 30\ntimestamp:");
    expect(text).toContain("2026-07-21T00:00:00Z"); // not a status transition
  });

  test("rejects epics, non-finite values, no-ops, and unknown ids", async () => {
    const store = seedWithEpic();
    expect(setRank(store, config, "DKT-2", 10)).rejects.toThrow(
      "rank orders tasks",
    );
    expect(
      setRank(store, config, "DKT-1", Number.POSITIVE_INFINITY),
    ).rejects.toThrow("finite");
    expect(setRank(store, config, "DKT-1", null)).rejects.toThrow(
      "already unset",
    );
    expect(setRank(store, config, "DKT-99", 10)).rejects.toThrow(
      "no work item",
    );
  });
});

describe("setEpic", () => {
  test("inserts after status, replaces in place, and clears to no line", async () => {
    const store = seedWithEpic();
    const set = await setEpic(
      store,
      config,
      "DKT-1",
      "/work/epics/DKT-2-theme.md",
    );
    expect(set).toMatchObject({ from: null, to: "/work/epics/DKT-2-theme.md" });
    expect(await store.read("work/tasks/DKT-1-a.md")).toContain(
      "status: todo\nepic: /work/epics/DKT-2-theme.md\ntimestamp:",
    );

    const cleared = await setEpic(store, config, "DKT-1", null);
    expect(cleared).toMatchObject({
      from: "/work/epics/DKT-2-theme.md",
      to: null,
    });
    const text = await store.read("work/tasks/DKT-1-a.md");
    expect(text).not.toContain("epic:");
    expect(text).toContain("status: todo\ntimestamp:"); // no gap left behind
  });

  test("normalizes a missing leading slash to a bundle-absolute link", async () => {
    const store = seedWithEpic();
    const result = await setEpic(
      store,
      config,
      "DKT-1",
      "work/epics/DKT-2-theme.md",
    );
    expect(result.to).toBe("/work/epics/DKT-2-theme.md");
  });

  test("rejects nonexistent or non-epic targets and epic nesting", async () => {
    const store = seedWithEpic();
    expect(
      setEpic(store, config, "DKT-1", "/work/epics/nope.md"),
    ).rejects.toThrow("no epic at /work/epics/nope.md");
    expect(
      setEpic(store, config, "DKT-1", "/work/tasks/DKT-4-b.md"),
    ).rejects.toThrow("no epic at"); // a task is not an epic
    expect(
      setEpic(store, config, "DKT-2", "/work/epics/DKT-2-theme.md"),
    ).rejects.toThrow("epics don't nest");
    expect(setEpic(store, config, "DKT-1", null)).rejects.toThrow(
      "already unset",
    );
  });
});

describe("appendLog", () => {
  test("inserts newest-first under # Log, creating the section when missing", async () => {
    const store = seed();
    await appendLog(store, config, "DKT-1", "first entry");
    await appendLog(store, config, "DKT-1", "second entry");
    const text = await store.read("work/tasks/DKT-1-a.md");
    const first = text.indexOf("second entry");
    const second = text.indexOf("first entry");
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second); // newest first
    expect(text.match(/^# Log$/m)).toBeTruthy();
    // Entries are separated by exactly one blank line, or they render as one paragraph.
    expect(text).toMatch(/— second entry\n\n\*\*/);
    expect(text).toEndWith("first entry\n");
  });
});
