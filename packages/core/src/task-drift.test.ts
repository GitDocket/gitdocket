import { expect, test } from "bun:test";
import {
  overviewDrift,
  TASK_DRIFT_MAX_BYTES,
  taskDriftReceipt,
} from "./task-drift";
import type { TaskProgressEvidence } from "./task-observations";

const evidence = (): TaskProgressEvidence => ({
  observedAt: "2026-09-30T00:00:00Z",
  complete: true,
  diagnostics: [],
  observations: [],
  tasks: [
    {
      id: "RS-501",
      title: "Fixture",
      localStatus: "todo",
      localVersion: "a".repeat(64),
      localPath: "work/tasks/item.md",
      state: "observed",
      pickedUpElsewhere: false,
      observations: [
        {
          task: {
            id: "RS-501",
            path: "work/tasks/item.md",
            title: "Fixture",
            status: "done",
            version: "b".repeat(64),
          },
          base: {
            id: "RS-501",
            path: "work/tasks/item.md",
            title: "Fixture",
            status: "todo",
            version: "a".repeat(64),
          },
          baselineAvailable: true,
          baselineRevision: "1".repeat(40),
          head: "2".repeat(40),
          refs: ["refs/heads/closeout"],
          worktree: null,
          active: false,
          uncommitted: false,
          integrated: false,
          committed: {
            task: {
              id: "RS-501",
              path: "work/tasks/item.md",
              title: "Fixture",
              status: "done",
              version: "b".repeat(64),
            },
            integrated: false,
            compatible: true,
            configuration: {
              project: "RS",
              bundle: "docket",
              version: "c".repeat(64),
              origin: "committed",
            },
          },
        },
      ],
    },
  ],
});

test("terminal closeout warnings use compatible committed progress and preserve local authority", () => {
  const e = evidence();
  const before = JSON.stringify(e);
  const receipt = taskDriftReceipt("RS-501", e);
  expect(receipt.authority).toBe("advisory");
  expect(receipt.local.status).toBe("todo");
  expect(receipt.warnings[0]?.code).toBe("terminal-closeout-unmerged");
  expect(receipt.sources[0]?.committed?.status).toBe("done");
  expect(JSON.stringify(e)).toBe(before);
  const row = e.tasks[0]?.observations[0];
  if (!row?.committed?.task || !row.base)
    throw new Error("Missing fixture source");
  row.committed.task.status = "closed";
  expect(taskDriftReceipt("RS-501", e).warnings[0]?.code).toBe(
    "terminal-closeout-unmerged",
  );
  row.committed.integrated = true;
  expect(
    taskDriftReceipt("RS-501", e).warnings.some(
      (w) => w.code === "terminal-closeout-unmerged",
    ),
  ).toBe(false);
  row.committed.integrated = false;
  row.committed.compatible = false;
  expect(
    taskDriftReceipt("RS-501", e).warnings.some(
      (w) => w.code === "terminal-closeout-unmerged",
    ),
  ).toBe(false);
  row.committed.compatible = true;
  row.base.status = "closed";
  expect(
    taskDriftReceipt("RS-501", e).warnings.some(
      (w) => w.code === "terminal-closeout-unmerged",
    ),
  ).toBe(false);
  expect(
    taskDriftReceipt("RS-501", e).warnings.some(
      (w) => w.code === "local-reopening",
    ),
  ).toBe(true);
  row.base.status = "todo";
  row.committed.task.status = "todo";
  row.uncommitted = true;
  expect(
    taskDriftReceipt("RS-501", e).warnings.some(
      (w) => w.code === "terminal-closeout-unmerged",
    ),
  ).toBe(false);
});

test("source-heavy task and overview advisories are bounded with explicit omission, never cropped usable identities", () => {
  const e = evidence();
  const row = e.tasks[0];
  if (!row?.observations[0]) throw new Error("Missing fixture");
  row.localPath = "p".repeat(1000);
  row.state = "conflict";
  row.pickedUpElsewhere = true;
  const observation = row.observations[0];
  row.observations = Array.from({ length: 40 }, () => ({
    ...observation,
    worktree: `/${"w".repeat(1000)}`,
    refs: ["r".repeat(1000), "refs/heads/a", "refs/heads/b"],
  }));
  e.complete = false;
  const receipt = taskDriftReceipt(row.id, e);
  expect(
    Buffer.byteLength(JSON.stringify(receipt, null, 2)),
  ).toBeLessThanOrEqual(TASK_DRIFT_MAX_BYTES);
  expect(receipt.omittedSources).toBeGreaterThan(0);
  expect(receipt.local.path).toBeNull();
  expect(receipt.sources[0]).toMatchObject({ worktreeOmitted: true });
  expect(receipt.warnings.some((w) => w.code === "evidence-incomplete")).toBe(
    true,
  );
  e.tasks = Array.from({ length: 30 }, (_, n) => ({
    ...row,
    id: `RS-${n + 1}`,
  }));
  const overview = overviewDrift(e);
  expect(
    Buffer.byteLength(JSON.stringify(overview, null, 2)),
  ).toBeLessThanOrEqual(4096);
  expect(overview.observedTotal).toBe(30);
  expect(overview.omitted).toBeGreaterThan(0);
});

test("marker-only unavailable metadata retains bounded pickup locations and explicit uncertainty", () => {
  const e = evidence();
  const row = e.tasks[0];
  if (!row) throw new Error("Missing fixture");
  row.observations = [];
  row.pickedUpElsewhere = true;
  row.state = "unavailable";
  row.pickupSources = [
    "/fixture/worker-a",
    "/fixture/worker-b",
    "/fixture/worker-c",
    "p".repeat(1000),
  ];
  e.complete = false;
  const receipt = taskDriftReceipt(row.id, e);
  expect(receipt).toMatchObject({
    pickupSources: ["/fixture/worker-a", "/fixture/worker-b"],
    omittedPickupSources: 2,
    complete: false,
  });
  expect(receipt.warnings.map((w) => w.code)).toContain("foreign-pickup");
  expect(receipt.warnings.map((w) => w.code)).toContain("evidence-incomplete");
  expect(
    Buffer.byteLength(JSON.stringify(receipt, null, 2)),
  ).toBeLessThanOrEqual(TASK_DRIFT_MAX_BYTES);
});
