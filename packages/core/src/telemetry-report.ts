import {
  eventSchema,
  type Limits,
  limitsSchema,
  OPERATIONS,
  type Operation,
  type OperationEvent,
  type UsageEvent,
} from "./telemetry";
import { TELEMETRY_COVERAGE } from "./telemetry-coverage";

const ADMIN = new Set<Operation>([
  "task_create",
  "task_start",
  "task_stop",
  "task_close",
  "task_edit",
  "set_status",
  "set_priority",
  "set_rank",
  "set_epic",
  "append_log",
  "index",
  "extension_install",
  "extension_update",
  "extension_enable",
  "extension_disable",
  "extension_remove",
  "extension_configure",
  "extension_reconcile",
  "extension_recover",
  "extension_refresh",
]);
const start = (e: OperationEvent) => e.time - e.durationMs;
const percentile = (values: number[], q: number, minimum: number) =>
  values.length < minimum
    ? null
    : ([...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ??
      null);
function distribution(events: OperationEvent[]) {
  const values = events.map((e) => e.durationMs);
  return {
    n: events.length,
    errors: events.filter((e) => e.outcome === "error").length,
    totalWaitMs: values.reduce((a, b) => a + b, 0),
    p50Ms: percentile(values, 0.5, 5),
    p95Ms: percentile(values, 0.95, 20),
    maxMs: values.length ? Math.max(...values) : null,
  };
}
function group<T>(values: T[], key: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const k = key(value);
    const bucket = groups.get(k) ?? [];
    bucket.push(value);
    groups.set(k, bucket);
  }
  return groups;
}
function phase(event: OperationEvent) {
  if (event.before.indexState === "uninitialized") return "first_load";
  if (
    event.before.indexState !== "search" &&
    event.after.indexState === "search"
  )
    return "first_full_index";
  if (
    event.before.generation !== null &&
    event.after.generation !== null &&
    event.before.generation !== event.after.generation
  )
    return "rebuilt";
  if (event.before.indexState === "unknown") return "unknown";
  return "repeated";
}
function workload(event: OperationEvent) {
  const n = event.after.concepts;
  return n === null
    ? "unknown"
    : n < 100
      ? "under_100"
      : n < 1000
        ? "100_to_999"
        : n < 10000
          ? "1000_to_9999"
          : "10000_plus";
}
export interface ReportOptions {
  since?: number;
  until?: number;
  projects?: string[];
  limits?: Limits;
  friction?: Operation[];
}
/** Pure, bounded interpretation. Unknown attribution never creates a sequence. */
export function usageReport(input: unknown[], options: ReportOptions = {}) {
  const since = options.since ?? 0;
  const until = options.until ?? Date.now();
  if (
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    since < 0 ||
    until < since
  )
    throw new Error("invalid telemetry date window");
  if (options.friction?.some((op) => !OPERATIONS.includes(op)))
    throw new Error("unknown friction operation");
  const limits = limitsSchema.parse(options.limits ?? {});
  const byId = new Map<string, UsageEvent>();
  const conflicts = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  for (const raw of input.slice(0, 11000)) {
    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const event = parsed.data;
    const previous = byId.get(event.id);
    if (previous) {
      duplicates++;
      if (JSON.stringify(previous) !== JSON.stringify(event))
        conflicts.add(event.id);
    } else byId.set(event.id, event);
  }
  const retained = [...byId.values()].filter((e) => !conflicts.has(e.id));
  const selected = retained
    .filter(
      (e) =>
        e.time >= since &&
        e.time <= until &&
        (!options.projects || options.projects.includes(e.project)),
    )
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const operations = selected.filter(
    (e): e is OperationEvent => e.kind === "operation",
  );
  const runtimes = selected.filter((e) => e.kind === "runtime");
  const ranked = [
    ...group(
      operations,
      (e) => `${e.surface}/${e.operation}/${e.trigger}`,
    ).values(),
  ].map((events) => ({
    surface: events[0]?.surface,
    operation: events[0]?.operation,
    trigger: events[0]?.trigger,
    ...distribution(events),
    ownerFlag:
      options.friction?.includes(events[0]?.operation as Operation) ?? false,
    evidenceIds: events.slice(-3).map((e) => e.id),
  }));
  ranked.sort(
    (a, b) =>
      Number(b.ownerFlag) - Number(a.ownerFlag) ||
      b.totalWaitMs - a.totalWaitMs ||
      b.n - a.n,
  );
  const breakdowns = [
    ...group(
      operations,
      (e) =>
        `${e.surface}/${e.operation}/${e.trigger}/${phase(e)}/${workload(e)}`,
    ).values(),
  ]
    .map((events) => ({
      surface: events[0]?.surface,
      operation: events[0]?.operation,
      trigger: events[0]?.trigger,
      phase: phase(events[0] as OperationEvent),
      workload: workload(events[0] as OperationEvent),
      ...distribution(events),
    }))
    .sort((a, b) => b.totalWaitMs - a.totalWaitMs);
  const attributed = operations.filter(
    (e) => e.workflow && e.trigger === "explicit",
  );
  const workflows = group(attributed, (e) => `${e.project}/${e.workflow}`);
  let overlappingPairs = 0;
  let possibleRepeats = 0;
  let orientationWorkflows = 0;
  let orientationFollowups = 0;
  const transitions = new Map<
    string,
    { from: Operation; to: Operation; n: number; evidenceIds: string[] }
  >();
  const workflowRows = [...workflows.entries()].map(([key, events]) => {
    events.sort((a, b) => start(a) - start(b) || a.id.localeCompare(b.id));
    const oriented = events.some((e) => e.operation === "overview");
    if (oriented) orientationWorkflows++;
    let followed = false;
    for (let i = 1; i < events.length; i++) {
      const previous = events[i - 1];
      const current = events[i];
      if (!previous || !current) continue;
      if (previous.time > start(current)) {
        overlappingPairs++;
        continue;
      }
      if (previous.operation === current.operation) possibleRepeats++;
      if (previous.operation === "overview") followed = true;
      const pair = `${previous.operation}/${current.operation}`;
      const entry = transitions.get(pair) ?? {
        from: previous.operation,
        to: current.operation,
        n: 0,
        evidenceIds: [],
      };
      entry.n++;
      if (entry.evidenceIds.length < 6)
        entry.evidenceIds.push(previous.id, current.id);
      transitions.set(pair, entry);
    }
    if (followed) orientationFollowups++;
    return {
      project: key.split("/")[0],
      workflow: events[0]?.workflow,
      n: events.length,
      administrative: events.filter((e) => ADMIN.has(e.operation)).length,
      evidenceIds: events.slice(-5).map((e) => e.id),
    };
  });
  const memory = [...group(runtimes, (e) => e.runtime).values()]
    .map((events) => ({
      runtime: events[0]?.runtime,
      project: events[0]?.project,
      surface: events[0]?.surface,
      n: events.length,
      first: events[0]?.time,
      last: events.at(-1)?.time,
      minRss: Math.min(...events.map((e) => e.rss)),
      maxRss: Math.max(...events.map((e) => e.rss)),
      samples: events.slice(-10).map((e) => ({
        time: e.time,
        uptimeMs: e.uptimeMs,
        rss: e.rss,
        indexState: e.dimensions.indexState,
        concepts: e.dimensions.concepts,
      })),
      omittedSamples: Math.max(0, events.length - 10),
    }))
    .sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
  const spans = [...group(selected, (e) => e.runtime).values()]
    .map((events) => ({
      first: events[0]?.time ?? 0,
      last: events.at(-1)?.time ?? 0,
    }))
    .sort((a, b) => a.first - b.first);
  let intervalOverlapPairs = 0;
  let expired = 0;
  const ends = spans.map((span) => span.last).sort((a, b) => a - b);
  for (let i = 0; i < spans.length; i++) {
    while (expired < i && (ends[expired] ?? Infinity) < (spans[i]?.first ?? 0))
      expired++;
    intervalOverlapPairs += i - expired;
  }
  const mcpOperations = operations.filter((e) => e.surface === "mcp").length;
  const knownActor = operations.filter((e) => e.actor !== "unknown").length;
  const knownHost = operations.filter((e) => e.host !== "unknown").length;
  const correlated = operations.filter((e) => e.workflow).length;
  const attribution = [
    ...group(
      operations,
      (e) => `${e.surface}\t${e.project}\t${e.version}`,
    ).entries(),
  ].map(([key, events]) => {
    const [surface, project, version] = key.split("\t");
    return {
      surface,
      project,
      version,
      n: events.length,
      knownActor: events.filter((e) => e.actor !== "unknown").length,
      unknownActor: events.filter((e) => e.actor === "unknown").length,
      knownHost: events.filter((e) => e.host !== "unknown").length,
      unknownHost: events.filter((e) => e.host === "unknown").length,
      correlated: events.filter((e) => e.workflow).length,
      uncorrelated: events.filter((e) => !e.workflow).length,
    };
  });
  const versionMix = [...group(operations, (e) => e.version).entries()]
    .map(([version, events]) => ({
      version,
      n: events.length,
      first: events[0]?.time ?? null,
      last: events.at(-1)?.time ?? null,
      surfaces: [...new Set(events.map((e) => e.surface))],
      runtimes: [...new Set(events.map((e) => e.runtime))].length,
    }))
    .sort((a, b) => (a.first ?? 0) - (b.first ?? 0));
  const inventory = TELEMETRY_COVERAGE.filter(
    (entry) => entry.status === "supported" && entry.operation,
  ).reduce(
    (rows, entry) => {
      const operation = entry.operation;
      if (!operation || rows.has(operation)) return rows;
      const n = operations.filter((e) => e.operation === operation).length;
      rows.set(operation, {
        operation,
        since: entry.since,
        n,
        interpretation:
          n > 0
            ? "observed"
            : entry.since === "unreleased"
              ? "unreleased_zero_or_unobserved"
              : "observed_zero_or_unobserved",
      });
      return rows;
    },
    new Map<
      string,
      {
        operation: Operation;
        since: string;
        n: number;
        interpretation: string;
      }
    >(),
  );
  const emptySearch = operations.filter(
    (e) => e.operation === "search" && e.resultCount === 0,
  ).length;
  const nonemptySearch = operations.filter(
    (e) =>
      e.operation === "search" && e.resultCount !== null && e.resultCount > 0,
  ).length;
  const unknownSearchCount = operations.filter(
    (e) => e.operation === "search" && e.resultCount === null,
  ).length;
  const truncated = {
    results: operations.filter((e) => e.truncated === "results").length,
    response: operations.filter((e) => e.truncated === "response").length,
  };
  const saveStates = {
    unchanged: operations.filter((e) => e.saveState === "unchanged").length,
    savedLocally: operations.filter((e) => e.saveState === "saved_locally")
      .length,
    committed: operations.filter((e) => e.saveState === "committed").length,
    commitFailed: operations.filter((e) => e.saveState === "commit_failed")
      .length,
    unknown: operations.filter(
      (e) => e.operation === "edit_save" && e.saveState === null,
    ).length,
  };
  const failureReasons = [
    ...group(
      operations.filter((e) => e.failureReason),
      (e) => e.failureReason ?? "unknown",
    ).entries(),
  ].map(([reason, events]) => ({ reason, n: events.length }));
  const possibleRecovery: {
    workflow: string | null;
    operation: Operation;
    evidenceIds: string[];
  }[] = [];
  for (const events of workflows.values()) {
    const ordered = [...events].sort(
      (a, b) => start(a) - start(b) || a.id.localeCompare(b.id),
    );
    for (let i = 0; i < ordered.length; i++) {
      const failed = ordered[i];
      if (failed?.outcome !== "error") continue;
      const recovered = ordered
        .slice(i + 1)
        .find(
          (event) =>
            event.operation === failed.operation &&
            event.outcome === "success" &&
            failed.time <= start(event),
        );
      if (!recovered) continue;
      possibleRecovery.push({
        workflow: failed.workflow,
        operation: failed.operation,
        evidenceIds: [failed.id, recovered.id],
      });
      if (possibleRecovery.length >= 20) break;
    }
    if (possibleRecovery.length >= 20) break;
  }
  return {
    schema: 1,
    window: { since, until },
    coverage: {
      observedOperations: operations.length,
      resourceSamples: runtimes.length,
      projects: [...new Set(selected.map((e) => e.project))],
      runtimes: spans.length,
      versions: [...new Set(selected.map((e) => e.version))],
      firstObserved: selected[0]?.time ?? null,
      lastObserved: selected.at(-1)?.time ?? null,
      invalid,
      duplicates,
      conflictingIds: conflicts.size,
      inputTruncated: input.length > 11000,
      reportedDrops: operations.reduce((n, e) => n + e.dropped, 0),
      unknownActor: operations.filter((e) => e.actor === "unknown").length,
      unknownHost: operations.filter((e) => e.host === "unknown").length,
      uncorrelated: operations.filter((e) => !e.workflow).length,
      knownActor,
      knownHost,
      correlated,
      mcpOperations,
      mcpSilence:
        mcpOperations === 0
          ? "no_mcp_observations_not_proof_of_no_mcp_usage"
          : null,
      limits,
      retentionMayOmitEarlierData: true,
      unobservedOperations: null,
      collectionUptime: null,
    },
    surfaceMix: [...group(operations, (e) => e.surface).entries()].map(
      ([surface, events]) => ({
        surface,
        n: events.length,
        share: operations.length ? events.length / operations.length : null,
        explicit: events.filter((e) => e.trigger === "explicit").length,
        background: events.filter((e) => e.trigger === "background").length,
        unknown: events.filter((e) => e.trigger === "unknown").length,
      }),
    ),
    candidates: ranked.slice(0, 30),
    omittedCandidates: Math.max(0, ranked.length - 30),
    rankings: {
      frequency: [...ranked].sort((a, b) => b.n - a.n).slice(0, 10),
      errors: [...ranked]
        .filter((e) => e.errors)
        .sort((a, b) => b.errors - a.errors)
        .slice(0, 10),
      tail: [...ranked]
        .filter((e) => e.p95Ms !== null)
        .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
        .slice(0, 10),
    },
    breakdowns: breakdowns.slice(0, 100),
    omittedBreakdowns: Math.max(0, breakdowns.length - 100),
    workflows: {
      method: "explicit tokens only; adjacent non-overlapping operations",
      n: workflows.size,
      observedOperations: attributed.length,
      overlappingPairsExcluded: overlappingPairs,
      possibleRepeats: workflows.size ? possibleRepeats : null,
      orientationWorkflows: workflows.size ? orientationWorkflows : null,
      orientationFollowups: workflows.size ? orientationFollowups : null,
      administrativePerWorkflow: workflows.size
        ? attributed.filter((e) => ADMIN.has(e.operation)).length /
          workflows.size
        : null,
      perTask: null,
      transitions: [...transitions.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, 20),
      examples: workflowRows.slice(0, 20),
      omittedExamples: Math.max(0, workflowRows.length - 20),
    },
    memory: {
      instances: memory.slice(0, 50),
      omittedInstances: Math.max(0, memory.length - 50),
      observedIntervalOverlapPairs: intervalOverlapPairs,
      provenConcurrentResidency: null,
      hostPressure: null,
      liveHeap: null,
    },
    historicalBaseline: {
      source: "Git/task history — separate from observed usage",
      available: false,
      reason:
        "Use the pilot's dated Git/task baseline; no history scan is performed by this report.",
    },
    attribution,
    versionMix,
    inventory: {
      method:
        "Feature inventory vs observed counts; n=0 is not unused and not uninstrumented",
      uninstrumented: TELEMETRY_COVERAGE.filter(
        (entry) => entry.status === "uninstrumented",
      ).map((entry) => ({
        surface: entry.surface,
        id: entry.id,
        operation: entry.operation,
        since: entry.since,
        notes: entry.notes ?? null,
      })),
      excluded: TELEMETRY_COVERAGE.filter(
        (entry) => entry.status === "excluded",
      ).map((entry) => ({
        surface: entry.surface,
        id: entry.id,
        operation: entry.operation,
        since: entry.since,
        notes: entry.notes ?? null,
      })),
      supported: [...inventory.values()].sort((a, b) => a.n - b.n),
    },
    outcomes: {
      emptySearch,
      nonemptySearch,
      unknownSearchCount,
      truncated,
      saveStates,
      failureReasons,
      possibleRecovery,
      possibleRecoveryNote:
        "Same hashed workflow token, later non-overlapping success of the same operation after an error. Not proven recovery, retry, or user satisfaction.",
    },
    overhead: {
      scope:
        "Synthetic 50-concept macOS arm64, Bun 1.3.14, 2026-09-11; 30 alternating pairs; full round trips",
      meanAddedMs: { mcp: 2.42, serve: 2.02, cli: 3.76 },
      reference:
        "docket/reference/local-telemetry.md#collection-overhead-evidence",
      appliesToCurrentHost: false,
    },
    limitations: [
      "Observed requests are not unique human actions, satisfaction, task success or model token cost.",
      "Missing, disabled, interrupted and retention-expired activity cannot be reconstructed; observed range is not continuous coverage.",
      "p50 needs 5 observations; p95 needs 20. Sparse groups retain counts and maximum only.",
      "Repeated operation names may be different queries/tasks, not retries or wasted effort; gaps and task intervals are not active work time.",
      "Concurrent durations sum overlapping waits. Index state denotes retained ownership, not guaranteed freshness; shared work belongs only to its initiating request.",
      "RSS samples and overlapping observation intervals do not prove a leak or simultaneous residency. Idle periods are not sampled.",
      "Owner flags are explicit operator input for review; candidate ordering is not a validated product recommendation.",
      "Telemetry append is excluded from event duration; the separate synthetic overhead experiment includes it. Browser paint and end-to-end visible confirmation are unavailable.",
      "Zero MCP observations and zero counts for supported operations are absence of retained records, not proof those surfaces or features were unused. Uninstrumented inventory entries cannot produce observations.",
      "Historical records keep unknown actor/host/workflow and missing outcome fields; reports do not rewrite them. Possible recovery requires an explicit non-overlapping token match and is not a proven retry.",
    ],
  };
}
export type UsageReport = ReturnType<typeof usageReport>;
const DAY_MS = 86400000;
export function compactUsageWindow(report: UsageReport) {
  return {
    window: report.window,
    coverage: report.coverage,
    surfaceMix: report.surfaceMix,
    attribution: report.attribution,
    versionMix: report.versionMix,
    inventory: {
      supportedObserved: report.inventory.supported.filter((row) => row.n > 0)
        .length,
      supportedZero: report.inventory.supported.filter((row) => row.n === 0)
        .length,
      uninstrumented: report.inventory.uninstrumented.length,
      excluded: report.inventory.excluded.length,
    },
    outcomes: {
      emptySearch: report.outcomes.emptySearch,
      nonemptySearch: report.outcomes.nonemptySearch,
      unknownSearchCount: report.outcomes.unknownSearchCount,
      truncated: report.outcomes.truncated,
      saveStates: report.outcomes.saveStates,
      failureReasons: report.outcomes.failureReasons,
      possibleRecovery: report.outcomes.possibleRecovery.length,
    },
  };
}
export function usageWindows(input: unknown[], options: ReportOptions = {}) {
  const until = options.until ?? Date.now();
  const selectedSince = options.since ?? Math.max(0, until - 14 * DAY_MS);
  const selected = usageReport(input, {
    ...options,
    since: selectedSince,
    until,
  });
  return {
    asOf: until,
    selected,
    hours24: compactUsageWindow(
      usageReport(input, {
        ...options,
        since: Math.max(0, until - DAY_MS),
        until,
      }),
    ),
    days7: compactUsageWindow(
      usageReport(input, {
        ...options,
        since: Math.max(0, until - 7 * DAY_MS),
        until,
      }),
    ),
    fullPilot: compactUsageWindow(
      usageReport(input, { ...options, since: 0, until }),
    ),
  };
}
export type UsageWindows = ReturnType<typeof usageWindows>;
function windowLine(
  label: string,
  window: { since: number; until: number },
  coverage: UsageReport["coverage"],
) {
  return `${label}: ${new Date(window.since).toISOString()} through ${new Date(window.until).toISOString()} — ${coverage.observedOperations} operations, actor ${coverage.knownActor}/${coverage.observedOperations} known, host ${coverage.knownHost} known, ${coverage.correlated} correlated, MCP ${coverage.mcpOperations}${coverage.mcpSilence ? " (silence is not unused)" : ""}`;
}
export function renderUsageWindows(windows: UsageWindows): string {
  return [
    `As of ${new Date(windows.asOf).toISOString()}`,
    windowLine(
      "Last 24 hours",
      windows.hours24.window,
      windows.hours24.coverage,
    ),
    windowLine("Last 7 days", windows.days7.window, windows.days7.coverage),
    windowLine(
      "Full retained sample",
      windows.fullPilot.window,
      windows.fullPilot.coverage,
    ),
    windowLine(
      "Selected window",
      windows.selected.window,
      windows.selected.coverage,
    ),
    "",
    renderUsageReport(windows.selected),
  ].join("\n");
}
export function renderUsageReport(report: UsageReport): string {
  const ms = (n: number | null) =>
    n === null ? "unavailable" : `${n.toFixed(2)} ms`;
  const lines = [
    `Local usage: ${report.coverage.observedOperations} operations, ${report.coverage.resourceSamples} resource samples, ${report.coverage.projects.length} projects`,
    `Window: ${new Date(report.window.since).toISOString()} through ${new Date(report.window.until).toISOString()}`,
    `Coverage: ${report.coverage.reportedDrops} reported drops; ${report.coverage.knownActor}/${report.coverage.observedOperations} known actor; ${report.coverage.knownHost} known host; ${report.coverage.correlated} correlated / ${report.coverage.uncorrelated} uncorrelated. Missing activity/retention gaps are unknown.`,
    "",
    "Candidates for manual review (owner flag, then total observed wait):",
  ];
  for (const row of report.candidates)
    lines.push(
      `${row.surface}/${row.operation} [${row.trigger}] n=${row.n}, errors=${row.errors}, total=${ms(row.totalWaitMs)}, p50=${ms(row.p50Ms)}, p95=${ms(row.p95Ms)}${row.ownerFlag ? ", owner flagged" : ""}`,
    );
  if (!report.candidates.length) lines.push("No observations in this window.");
  lines.push(
    "",
    `Explicit workflows: ${report.workflows.n}; possible repeated names: ${report.workflows.possibleRepeats ?? "unavailable"}; orientation follow-ups: ${report.workflows.orientationFollowups ?? "unavailable"}/${report.workflows.orientationWorkflows ?? "unavailable"}; administrative operations/workflow: ${report.workflows.administrativePerWorkflow ?? "unavailable"}.`,
  );
  if (report.coverage.mcpSilence)
    lines.push(
      "",
      "MCP: no retained observations in this window. That is not proof MCP was unused.",
    );
  const unobserved = report.inventory.supported.filter((row) => row.n === 0);
  lines.push(
    "",
    `Inventory: ${report.inventory.supported.filter((row) => row.n > 0).length} supported operations observed, ${unobserved.length} supported with zero retained records, ${report.inventory.uninstrumented.length} uninstrumented, ${report.inventory.excluded.length} excluded. Zero is not unused.`,
  );
  lines.push(
    `Outcomes: empty search=${report.outcomes.emptySearch}, unknown search count=${report.outcomes.unknownSearchCount}, truncated results=${report.outcomes.truncated.results}, possible recovery pairs=${report.outcomes.possibleRecovery.length} (not proven).`,
  );
  lines.push("", "Cold/warm and workload breakdowns:");
  for (const row of report.breakdowns.slice(0, 20))
    lines.push(
      `${row.surface}/${row.operation} [${row.trigger}, ${row.phase}, ${row.workload}] n=${row.n}, total=${ms(row.totalWaitMs)}, p95=${ms(row.p95Ms)}`,
    );
  lines.push(
    "",
    "Sampled process memory (RSS, not live heap or host pressure):",
  );
  for (const runtime of report.memory.instances.slice(0, 10)) {
    const last = runtime.samples.at(-1);
    lines.push(
      `${runtime.surface}/${runtime.runtime} n=${runtime.n}, RSS=${(runtime.minRss / 1048576).toFixed(1)}–${(runtime.maxRss / 1048576).toFixed(1)} MiB, latest uptime=${((last?.uptimeMs ?? 0) / 1000).toFixed(1)} s, index=${last?.indexState}`,
    );
  }
  if (!report.memory.instances.length)
    lines.push("Unavailable: no retained resource samples.");
  lines.push(
    "",
    "Git/task historical baseline: separate, not scanned; see pilot baseline.",
    "Collection overhead: synthetic mean +2.42 ms MCP / +2.02 ms Serve / +3.76 ms CLI on one Mac; not a correction factor for this host.",
    "Use --json for bounded evidence IDs, full breakdowns, surface mix and omission counts.",
    "",
    ...report.limitations,
  );
  return lines.join("\n");
}
