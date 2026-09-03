import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { buildContextPacket } from "./packet";

const config = parseConfig();

const seed = () =>
  new InMemoryFileStore(
    new Map([
      [
        "work/tasks/DKT-3-wire-parser.md",
        `---
type: Task
title: Wire the parser
id: DKT-3
status: todo
epic: /work/epics/DKT-10-theme.md
depends_on: [DKT-1, DKT-2]
priority: p1
timestamp: 2026-07-21T00:00:00Z
---

# Context

Part of [the theme](/work/epics/DKT-10-theme.md). Implements [the format spec](/specs/format.md)
per [DEC-1](/decisions/DEC-1-choice.md), after [DKT-1](/work/tasks/DKT-1-a.md).
Spec again: [format](/specs/format.md). External: [okf](https://okf.md/). Broken: [gone](/specs/gone.md).

# Acceptance Criteria

- [ ] parses
`,
      ],
      [
        "work/tasks/DKT-1-a.md",
        `---\ntype: Task\ntitle: Groundwork\nid: DKT-1\nstatus: done\ntimestamp: 2026-07-20T00:00:00Z\n---\n\nx\n`,
      ],
      [
        "work/epics/DKT-10-theme.md",
        `---\ntype: Epic\ntitle: The theme\nid: DKT-10\nstatus: in-progress\ntimestamp: 2026-07-19T00:00:00Z\n---\n\nx\n`,
      ],
      [
        "specs/format.md",
        `---\ntype: Spec\ntitle: The format\ndescription: What the files look like.\n---\n\nlong body\n`,
      ],
      [
        "decisions/DEC-1-choice.md",
        `---\ntype: Decision\ntitle: The choice\nid: DEC-1\nstatus: accepted\n---\n\nx\n`,
      ],
    ]),
  );

describe("buildContextPacket", () => {
  test("assembles task, epic, deps, one-hop links, and commits", async () => {
    const store = seed();
    const bundle = await loadBundle(store, config);
    const commits = [
      { sha: "abc1234", date: "2026-07-21T10:00:00-07:00", subject: "wip" },
    ];
    const packet = await buildContextPacket(store, bundle, "DKT-3", commits);

    expect(packet.suggestedSessionTitle).toBe("DKT-3 — Wire the parser");
    expect(packet.task.path).toBe("work/tasks/DKT-3-wire-parser.md");
    expect(packet.task.fm.status).toBe("todo");
    expect(packet.task.body).toStartWith("# Context");
    expect(packet.task.body).not.toContain("---\ntype:"); // frontmatter stripped

    expect(packet.epic).toMatchObject({
      path: "work/epics/DKT-10-theme.md",
      id: "DKT-10",
      title: "The theme",
      status: "in-progress",
    });

    // DKT-2 doesn't exist — surfaced with undefined status, not dropped.
    expect(packet.deps).toEqual([
      { id: "DKT-1", title: "Groundwork", status: "done" },
      { id: "DKT-2", title: undefined, status: undefined },
    ]);

    // Epic, dep, external, and broken links are excluded; repeats dedupe.
    expect(packet.linked).toEqual([
      {
        path: "specs/format.md",
        type: "Spec",
        title: "The format",
        description: "What the files look like.",
        status: undefined,
      },
      {
        path: "decisions/DEC-1-choice.md",
        type: "Decision",
        title: "The choice",
        description: undefined,
        status: "accepted",
      },
    ]);

    expect(packet.commits).toEqual(commits);
  });

  test("task without epic or deps yields an empty scaffold", async () => {
    const store = seed();
    const bundle = await loadBundle(store, config);
    const packet = await buildContextPacket(store, bundle, "DKT-1");
    expect(packet.epic).toBeUndefined();
    expect(packet.deps).toEqual([]);
    expect(packet.linked).toEqual([]);
    expect(packet.commits).toEqual([]);
  });

  test("resolves aliases to the canonical item", async () => {
    const store = seed();
    store.files.set(
      "work/tasks/DKT-1-a.md",
      `---\ntype: Task\ntitle: Groundwork\nid: DKT-1\naliases: [DKT-99]\nstatus: done\ntimestamp: 2026-07-20T00:00:00Z\n---\n\nx\n`,
    );
    const bundle = await loadBundle(store, config);
    const packet = await buildContextPacket(store, bundle, "DKT-99");
    expect(packet.task.fm.id).toBe("DKT-1");
    expect(packet.suggestedSessionTitle).toBe("DKT-1 — Groundwork");
  });

  test("rejects unknown ids and non-work concepts", async () => {
    const store = seed();
    const bundle = await loadBundle(store, config);
    expect(buildContextPacket(store, bundle, "DKT-404")).rejects.toThrow(
      "no work item",
    );
    expect(buildContextPacket(store, bundle, "DEC-1")).rejects.toThrow(
      "no work item",
    );
  });
});
