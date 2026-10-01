import { expect, test } from "bun:test";
import { analyzeDocketTrace } from "./telemetry-trace";

const stamp = "2026-10-01T00:00:00Z";
const version = "a".repeat(64);
const call = (
  command: string,
  observed: Record<string, unknown> = {},
  output?: string,
) => ({
  type: "commandExecution",
  command,
  cwd: "/PRIVATE/path",
  exitCode: 0,
  output,
  docketContext: { schema: "docket-context-observation/v1", ...observed },
});
const trace = (items: unknown[], extra = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    page: { hasMore: false },
    turns: [{ items }],
    ...extra,
  });
test("context review counts each matched call once and separates export representation, measured responses and missing host data", () => {
  const r = analyzeDocketTrace(
    trace([
      call(
        "docket lint; docket index",
        { responseBytes: 2000 },
        "私".repeat(500),
      ),
      {
        type: "commandExecution",
        command: "docket overview",
        cwd: "/PRIVATE/path",
      },
    ]),
  ).contextVolume;
  expect(r.coverage).toMatchObject({
    matchedCalls: 2,
    exportOutputKnownCalls: 1,
    exportOutputUnknownCalls: 1,
    callerMeasuredResponseCalls: 1,
  });
  expect(r.suppliedExportOutput.bytes).toBe(1500);
  expect(r.emittedDocketResponses.bytes).toBe(2000);
  expect(r.hostContext).toMatchObject({
    status: "unavailable",
    currentOccupancyStatus: "unavailable",
    estimatedTokens: null,
    occupancyFromResponseBytes: null,
  });
  expect(r.advertised.status).toBe("unavailable");
  expect(r.hostLoadedMaterial.status).toBe("unavailable");
  expect(JSON.stringify(r)).not.toMatch(/PRIVATE|私|docket lint;/);
});
test("versions distinguish changed-source reads and unchanged continuation without treating compaction as waste", () => {
  const r = analyzeDocketTrace(
    trace([
      call("cat docket/workflows/close.md", { sourceVersion: version }),
      call("cat docket/workflows/close.md", { sourceVersion: version }),
      { type: "contextCompaction" },
      call("cat docket/workflows/close.md", { sourceVersion: version }),
      call("cat docket/workflows/pickup.md", { sourceVersion: version }),
      call("cat docket/workflows/pickup.md", { sourceVersion: "b".repeat(64) }),
    ]),
  );
  expect(r.contextVolume.repeatedReads.map((g) => g.sourceEquality)).toEqual([
    "same-version-evidence",
    "changed-version-evidence",
  ]);
  expect(r.contextVolume.repeatedReads[0]?.contextAvailability).toBe(
    "compaction-observed-between-reads",
  );
  expect(r.contextVolume.compactions).toBe(1);
  expect(JSON.stringify(r)).not.toContain(version);
  expect(r.candidates[0]?.sourceEquality).toBe("same-version-evidence");
});
test("supplied host measurements retain provenance and denominator; cumulative, estimated and partial usage cannot become occupancy", () => {
  const host = {
    provenance: "host-reported",
    kind: "current-context",
    model: "gpt-6",
    observedAt: stamp,
    tokens: 6000,
    windowTokens: 20000,
    partial: false,
  };
  const r = analyzeDocketTrace(
    trace([
      call("docket overview", {
        host,
        advertisedSchemaBytes: 12000,
        advertisedInstructionBytes: 1000,
        advertisedToolCount: 30,
      }),
      call("docket overview", { host: { ...host, kind: "cumulative-usage" } }),
      call("docket overview", {
        host: { ...host, provenance: "caller-estimate" },
      }),
      call("docket overview", {
        host: { ...host, partial: true },
        hostLoadedBytes: 500,
      }),
    ]),
  ).contextVolume;
  expect(r.hostContext.observations.map((h) => h.currentWindowPercent)).toEqual(
    [30, null, null, null],
  );
  expect(r.hostContext.observations[0]?.denominatorStatus).toBe("supplied");
  expect(r.hostContext.observations[0]?.observedAt).toBe(stamp);
  expect(r.advertised.observations[0]?.schemaBytes).toBe(12000);
  expect(r.hostLoadedMaterial.observations[0]?.bytes).toBe(500);
  expect(r.hostContext.universalOverloadThreshold).toBeNull();
});
test("large inventories, partial exports and invalid/private metadata stay bounded with explicit omissions", () => {
  const items = Array.from({ length: 150 }, (_, i) => [
    call(
      `cat docket/workflows/${i}.md`,
      { sourceVersion: version },
      "PRIVATE output ".repeat(20),
    ),
    call(`cat docket/workflows/${i}.md`, { sourceVersion: version }),
  ]).flat();
  items.push(call("docket overview", { host: { PRIVATE: "never returned" } }));
  const r = analyzeDocketTrace(
    trace(items, { page: { hasMore: true } }),
  ).contextVolume;
  expect(Buffer.byteLength(JSON.stringify(r, null, 2))).toBeLessThanOrEqual(
    8192,
  );
  expect(r.omittedRepeatedGroups).toBeGreaterThan(0);
  expect(r.omittedLargest).toBeGreaterThan(0);
  expect(r.coverage).toMatchObject({ hasMore: true, invalidObservations: 1 });
  expect(JSON.stringify(r)).not.toMatch(/PRIVATE|\/path|"sourceVersion"/);
});

test("missing/inconsistent host windows and oversized advertisements retain unavailable dimensions", () => {
  const host = {
    provenance: "host-reported",
    kind: "current-context",
    model: "unknown",
    observedAt: "2099-01-01T00:00:00.000Z",
    tokens: 20,
    windowTokens: null,
    partial: false,
  };
  const r = analyzeDocketTrace(
    trace([
      call("docket overview", {
        host,
        advertisedSchemaBytes: 1000000000,
        advertisedToolCount: 1000000000,
      }),
      call("docket overview", { host: { ...host, windowTokens: 10 } }),
      call("docket overview", { advertisedSchemaBytes: 1000000001 }),
    ]),
  ).contextVolume;
  expect(r.hostContext.observations.map((h) => h.currentWindowPercent)).toEqual(
    [null, null],
  );
  expect(r.hostContext.observations.map((h) => h.denominatorStatus)).toEqual([
    "unavailable",
    "inconsistent",
  ]);
  expect(r.hostContext.observations[0]?.freshness).toBe("future-observation");
  expect(r.coverage.invalidObservations).toBe(1);
  expect(r.hostLoadedMaterial.status).toBe("unavailable");
  expect(r.advertised.observations[0]?.toolCount).toBe(1000000000);
  expect(Buffer.byteLength(JSON.stringify(r, null, 2))).toBeLessThanOrEqual(
    8192,
  );
});
