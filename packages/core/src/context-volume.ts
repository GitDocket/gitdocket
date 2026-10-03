/** Scoped, ephemeral review. Caller observations never enter telemetry storage. */
import { z } from "zod";

export const CONTEXT_REVIEW_MAX_BYTES = 8192;
const count = z.number().int().nonnegative().max(1000000000);
const version = z.string().regex(/^[a-f0-9]{64}$/);
const observation = z
  .object({
    schema: z.literal("docket-context-observation/v1"),
    sourceVersion: version.optional(),
    lintInputVersion: version.optional(),
    responseBytes: count.optional(),
    advertisedSchemaBytes: count.optional(),
    advertisedInstructionBytes: count.optional(),
    advertisedToolCount: count.optional(),
    hostLoadedBytes: count.optional(),
    host: z
      .object({
        provenance: z.enum(["host-reported", "caller-estimate"]),
        kind: z.enum(["current-context", "cumulative-usage"]),
        model: z.enum([
          "gpt-6",
          "gpt-5",
          "claude",
          "gemini",
          "other",
          "unknown",
        ]),
        observedAt: z.string().datetime(),
        tokens: count,
        windowTokens: count.positive().nullable(),
        partial: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
type Observation = z.infer<typeof observation>;
export function readContextObservation(
  value: unknown,
): Observation | undefined {
  const parsed = observation.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
export interface ContextContribution {
  ref: string;
  turn: number;
  item: number;
  epoch: number;
  family: string;
  surface: string;
  resource: string | null;
  /** Supplied export text is an observed representation, never reconstructed emitted bytes. */
  exportTextBytes: number | null;
  outputCoverage: "partial-or-unknown";
  observed?: Observation;
  invalidObservation: boolean;
}
export function contextEquality(
  rows: readonly ContextContribution[],
  field: "sourceVersion" | "lintInputVersion",
) {
  const versions = rows.map((row) => row.observed?.[field]);
  if (!rows.length || versions.some((v) => !v)) return "unknown";
  return new Set(versions).size === 1
    ? "same-version-evidence"
    : "changed-version-evidence";
}

export function reviewContextVolume(
  rows: ContextContribution[],
  compactions: { turn: number; item: number }[],
  coverage: { hasMore: boolean; omitted: number },
  now = new Date(),
) {
  const known = rows.filter((r) => r.exportTextBytes !== null);
  const measured = rows.filter((r) => r.observed?.responseBytes !== undefined);
  const groups = new Map<string, ContextContribution[]>();
  for (const r of rows) {
    if (!r.resource) continue;
    const key = `${r.turn}/${r.resource}`;
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  const repeats = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      turn: g[0]?.turn,
      resource: g[0]?.resource,
      calls: g.length,
      sourceEquality: contextEquality(g, "sourceVersion"),
      contextAvailability:
        new Set(g.map((r) => r.epoch)).size > 1
          ? "compaction-observed-between-reads"
          : "unknown",
      observedExportTextBytes: g.some((r) => r.exportTextBytes !== null)
        ? g.reduce((n, r) => n + (r.exportTextBytes ?? 0), 0)
        : null,
      evidence: g.slice(0, 4).map((r) => r.ref),
      omittedEvidence: Math.max(0, g.length - 4),
    }))
    .sort((a, b) => b.calls - a.calls);
  const hostRows = rows.filter((r) => r.observed?.host);
  const host = hostRows.slice(-4).map((r) => {
    const h = r.observed?.host as NonNullable<Observation["host"]>;
    const ageMs = now.getTime() - Date.parse(h.observedAt);
    const validDenominator =
      h.windowTokens !== null && h.tokens <= h.windowTokens;
    const actualCurrent =
      h.kind === "current-context" && h.provenance === "host-reported";
    return {
      ref: r.ref,
      provenance: h.provenance,
      verification: "supplied by caller; no native host query",
      kind: h.kind,
      model: h.model,
      observedAt: h.observedAt,
      freshness:
        ageMs < 0
          ? "future-observation"
          : ageMs > 300000
            ? "older-than-five-minutes"
            : "within-five-minutes",
      partial: h.partial,
      tokens: h.tokens,
      windowTokens: h.windowTokens,
      currentWindowPercent:
        actualCurrent && validDenominator && !h.partial
          ? Math.round((h.tokens / (h.windowTokens as number)) * 10000) / 100
          : null,
      denominatorStatus:
        h.windowTokens === null
          ? "unavailable"
          : !validDenominator
            ? "inconsistent"
            : "supplied",
      overloadThreshold: null,
    };
  });
  const advertised = rows
    .filter(
      (r) =>
        r.observed &&
        (r.observed.advertisedSchemaBytes !== undefined ||
          r.observed.advertisedInstructionBytes !== undefined ||
          r.observed.advertisedToolCount !== undefined),
    )
    .slice(-4)
    .map((r) => ({
      ref: r.ref,
      provenance: "caller-supplied observation",
      schemaBytes: r.observed?.advertisedSchemaBytes ?? null,
      instructionBytes: r.observed?.advertisedInstructionBytes ?? null,
      toolCount: r.observed?.advertisedToolCount ?? null,
    }));
  const loaded = rows
    .filter((r) => r.observed?.hostLoadedBytes !== undefined)
    .slice(-4)
    .map((r) => ({
      ref: r.ref,
      provenance: "caller-supplied host-loaded observation",
      bytes: r.observed?.hostLoadedBytes,
    }));
  let largest = known
    .slice()
    .sort((a, b) => (b.exportTextBytes ?? 0) - (a.exportTextBytes ?? 0))
    .slice(0, 8)
    .map((r) => ({
      ref: r.ref,
      family: r.family,
      surface: r.surface,
      exportTextBytes: r.exportTextBytes,
      coverage: r.outputCoverage,
    }));
  let repeated = repeats.slice(0, 6);
  let windows = compactions.slice(0, 4).map((c) => ({
    ref: `turn:${c.turn}/item:${c.item}`,
    before: rows
      .filter((r) => r.turn === c.turn && r.item < c.item)
      .slice(-2)
      .map((r) => r.ref),
    after: rows
      .filter((r) => r.turn === c.turn && r.item > c.item)
      .slice(0, 2)
      .map((r) => r.ref),
    interpretation:
      "recorded activity; reconstruction need and retained host context unknown",
  }));
  const build = () => ({
    schema: "docket-context-volume/v1",
    observedAt: now.toISOString(),
    scope: "supplied trace only; not joined to telemetry sessions",
    coverage: {
      ...coverage,
      matchedCalls: rows.length,
      exportOutputKnownCalls: known.length,
      exportOutputUnknownCalls: rows.length - known.length,
      callerMeasuredResponseCalls: measured.length,
      invalidObservations: rows.filter((r) => r.invalidObservation).length,
      outputCompleteness:
        "partial or unknown; summaries/truncation may omit content",
    },
    emittedDocketResponses: {
      provenance: "explicit caller-supplied measurements",
      bytes: measured.length
        ? measured.reduce((n, r) => n + (r.observed?.responseBytes ?? 0), 0)
        : null,
      knownCalls: measured.length,
      unknownCalls: rows.length - measured.length,
      attribution: "whole matched calls; compound output is not apportioned",
    },
    suppliedExportOutput: {
      bytes: known.length
        ? known.reduce((n, r) => n + (r.exportTextBytes ?? 0), 0)
        : null,
      scope:
        "UTF-8 supplied output text; not original emitted bytes, protocol overhead or current occupancy",
    },
    largest,
    omittedLargest: known.length - largest.length,
    repeatedReads: repeated,
    omittedRepeatedGroups: repeats.length - repeated.length,
    compactionWindows: windows,
    compactions: compactions.length,
    omittedCompactions: compactions.length - windows.length,
    advertised: {
      status: advertised.length ? "caller-supplied" : "unavailable",
      observations: advertised,
      omittedObservations:
        rows.filter(
          (r) =>
            r.observed &&
            (r.observed.advertisedSchemaBytes !== undefined ||
              r.observed.advertisedInstructionBytes !== undefined ||
              r.observed.advertisedToolCount !== undefined),
        ).length - advertised.length,
      hostLoadedMaterial: "not inferred from advertisement",
    },
    hostLoadedMaterial: {
      status: loaded.length ? "caller-supplied" : "unavailable",
      observations: loaded,
      omittedObservations:
        rows.filter((r) => r.observed?.hostLoadedBytes !== undefined).length -
        loaded.length,
    },
    hostContext: {
      status: host.length ? "caller-supplied" : "unavailable",
      currentOccupancyStatus: host.some(
        (h) =>
          h.kind === "current-context" &&
          h.provenance === "host-reported" &&
          !h.partial,
      )
        ? "caller-supplied-at-observed-time"
        : "unavailable",
      observations: host,
      omittedObservations: hostRows.length - host.length,
      estimatedTokens: null,
      occupancyFromResponseBytes: null,
      universalOverloadThreshold: null,
    },
    details: { cli: "docket telemetry report --trace <supplied-file> --json" },
    limits: [
      "Volume and frequency are investigation evidence, not proven waste or degraded reasoning.",
      "Version equality is available only from explicit caller annotations; lost context and required revalidation remain separate concerns.",
      "Host observations are scoped to this supplied export; no automatic monitoring, inferred sessions or occupancy estimate.",
      "Raw outputs, paths, source versions, tool schemas and host prompts are not returned or stored. Resource IDs are salted per analysis.",
      "Input/report exports are caller-owned and outside telemetry retention/deletion. This review adds no operation event or per-call model round trip.",
    ],
  });
  let report = build();
  while (
    Buffer.byteLength(JSON.stringify(report, null, 2)) >
    CONTEXT_REVIEW_MAX_BYTES
  ) {
    if (largest.length) largest = largest.slice(0, -1);
    else if (repeated.length) repeated = repeated.slice(0, -1);
    else if (windows.length) windows = windows.slice(0, -1);
    else if (host.length) host.shift();
    else if (advertised.length) advertised.shift();
    else if (loaded.length) loaded.shift();
    else throw new Error("Context review metadata exceeds its bounded budget.");
    report = build();
  }
  return report;
}
