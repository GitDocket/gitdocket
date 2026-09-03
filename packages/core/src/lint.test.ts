import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { findFreshnessWatermark, lintBundle } from "./lint";

const config = parseConfig();
const NOW = new Date("2026-07-21T12:00:00Z");

const item = (
  fm: Record<string, string>,
  body = "# Context\n\nx\n",
): string => {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
};

const lint = async (files: Record<string, string>) => {
  const store = new InMemoryFileStore(new Map(Object.entries(files)));
  return lintBundle(store, await loadBundle(store, config), { now: NOW });
};

const messages = (diags: { message: string }[]) =>
  diags.map((d) => d.message).join("\n");

describe("conformance errors", () => {
  test("unresolvable depends_on is an error", async () => {
    const diags = await lint({
      "work/tasks/DKT-1-a.md": item({
        type: "Task",
        title: "a",
        id: "DKT-1",
        status: "todo",
        depends_on: "[DKT-99]",
      }),
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("error");
    expect(diags[0]?.message).toContain("DKT-99");
  });

  test("parse and duplicate-id diagnostics flow through", async () => {
    const diags = await lint({
      "work/tasks/DKT-1-a.md": item({
        type: "Task",
        title: "a",
        id: "DKT-1",
        status: "todo",
      }),
      "work/tasks/DKT-1-b.md": item({
        type: "Task",
        title: "b",
        id: "DKT-1",
        status: "todo",
      }),
      "work/tasks/broken.md": "no frontmatter\n",
    });
    expect(messages(diags)).toContain("duplicate id");
    expect(messages(diags)).toContain("frontmatter");
  });
});

describe("practice warnings", () => {
  test("epic without spec, slug drift, done with unchecked criteria", async () => {
    const diags = await lint({
      "work/epics/DKT-1-e.md": item({
        type: "Epic",
        title: "e",
        id: "DKT-1",
        status: "in-progress",
        timestamp: "2026-07-20T00:00:00Z",
      }),
      "work/tasks/DKT-2-renamed.md": item(
        {
          type: "Task",
          title: "t",
          id: "DKT-3",
          status: "done",
        },
        "# Acceptance Criteria\n\n- [ ] never finished\n",
      ),
    });
    expect(diags.every((d) => d.severity === "warning")).toBe(true);
    expect(messages(diags)).toContain("epic has no spec link");
    expect(messages(diags)).toContain("DKT-3- (slug drift?)");
    expect(messages(diags)).toContain("unchecked criteria");
  });

  test("stale in-flight status warns past the threshold, not before", async () => {
    const task = (id: string, ts: string) =>
      item({
        type: "Task",
        title: id,
        id,
        status: "in-progress",
        timestamp: ts,
      });
    const diags = await lint({
      "work/tasks/DKT-1-a.md": task("DKT-1", "2026-07-01T00:00:00Z"),
      "work/tasks/DKT-2-b.md": task("DKT-2", "2026-07-19T00:00:00Z"),
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]?.path).toBe("work/tasks/DKT-1-a.md");
    expect(diags[0]?.message).toContain("stale");
  });

  test("broken internal links warn — concepts and reserved files alike", async () => {
    const diags = await lint({
      "work/tasks/DKT-1-a.md": item(
        { type: "Task", title: "a", id: "DKT-1", status: "todo" },
        "See [gone](/specs/gone.md), [ok](/work/tasks/DKT-1-a.md), [ext](https://x.dev), [out](../../../PLAN.md).\n",
      ),
      "index.md": "# Index\n\n- [dead](/work/tasks/DKT-9-dead.md)\n",
    });
    expect(diags).toHaveLength(2);
    expect(messages(diags)).toContain("/specs/gone.md");
    expect(messages(diags)).toContain("/work/tasks/DKT-9-dead.md");
  });
});

describe("conflict markers", () => {
  // The exact body shape docket upgrade leaves behind on conflict.
  const conflicted = `Steps.

<<<<<<< docs/workflows/docket-close.md (this repo)
Step B, but my way.
=======
Step B, revised.
>>>>>>> docket 0.2.0

Tail.
`;

  test("a half-resolved upgrade conflict warns", async () => {
    const diags = await lint({
      "workflows/docket-close.md": item(
        { type: "Workflow", title: "close" },
        conflicted,
      ),
    });
    expect(messages(diags)).toContain("merge-conflict markers");
    expect(diags.find((d) => d.message.includes("merge-conflict"))?.path).toBe(
      "workflows/docket-close.md",
    );
  });

  test("inline mentions and lone markers don't warn; a complete quoted conflict does (accepted)", async () => {
    const clean = await lint({
      "specs/a.md": item(
        { type: "Spec", title: "a" },
        "Resolve `<<<<<<<`/`=======`/`>>>>>>>` markers by hand.\n\n<<<<<<< alone at line start\n",
      ),
    });
    expect(messages(clean)).not.toContain("merge-conflict");

    // Documented tradeoff: a fenced block quoting a full conflict still trips
    // the check — all three markers at line starts is indistinguishable from
    // the real thing without parsing fences. Quote partial markers instead.
    const quoted = await lint({
      "specs/b.md": item(
        { type: "Spec", title: "b" },
        "```\n<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n```\n",
      ),
    });
    expect(messages(quoted)).toContain("merge-conflict");
  });
});

describe("freshness watermark", () => {
  const task = item({
    type: "Task",
    title: "a",
    id: "DKT-1",
    status: "todo",
  });

  test("no log.md — no nag; log.md without watermark — nag", async () => {
    expect(await lint({ "work/tasks/DKT-1-a.md": task })).toEqual([]);
    const diags = await lint({
      "work/tasks/DKT-1-a.md": task,
      "log.md": "# Log\n\n## 2026-07-21\n\n- **Update** — stuff.\n",
    });
    expect(messages(diags)).toContain("no **Freshness** watermark");
  });

  test("fresh watermark is silent; old watermark nags", async () => {
    const log = (date: string) =>
      `# Log\n\n## ${date}\n\n- **Freshness** — reviewed through \`abc1234\` (3 commits, 0 trailerless): no drift found.\n`;
    expect(
      await lint({
        "work/tasks/DKT-1-a.md": task,
        "log.md": log("2026-07-20"),
      }),
    ).toEqual([]);
    const diags = await lint({
      "work/tasks/DKT-1-a.md": task,
      "log.md": log("2026-06-01"),
    });
    expect(messages(diags)).toContain("days old");
  });

  test("trailerless commits since the watermark nag (caller-provided)", async () => {
    const store = new InMemoryFileStore(
      new Map([
        ["work/tasks/DKT-1-a.md", task],
        [
          "log.md",
          "# Log\n\n## 2026-07-21\n\n- **Freshness** — reviewed through abc1234 (1 commits, 0 trailerless): ok.\n",
        ],
      ]),
    );
    const diags = await lintBundle(store, await loadBundle(store, config), {
      now: NOW,
      trailerlessCommits: 2,
    });
    expect(messages(diags)).toContain("2 trailerless work commit(s)");
  });

  test("findFreshnessWatermark takes the newest entry and its section date", () => {
    const log =
      "# Log\n\n## 2026-07-21\n\n- **Freshness** — reviewed through `abc1234` (2 commits, 1 trailerless): ok.\n\n## 2026-07-01\n\n- **Freshness** — reviewed through 9999999 (5 commits, 0 trailerless): ok.\n";
    expect(findFreshnessWatermark(log)).toEqual({
      sha: "abc1234",
      date: "2026-07-21",
    });
    expect(findFreshnessWatermark("# Log\n")).toBeUndefined();
  });

  test("findFreshnessWatermark matches init's baseline stamp", () => {
    const log =
      "# Log\n\n## 2026-07-21\n\n- **Freshness** — baseline at adoption; reviewed through `abc1234` (nothing to review before Docket).\n";
    expect(findFreshnessWatermark(log)).toEqual({
      sha: "abc1234",
      date: "2026-07-21",
    });
  });
});

describe("state-of-play note", () => {
  const task = item({
    type: "Task",
    title: "a",
    id: "DKT-1",
    status: "todo",
  });
  const note = `---
format: re-entry/v2
as_of: abc1234
reviewed_at: 2026-07-20T00:00:00Z
---

## What we've done recently

The project shipped a linked overview.

## What's up next

Test the note after time away.
`;

  test("a bundle with or without a valid note is accepted", async () => {
    expect(await lint({ "work/tasks/DKT-1-a.md": task })).toEqual([]);
    expect(
      await lint({ "work/tasks/DKT-1-a.md": task, "overview.md": note }),
    ).toEqual([]);
  });

  test("malformed, legacy, and stale notes surface distinct diagnostics", async () => {
    const malformed = await lint({
      "work/tasks/DKT-1-a.md": task,
      "overview.md": "No watermark.\n",
    });
    expect(malformed[0]?.severity).toBe("error");
    expect(messages(malformed)).toContain("as_of");

    const legacy = await lint({
      "work/tasks/DKT-1-a.md": task,
      "overview.md":
        "---\nas_of: abc1234\nupdated_at: 2026-07-21T00:00:00Z\n---\n\nEarlier prose.\n",
    });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.severity).toBe("warning");
    expect(legacy[0]?.message).toContain("legacy prose format");

    const store = new InMemoryFileStore(
      new Map([
        ["work/tasks/DKT-1-a.md", task],
        ["overview.md", note],
      ]),
    );
    const stale = await lintBundle(store, await loadBundle(store, config), {
      now: NOW,
      stateOfPlayCommitsAgo: 5,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]?.severity).toBe("warning");
    expect(stale[0]?.message).toContain("5 task-linked commits behind");
  });
});

describe("verify markers", () => {
  const task = "---\ntype: Task\ntitle: a\nid: DKT-1\nstatus: todo\n---\n\nx\n";
  const spec = "---\ntype: Spec\ntitle: S\n---\n\nx\n";

  test("unresolvable target warns; resolved marker is silent", async () => {
    const store = new InMemoryFileStore(
      new Map([
        ["work/tasks/DKT-1-a.md", task],
        ["specs/s.md", spec],
      ]),
    );
    const diags = await lintBundle(store, await loadBundle(store, config), {
      now: NOW,
      verifyMarkers: [
        { source: "a.test.ts", line: 3, target: "/specs/gone.md" },
        {
          source: "b.test.ts",
          line: 1,
          target: "/specs/s.md",
          spec: "specs/s.md",
        },
      ],
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]?.severity).toBe("warning");
    expect(diags[0]?.path).toBe("a.test.ts");
    expect(diags[0]?.message).toContain("/specs/gone.md");
    expect(diags[0]?.message).toContain("line 3");
  });

  test("no markers passed — no verify rule runs, bare specs never warn", async () => {
    const store = new InMemoryFileStore(new Map([["specs/s.md", spec]]));
    const diags = await lintBundle(store, await loadBundle(store, config), {
      now: NOW,
    });
    expect(diags).toHaveLength(0);
  });
});
