import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { loadBundle, readyWorkItems } from "./bundle";
import { type ActivityRow, buildCache } from "./cache";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { deriveOverview, epicNeedsCleanup } from "./overview";

const config = parseConfig();

const epic = (
  id: number,
  title: string,
  timestamp?: string,
): [string, string] => [
  `work/epics/DKT-${id}-epic.md`,
  `---\ntype: Epic\ntitle: ${title}\nid: DKT-${id}\nstatus: todo\n${timestamp ? `timestamp: ${timestamp}\n` : ""}---\n\nx\n`,
];

const task = (
  id: number,
  title: string,
  status: string,
  options: {
    epic?: number;
    priority?: string;
    rank?: number;
    timestamp?: string;
  } = {},
): [string, string] => [
  `work/tasks/DKT-${id}-task.md`,
  `---\ntype: Task\ntitle: ${title}\nid: DKT-${id}\nstatus: ${status}\n${options.epic ? `epic: /work/epics/DKT-${options.epic}-epic.md\n` : ""}${options.priority ? `priority: ${options.priority}\n` : ""}${options.rank === undefined ? "" : `rank: ${options.rank}\n`}${options.timestamp ? `timestamp: ${options.timestamp}\n` : ""}---\n\nx\n`,
];

const decision = (
  id: number,
  title: string,
  timestamp: string,
): [string, string] => [
  `decisions/DEC-${id}.md`,
  `---\ntype: Decision\ntitle: ${title}\nid: DEC-${id}\nstatus: accepted\ntimestamp: ${timestamp}\n---\n\n# Context\n\nThe old path caused drift.\n\n# Decision\n\nUse one shared model.\n\n# Consequences\n\nHome and agents agree.\n`,
];

async function fixture(
  files: [string, string][],
  activity: ActivityRow[] = [],
) {
  const bundle = await loadBundle(
    new InMemoryFileStore(new Map(files)),
    config,
  );
  const db = new Database(":memory:");
  buildCache(db, bundle, activity);
  return { bundle, db };
}

