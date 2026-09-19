import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dimensionsSchema, type OperationEvent } from "./telemetry";
import {
  renderUsageReport,
  renderUsageWindows,
  usageReport,
  usageWindows,
} from "./telemetry-report";

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
    resultCount: null,
    resultTotal: null,
    responseBytes: null,
    truncated: null,
    failureReason: null,
    saveState: null,
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

test("empty search, truncated results and commit-failed saves stay distinct reporting fixtures", () => {
  const empty = event({
    resultCount: 0,
    resultTotal: 0,
    truncated: "none",
  });
  const truncated = event({
    resultCount: 10,
    resultTotal: 24,
    truncated: "results",
    workflow,
    time: 10000,
  });
  const failed = event({
    operation: "edit_save",
    outcome: "success",
    saveState: "commit_failed",
    workflow,
    time: 10200,
  });
  const recovered = event({
    operation: "edit_save",
    time: 11000,
    saveState: "saved_locally",
    workflow,
  });
  const report = usageReport([empty, truncated, failed, recovered], {
    until: 20000,
  });
  expect(empty.resultCount).toBe(0);
  expect(truncated.truncated).toBe("results");
  expect(failed.saveState).toBe("commit_failed");
  expect(report.workflows.n).toBe(1);
  expect(report.workflows.possibleRepeats).toBe(1);
  expect(report.outcomes.emptySearch).toBe(1);
  expect(report.outcomes.nonemptySearch).toBe(1);
  expect(report.outcomes.truncated.results).toBe(1);
  expect(report.outcomes.saveStates.commitFailed).toBe(1);
  expect(report.outcomes.saveStates.savedLocally).toBe(1);
  expect(report.outcomes.possibleRecovery).toEqual([]);
});

test("reports attribution coverage, inventory zeros, MCP silence and possible recovery without rewriting history", () => {
  const historical = event({
    actor: "unknown",
    host: "unknown",
    workflow: null,
    resultCount: null,
    version: "0.3.1",
    time: 1000,
  });
  const attributed = event({
    actor: "agent",
    host: "cursor",
    workflow,
    operation: "ready",
    time: 2000,
    version: "0.4.1",
  });
  const failed = event({
    actor: "agent",
    host: "cursor",
    workflow,
    operation: "ready",
    outcome: "error",
    error: "validation",
    failureReason: "unsupported",
    time: 3000,
    durationMs: 10,
    version: "0.4.1",
  });
  const recovered = event({
    actor: "agent",
    host: "cursor",
    workflow,
    operation: "ready",
    time: 4000,
    durationMs: 10,
    version: "0.4.1",
  });
  const overlapping = event({
    actor: "agent",
    host: "cursor",
    workflow,
    operation: "ready",
    outcome: "error",
    time: 5100,
    durationMs: 200,
    version: "0.4.1",
  });
  const stillOpen = event({
    actor: "agent",
    host: "cursor",
    workflow,
    operation: "ready",
    time: 5050,
    durationMs: 10,
    version: "0.4.1",
  });
  const report = usageReport(
    [historical, attributed, failed, recovered, overlapping, stillOpen],
    { until: 20000 },
  );
  expect(historical.actor).toBe("unknown");
  expect(report.coverage.knownActor).toBe(5);
  expect(report.coverage.unknownActor).toBe(1);
  expect(report.coverage.mcpSilence).toBeNull();
  expect(report.attribution).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        surface: "mcp",
        project,
        version: "0.3.1",
        unknownActor: 1,
        correlated: 0,
      }),
      expect.objectContaining({
        surface: "mcp",
        version: "0.4.1",
        knownActor: 5,
        correlated: 5,
      }),
    ]),
  );
  expect(report.versionMix.map((row) => row.version)).toEqual([
    "0.3.1",
    "0.4.1",
  ]);
  expect(report.outcomes.unknownSearchCount).toBe(1);
  expect(report.outcomes.failureReasons).toEqual([
    { reason: "unsupported", n: 1 },
  ]);
  expect(report.outcomes.possibleRecovery).toEqual([
    {
      workflow,
      operation: "ready",
      evidenceIds: [failed.id, recovered.id],
    },
  ]);
  expect(
    report.inventory.supported.find((row) => row.operation === "search")?.n,
  ).toBe(1);
  expect(
    report.inventory.supported.find((row) => row.operation === "edit_open")
      ?.interpretation,
  ).toBe("observed_zero_or_unobserved");
  expect(report.inventory.uninstrumented.length).toBeGreaterThan(0);
  expect(
    report.inventory.excluded.some((row) => row.id === "telemetry report"),
  ).toBe(true);
  const silent = usageReport([event({ surface: "cli", operation: "ready" })], {
    until: 20000,
  });
  expect(silent.coverage.mcpOperations).toBe(0);
  expect(silent.coverage.mcpSilence).toBe(
    "no_mcp_observations_not_proof_of_no_mcp_usage",
  );
  expect(renderUsageReport(silent)).toContain("not proof MCP was unused");
});

test("current-state windows keep 24h, 7d and full-sample bounds beside the selected window", () => {
  const now = 20 * 86400000;
  const windows = usageWindows(
    [
      event({ time: 1000, operation: "ready" }),
      event({ time: now - 2 * 86400000, operation: "overview" }),
      event({ time: now - 3600000, operation: "search" }),
    ],
    { until: now },
  );
  expect(windows.asOf).toBe(now);
  expect(windows.hours24.coverage.observedOperations).toBe(1);
  expect(windows.days7.coverage.observedOperations).toBe(2);
  expect(windows.fullPilot.coverage.observedOperations).toBe(3);
  expect(windows.selected.coverage.observedOperations).toBe(2);
  expect(windows.hours24.window.since).toBe(now - 86400000);
  expect(renderUsageWindows(windows)).toContain("Last 24 hours:");
});
