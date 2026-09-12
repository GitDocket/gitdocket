import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dimensionsSchema, type OperationEvent } from "./telemetry";
import { renderUsageReport, usageReport } from "./telemetry-report";

const project = randomUUID();
const runtime = randomUUID();
const workflow = randomUUID();
function event(overrides: Partial<OperationEvent> = {}): OperationEvent {
  return {
    schema: 1,
    id: randomUUID(),
    kind: "operation",
    time: 10000,
    project,
    runtime,
    uptimeMs: 100,
    version: "0.1.1",
    surface: "mcp",
    operation: "search",
    durationMs: 10,
    outcome: "success",
    error: "none",
    trigger: "explicit",
    actor: "unknown",
    host: "unknown",
    workflow: null,
    before: dimensionsSchema.parse({}),
    after: dimensionsSchema.parse({}),
    work: null,
    dropped: 0,
    ...overrides,
  };
}
test("empty and sparse samples do not invent percentiles, denominators or coverage", () => {
  const empty = usageReport([], { until: 20000 });
  expect(empty.coverage.observedOperations).toBe(0);
  expect(empty.workflows.possibleRepeats).toBeNull();
  expect(empty.workflows.perTask).toBeNull();
  expect(empty.memory.provenConcurrentResidency).toBeNull();
  expect(renderUsageReport(empty)).toContain("No observations");
  const sparse = usageReport([event()], { until: 20000 });
  expect(sparse.candidates[0]?.p50Ms).toBeNull();
  expect(sparse.candidates[0]?.p95Ms).toBeNull();
  expect(sparse.coverage.collectionUptime).toBeNull();
  expect(sparse.historicalBaseline.available).toBe(false);
});
test("deduplicates identical events and excludes conflicting IDs and invalid records", () => {
  const one = event();
  const two = event();
  const report = usageReport(
    [one, one, two, { ...two, durationMs: 99 }, { ...event(), schema: 2 }],
    { until: 20000 },
  );
  expect(report.coverage.observedOperations).toBe(1);
  expect(report.coverage.duplicates).toBe(2);
  expect(report.coverage.conflictingIds).toBe(1);
  expect(report.coverage.invalid).toBe(1);
});
test("window/project filters, trigger mix, ranks and cold/workload breakdowns use correct samples", () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    event({
      durationMs: i + 1,
      time: 10000 + i * 100,
      before: dimensionsSchema.parse({
        indexState: i === 0 ? "uninitialized" : "metadata",
      }),
      after: dimensionsSchema.parse({ indexState: "metadata", concepts: 500 }),
    }),
  );
  const report = usageReport(
    [
      ...events,
      event({ project: randomUUID() }),
      event({ time: 1 }),
      event({ trigger: "background", operation: "overview" }),
    ],
    { since: 9999, until: 20000, projects: [project], friction: ["overview"] },
  );
  expect(report.coverage.observedOperations).toBe(21);
  expect(report.candidates[0]?.ownerFlag).toBe(true);
  const search = report.candidates.find((e) => e.operation === "search");
  expect(search?.p50Ms).toBe(10);
  expect(search?.p95Ms).toBe(19);
  expect(search?.totalWaitMs).toBe(210);
  expect(report.surfaceMix[0]?.background).toBe(1);
  expect(report.breakdowns.find((e) => e.phase === "first_load")?.n).toBe(1);
  expect(
    report.breakdowns.every(
      (e) => e.operation !== "search" || e.workload === "100_to_999",
    ),
  ).toBe(true);
});
test("only explicit non-overlapping workflows yield sequences; unknown/background calls are excluded", () => {
  const other = randomUUID();
  const events = [
    event({ operation: "overview", workflow, time: 1000 }),
    event({ workflow, time: 1100 }),
    event({ workflow, time: 1200 }),
    event({ workflow: other, time: 1110, durationMs: 50 }),
    event({ workflow: other, time: 1120, durationMs: 50 }),
    event({
      workflow,
      trigger: "background",
      operation: "task_close",
      time: 1300,
    }),
    event({ operation: "task_close", time: 1400 }),
  ];
  const report = usageReport(events, { until: 20000 });
  expect(report.workflows.n).toBe(2);
  expect(report.workflows.possibleRepeats).toBe(1);
  expect(report.workflows.overlappingPairsExcluded).toBe(1);
  expect(report.workflows.orientationFollowups).toBe(1);
  expect(report.workflows.administrativePerWorkflow).toBe(0);
  expect(report.workflows.observedOperations).toBe(5);
});
test("memory samples preserve uptime/state, bound examples, and never infer leaks or residency", () => {
  const sample = (time: number, runtime: string, rss: number) => ({
    schema: 1,
    id: randomUUID(),
    kind: "runtime",
    time,
    project,
    runtime,
    uptimeMs: time - 100,
    version: "0.1.1",
    surface: "mcp",
    rss,
    dimensions: dimensionsSchema.parse({ indexState: "search" }),
  });
  const second = randomUUID();
  const report = usageReport(
    [
      sample(1000, runtime, 100),
      sample(3000, runtime, 200),
      sample(2000, second, 500),
      sample(4000, second, 400),
    ],
    { until: 10000 },
  );
  expect(report.memory.observedIntervalOverlapPairs).toBe(1);
  expect(report.memory.provenConcurrentResidency).toBeNull();
  expect(
    report.memory.instances.find((e) => e.runtime === runtime)?.maxRss,
  ).toBe(200);
  expect(report.memory.instances[0]?.samples[0]?.indexState).toBe("search");
});
test("reported losses/retention are exposed; unknown attribution and invalid dates stay explicit", () => {
  const report = usageReport([event({ dropped: 3 })], {
    since: 1,
    until: 20000,
  });
  expect(report.coverage.reportedDrops).toBe(3);
  expect(report.coverage.retentionMayOmitEarlierData).toBe(true);
  expect(report.coverage.unknownHost).toBe(1);
  expect(report.coverage.firstObserved).toBe(10000);
  expect(() => usageReport([], { since: NaN })).toThrow();
  expect(() => usageReport([], { since: 10, until: 1 })).toThrow();
});