describe("deriveOverview", () => {
  test("classifies cleanup-needed epic progress once", () => {
    expect(epicNeedsCleanup("todo", { done: 2, total: 2 })).toBe(true);
    expect(epicNeedsCleanup("done", { done: 2, total: 2 })).toBe(false);
    expect(epicNeedsCleanup("closed", { done: 2, total: 2 })).toBe(false);
    expect(epicNeedsCleanup("todo", { done: 0, total: 0 })).toBe(false);
    expect(epicNeedsCleanup("in-progress", { done: 1, total: 2 })).toBe(false);
  });

  test("selects and orders active workstreams, including blocked-only recent work", async () => {
    const [finishedPath, finishedSource] = epic(11, "Finished recently");
    const [olderFinishedPath, olderFinishedSource] = epic(
      13,
      "Older finished work",
    );
    const { bundle, db } = await fixture(
      [
        epic(1, "Now"),
        task(2, "Moving", "in-progress", {
          epic: 1,
          timestamp: "2026-08-01T00:00:00Z",
        }),
        epic(3, "Blocked but recent"),
        task(4, "Waiting", "blocked", { epic: 3 }),
        epic(5, "Ready near the head"),
        task(6, "Ready", "todo", { epic: 5, rank: 20 }),
        epic(7, "Stale blocked"),
        task(8, "Old wait", "blocked", { epic: 7 }),
        task(9, "Loose moving", "in-progress"),
        task(10, "Loose next", "todo", { rank: 5 }),
        [finishedPath, finishedSource.replace("status: todo", "status: done")],
        task(12, "Shipped", "done", { epic: 11 }),
        [
          olderFinishedPath,
          olderFinishedSource.replace("status: todo", "status: done"),
        ],
        task(14, "Shipped earlier", "done", { epic: 13 }),
      ],
      [
        {
          taskId: "DKT-4",
          sha: "recent",
          date: "2026-08-05T00:00:00Z",
          subject: "blocked investigation",
        },
        {
          taskId: "DKT-8",
          sha: "old",
          date: "2026-07-01T00:00:00Z",
          subject: "old work",
        },
        {
          taskId: "DKT-12",
          sha: "finished",
          date: "2026-08-04T00:00:00Z",
          subject: "finished work",
        },
        {
          taskId: "DKT-14",
          sha: "older-finished",
          date: "2026-08-02T00:00:00Z",
          subject: "finished earlier",
        },
      ],
    );

    const model = deriveOverview(bundle, db, {
      now: new Date("2026-08-06T12:00:00Z"),
    });

    expect(model.upNext?.id).toBe("DKT-10");
    expect(readyWorkItems(bundle)[0]?.fm.id).toBe(model.upNext?.id);
    expect(model.workstreams.current.map((stream) => stream.epic.id)).toEqual([
      "DKT-3",
      "DKT-1",
      "DKT-5",
    ]);
    expect(
      model.workstreams.recentOnly.map((stream) => stream.epic.id),
    ).toEqual(["DKT-11", "DKT-13"]);
    expect(model.workstreams.current[0]).toEqual(
      expect.objectContaining({
        blockedOnly: true,
        now: [],
        next: [],
        progress: { done: 0, total: 1 },
        lastActivity: "2026-08-05T00:00:00Z",
      }),
    );
    expect(model.workstreams.current[1]?.now.map((item) => item.id)).toEqual([
      "DKT-2",
    ]);
    expect(model.workstreams.current[2]?.next.map((item) => item.id)).toEqual([
      "DKT-6",
    ]);
    expect(model.workstreams.current[2]?.nextTotal).toBe(1);
    expect(model.workstreams.recentOnly[0]).toEqual(
      expect.objectContaining({
        progress: { done: 1, total: 1 },
        needsCleanup: false,
        now: [],
        next: [],
        nextTotal: 0,
        blockedOnly: false,
      }),
    );
    expect(model.workstreams.recentOnly[1]?.needsCleanup).toBe(false);
    const classifiedIds = [
      ...model.workstreams.current,
      ...model.workstreams.recentOnly,
    ].map((stream) => stream.epic.id);
    expect(new Set(classifiedIds).size).toBe(classifiedIds.length);
    expect(classifiedIds).not.toContain("DKT-7");
    expect(model.loose?.now.map((item) => item.id)).toEqual(["DKT-9"]);
    expect(model.loose?.next.map((item) => item.id)).toEqual(["DKT-10"]);
  });

  test("caps each workstream next list without changing global up-next", async () => {
    const { bundle, db } = await fixture([
      epic(1, "Many ready"),
      task(2, "Third", "todo", { epic: 1, rank: 30 }),
      task(3, "First", "todo", { epic: 1, rank: 10 }),
      task(4, "Second", "todo", { epic: 1, rank: 20 }),
    ]);

    const model = deriveOverview(bundle, db);
    expect(model.upNext?.id).toBe("DKT-3");
    expect(model.workstreams.current[0]?.next.map((item) => item.id)).toEqual([
      "DKT-3",
      "DKT-4",
    ]);
    expect(model.workstreams.current[0]?.nextTotal).toBe(3);
  });

  test("keeps in-progress work visible even when its epic is already done", async () => {
    const [path, source] = epic(1, "Prematurely closed");
    const { bundle, db } = await fixture([
      [path, source.replace("status: todo", "status: done")],
      task(2, "Still moving", "in-progress", { epic: 1 }),
    ]);

    const model = deriveOverview(bundle, db);
    expect(model.workstreams.current[0]?.epic.status).toBe("done");
    expect(model.workstreams.current[0]?.now.map((item) => item.id)).toEqual([
      "DKT-2",
    ]);
    expect(model.workstreams.recentOnly).toEqual([]);
  });

  test("preserves a loose group admitted only by recent activity", async () => {
    const { bundle, db } = await fixture(
      [task(1, "Loose and shipped", "done")],
      [
        {
          taskId: "DKT-1",
          sha: "recent-loose",
          date: "2026-08-05T00:00:00Z",
          subject: "loose work shipped",
        },
      ],
    );

    const model = deriveOverview(bundle, db, {
      now: new Date("2026-08-06T12:00:00Z"),
    });
    expect(model.workstreams).toEqual({ current: [], recentOnly: [] });
    expect(model.loose).toEqual(
      expect.objectContaining({
        now: [],
        next: [],
        nextTotal: 0,
        blockedOnly: false,
        lastActivity: "2026-08-05T00:00:00Z",
      }),
    );
  });

  test("derives outcome-shaped execution, explicit decisions, and attention", async () => {
    const [donePath, doneSource] = task(2, "Ship summary", "done", {
      epic: 1,
      timestamp: "2026-08-05T00:00:00Z",
    });
    const { bundle, db } = await fixture([
      epic(1, "Briefing"),
      [
        donePath,
        doneSource.replace(
          "\nx\n",
          "\n# Outcome\n\nReturning readers now get a **shared summary**.\n",
        ),
      ],
      task(3, "Build next layer", "in-progress", {
        epic: 1,
        timestamp: "2026-08-06T00:00:00Z",
      }),
      task(4, "Waiting on evidence", "blocked", { epic: 1 }),
      task(5, "Queued follow-up", "todo", { epic: 1 }),
      task(6, "Declined follow-up", "closed", {
        epic: 1,
        timestamp: "2026-08-06T12:00:00Z",
      }),
      decision(1, "One model", "2026-08-05T12:00:00Z"),
    ]);

    const model = deriveOverview(bundle, db, {
      now: new Date("2026-08-07T00:00:00Z"),
      checkpoint: { revision: "abcdef1", time: "2026-08-06T00:00:00Z" },
      historyAvailable: true,
      decisionLinks: ["/decisions/DEC-1.md"],
    });

    expect(model.execution.checkpoint).toEqual({
      revision: "abcdef1",
      time: "2026-08-06T12:00:00Z",
    });
    expect(model.execution.scope).toEqual(
      expect.objectContaining({
        mode: "shared-recent",
        fallback: "first-visit",
      }),
    );
    expect(model.execution.shipped[0]).toEqual(
      expect.objectContaining({
        id: "DKT-2",
        summary: "Returning readers now get a shared summary.",
        supportingConcepts: [expect.objectContaining({ id: "DKT-1" })],
      }),
    );
    expect(model.execution.shipped.map((item) => item.id)).not.toContain(
      "DKT-6",
    );
    expect(model.execution.inFlight.map((item) => item.id)).toEqual(["DKT-3"]);
    expect(model.execution.upNext.map((item) => item.id)).toEqual(["DKT-5"]);
    expect(model.execution.needsAttention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "DKT-4", reason: "blocked" }),
      ]),
    );
    expect(model.execution.changes.map((item) => item.change)).toContain(
      "completed",
    );
    expect(model.execution.changes).toContainEqual(
      expect.objectContaining({ id: "DKT-6", change: "closed" }),
    );
    expect(model.execution.decisions[0]).toEqual(
      expect.objectContaining({
        id: "DEC-1",
        choice: "Use one shared model.",
        rationale: "The old path caused drift.",
        consequence: "Home and agents agree.",
        curated: true,
      }),
    );
  });

  test("uses one deterministic shared-recent window", async () => {
    const { bundle, db } = await fixture([
      task(1, "Earlier", "done", { timestamp: "2026-07-01T00:00:00Z" }),
      task(2, "Later", "done", { timestamp: "2026-08-06T00:00:00Z" }),
    ]);
    const model = deriveOverview(bundle, db, {
      now: new Date("2026-08-07T00:00:00Z"),
      historyAvailable: true,
    });
    expect(model.execution.scope).toEqual({
      mode: "shared-recent",
      after: "2026-07-24T00:00:00.000Z",
      requested: null,
      fallback: "first-visit",
    });
    expect(model.execution.shipped.map((item) => item.id)).toEqual(["DKT-2"]);
  });

  test("surfaces stale active work and cleanup-needed epics without recent commits", async () => {
    const { bundle, db } = await fixture([
      epic(1, "Needs reconciliation", "2026-07-01T00:00:00Z"),
      task(2, "Already done", "done", {
        epic: 1,
        timestamp: "2026-07-02T00:00:00Z",
      }),
      epic(3, "Slow stream"),
      task(4, "Still active", "in-progress", {
        epic: 3,
        timestamp: "2026-07-03T00:00:00Z",
      }),
    ]);
    const model = deriveOverview(bundle, db, {
      now: new Date("2026-08-07T00:00:00Z"),
      historyAvailable: true,
    });
    expect(model.execution.needsAttention).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "DKT-1", reason: "needs-cleanup" }),
        expect.objectContaining({ id: "DKT-4", reason: "stale" }),
      ]),
    );
  });

  test("an empty bundle produces an empty model", async () => {
    const { bundle, db } = await fixture([]);
    expect(deriveOverview(bundle, db)).toEqual({
      upNext: null,
      workstreams: { current: [], recentOnly: [] },
      loose: null,
      execution: {
        checkpoint: { revision: null, time: null },
        scope: {
          mode: "history-unavailable",
          after: null,
          requested: null,
          fallback: "history-unavailable",
        },
        shipped: [],
        inFlight: [],
        upNext: [],
        needsAttention: [],
        changes: [],
        decisions: [],
      },
    });
  });
});
