/** Presentation never replaces the complete global validation result. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { z } from "zod";
import type { DocketConfig } from "./config";
import type { LintOptions } from "./lint";
import {
  classifyLintDiagnostic,
  type LintDiagnostic,
} from "./lint-diagnostics";
import { TaskEditError } from "./ops";
import type { Diagnostic } from "./parse";
import { DOCKET_VERSION } from "./version";

export const LINT_SUMMARY_MAX_BYTES = 8192;
export const LINT_REPORT_MAX_BYTES = 8 * 1024 * 1024;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const version = z.string().regex(/^[a-f0-9]{64}$/);
const diagnosticSchema = z
  .object({
    path: z.string().min(1).max(2048),
    line: z.number().int().positive().optional(),
    message: z.string().max(65536),
    severity: z.enum(["error", "warning"]),
    code: z.string().min(1).max(128),
    category: z.string().min(1).max(64),
    fingerprint: version,
  })
  .strict();
const profileSchema = z
  .object({
    engineVersion: z.string().max(64),
    rulesVersion: z.literal("docket-lint/v1"),
    configVersion: version,
    scope: z.string().max(2048),
    maxAgeDays: z.number().finite(),
    coverage: z
      .object({
        trailerless: z.boolean(),
        taskLinked: z.boolean(),
        verification: z.boolean(),
      })
      .strict(),
  })
  .strict();
const reportSchema = z
  .object({
    schema: z.literal("docket-lint-report/v1"),
    complete: z.literal(true),
    observedAt: z.string().datetime(),
    profile: profileSchema,
    inputVersion: version,
    sources: z
      .array(z.object({ path: z.string().min(1).max(2048), version }).strict())
      .max(20000),
    diagnostics: z.array(diagnosticSchema).max(20000),
    integrity: version,
  })
  .strict();
export type LintReport = z.infer<typeof reportSchema>;
export type LintBaseline =
  | { status: "available"; report: LintReport }
  | { status: "unavailable" | "not-supplied"; reason: string };
const normalizedMessage = (d: LintDiagnostic) => {
  if (d.category === "freshness")
    return d.message
      .replace(/\d+ days/g, "<age> days")
      .replace(/\d+ task-linked commits/g, "<count> task-linked commits")
      .replace(/^\d+ trailerless/, "<count> trailerless");
  if (d.code === "verification.unresolved")
    return d.message.replace(/\(line \d+\)/g, "(line <n>)");
  return d.message;
};

export function makeLintReport(
  diagnostics: readonly Diagnostic[],
  sources: ReadonlyMap<string, string>,
  config: DocketConfig,
  options: LintOptions = {},
  scope = "in-memory",
  observedAt = new Date(),
): LintReport {
  if (diagnostics.length > 20000 || sources.size > 20000)
    throw new Error(
      "Complete report exceeds bounded evidence limits; use docket lint --json for the full diagnostic route.",
    );
  const rows = diagnostics.map((d) => {
    const classified = classifyLintDiagnostic(d);
    return {
      ...classified,
      fingerprint:
        d.fingerprint ??
        hash(
          `${classified.code}\0${classified.severity}\0${normalizedMessage(classified)}`,
        ),
    };
  });
  const inputSources = [...sources]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, source]) => ({ path, version: hash(source) }));
  const profile = {
    engineVersion: DOCKET_VERSION,
    rulesVersion: "docket-lint/v1" as const,
    configVersion: hash(canonical(config)),
    scope,
    maxAgeDays: options.maxAgeDays ?? 14,
    coverage: {
      trailerless: typeof options.trailerlessCommits === "number",
      taskLinked: typeof options.stateOfPlayCommitsAgo === "number",
      verification:
        config.verify === null || options.verifyMarkers !== undefined,
    },
  };
  const payload = {
    schema: "docket-lint-report/v1" as const,
    complete: true as const,
    observedAt: observedAt.toISOString(),
    profile,
    inputVersion: hash(
      canonical({
        profile,
        inputSources,
        observedAt: observedAt.toISOString(),
        derived: {
          trailerless: options.trailerlessCommits ?? null,
          taskLinked: options.stateOfPlayCommitsAgo ?? null,
          verifyMarkers: options.verifyMarkers ?? null,
        },
      }),
    ),
    sources: inputSources,
    diagnostics: rows,
  };
  return reportSchema.parse({
    ...payload,
    integrity: hash(canonical(payload)),
  });
}

export function parseLintBaseline(source: string): LintBaseline {
  try {
    if (Buffer.byteLength(source) > LINT_REPORT_MAX_BYTES)
      throw new Error("Baseline exceeds 8 MiB.");
    const raw = JSON.parse(source);
    if (
      !raw ||
      !Array.isArray(raw.diagnostics) ||
      !Array.isArray(raw.sources) ||
      raw.diagnostics.length > 20000 ||
      raw.sources.length > 20000
    )
      throw new Error("Baseline collections exceed bounds.");
    const report = reportSchema.parse(raw);
    const { integrity, ...payload } = report;
    if (integrity !== hash(canonical(payload)))
      throw new Error("Baseline integrity differs.");
    if (
      new Set(report.sources.map((x) => x.path)).size !== report.sources.length
    )
      throw new Error("Baseline source paths are ambiguous.");
    return { status: "available", report };
  } catch {
    return {
      status: "unavailable",
      reason:
        "Baseline is missing, incomplete, invalid, incompatible or exceeds the bounded report contract.",
    };
  }
}

/** Explicit CLI paths may live outside the checkout. MCP supplies a root and
 * admits only a real file contained there; neither route executes source text.
 */
export async function readLintBaseline(
  path: string,
  root?: string,
): Promise<LintBaseline> {
  try {
    let target = path;
    if (root !== undefined) {
      if (isAbsolute(path) || path.includes("\0"))
        throw new Error("Expected checkout-relative report.");
      const base = await realpath(root);
      target = await realpath(resolve(base, path));
      const rel = relative(base, target);
      if (
        rel === ".." ||
        rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(rel)
      )
        throw new Error("Report outside checkout.");
    }
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > LINT_REPORT_MAX_BYTES)
        throw new Error("Invalid report file.");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size)
        throw new Error("Report changed while reading.");
      return parseLintBaseline(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    return {
      status: "unavailable",
      reason:
        "Requested baseline file is unavailable, unsafe or outside the supported report bounds.",
    };
  }
}

export async function writeLintReport(path: string, report: LintReport) {
  if (!path.endsWith(".json"))
    throw new Error(
      "Lint evidence requires an owned JSON destination; Markdown/config sources must not be replaced.",
    );
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(text) > LINT_REPORT_MAX_BYTES)
    throw new Error(
      "Complete lint evidence exceeds the 8 MiB export limit; use the full diagnostic route.",
    );
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const existing = await lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing && !existing.isFile())
    throw new Error("Report destination must be an owned regular file.");
  if (existing && (await readLintBaseline(path)).status !== "available")
    throw new Error(
      "Existing destination is not a complete Docket lint report; choose a fresh owned JSON file.",
    );
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    path,
    sha256: hash(text),
    bytes: Buffer.byteLength(text),
    schema: report.schema,
  };
}

type FindingState = "pre-existing" | "introduced" | "unknown-baseline";
export function compareLintReports(
  current: LintReport,
  baseline: LintBaseline,
) {
  const withoutCoverage = (profile: LintReport["profile"]) => {
    const { coverage, ...rest } = profile;
    return rest;
  };
  if (
    baseline.status !== "available" ||
    canonical(withoutCoverage(current.profile)) !==
      canonical(withoutCoverage(baseline.report.profile))
  )
    return {
      baseline: {
        status:
          baseline.status === "available" ? "unavailable" : baseline.status,
        reason:
          baseline.status === "available"
            ? "Baseline checkout/configuration/rules differs."
            : baseline.reason,
      },
      states: current.diagnostics.map(() => "unknown-baseline" as FindingState),
      resolved: [] as LintReport["diagnostics"],
      counts: {
        preExisting: null,
        introduced: null,
        resolved: null,
        unknown: current.diagnostics.length,
        resolvedUnknown: null,
      },
      relocations: [] as { from: string; to: string }[],
    };
  const prior = baseline.report;
  const coverageKeys = ["trailerless", "taskLinked", "verification"] as const;
  const coverageMismatch = coverageKeys.filter(
    (k) => current.profile.coverage[k] !== prior.profile.coverage[k],
  );
  const uncertainCodes = new Set(
    coverageMismatch.flatMap((k) =>
      k === "trailerless"
        ? ["freshness.unlinked-work"]
        : k === "taskLinked"
          ? ["context.needs-review"]
          : ["verification.unresolved"],
    ),
  );

  const before = new Map(prior.sources.map((s) => [s.path, s.version]));
  const after = new Map(current.sources.map((s) => [s.path, s.version]));
  const missing = prior.sources.filter((s) => !after.has(s.path));
  const added = current.sources.filter((s) => !before.has(s.path));
  const groupVersions = (sources: LintReport["sources"]) => {
    const groups = new Map<string, string[]>();
    for (const s of sources) {
      const paths = groups.get(s.version) ?? [];
      paths.push(s.path);
      groups.set(s.version, paths);
    }
    return groups;
  };
  const missingVersions = groupVersions(missing),
    addedVersions = groupVersions(added);
  const relocations = missing.flatMap((s) => {
    const targets = addedVersions.get(s.version);
    return targets?.length === 1 && missingVersions.get(s.version)?.length === 1
      ? [{ from: s.path, to: targets[0] as string }]
      : [];
  });
  const remap = new Map(relocations.map((r) => [r.from, r.to]));
  const mappedTargets = new Set(remap.values());
  const ambiguousCurrent = new Set(
    added
      .filter(
        (s) => missingVersions.has(s.version) && !mappedTargets.has(s.path),
      )
      .map((s) => s.path),
  );
  const ambiguousPrior = new Set(
    missing
      .filter((s) => addedVersions.has(s.version) && !remap.has(s.path))
      .map((s) => s.path),
  );
  const key = (d: LintReport["diagnostics"][number], path = d.path) =>
    `${path}\0${d.code}\0${d.severity}\0${d.fingerprint}`;
  const buckets = new Map<string, number[]>();
  prior.diagnostics.forEach((d, index) => {
    if (uncertainCodes.has(d.code)) return;
    const k = key(d, remap.get(d.path) ?? d.path);
    const entries = buckets.get(k) ?? [];
    entries.push(index);
    buckets.set(k, entries);
  });
  const consumed = new Set<number>();
  const states = current.diagnostics.map((d) => {
    if (uncertainCodes.has(d.code)) return "unknown-baseline" as FindingState;
    const match = buckets.get(key(d))?.pop();
    if (match === undefined)
      return (
        ambiguousCurrent.has(d.path) ? "unknown-baseline" : "introduced"
      ) as FindingState;
    consumed.add(match);
    return "pre-existing" as FindingState;
  });
  const resolved = prior.diagnostics.filter(
    (d, i) =>
      !consumed.has(i) &&
      !ambiguousPrior.has(d.path) &&
      !uncertainCodes.has(d.code),
  );
  return {
    baseline: {
      status: coverageMismatch.length ? "partial" : "available",
      coverageMismatch,
      inputVersion: prior.inputVersion,
      observedAt: prior.observedAt,
    },
    states,
    resolved,
    counts: {
      preExisting: states.filter((s) => s === "pre-existing").length,
      introduced: states.filter((s) => s === "introduced").length,
      resolved: resolved.length,
      unknown: states.filter((s) => s === "unknown-baseline").length,
      resolvedUnknown: prior.diagnostics.filter(
        (d) => ambiguousPrior.has(d.path) || uncertainCodes.has(d.code),
      ).length,
    },
    relocations,
  };
}

export interface LintSummaryOptions {
  paths?: string[];
  offset?: number;
  limit?: number;
  artifact?: object;
}
export function validateLintSummaryOptions(options: LintSummaryOptions) {
  const paths = options.paths ?? [],
    offset = options.offset ?? 0,
    limit = options.limit ?? 8;
  if (
    paths.length > 32 ||
    paths.some((p) => !p || p.length > 2048 || p.includes("\0")) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 32
  )
    throw new TaskEditError(
      "invalid-request",
      "Invalid bounded lint summary selection.",
    );
}
const counts = (diagnostics: LintReport["diagnostics"]) => {
  const categories = new Map<string, number>(),
    codes = new Map<string, number>();
  let errors = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    categories.set(d.category, (categories.get(d.category) ?? 0) + 1);
    codes.set(d.code, (codes.get(d.code) ?? 0) + 1);
  }
  const ordered = (map: Map<string, number>) =>
    Object.fromEntries(
      [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  return {
    total: diagnostics.length,
    error: errors,
    warning: diagnostics.length - errors,
    categories: ordered(categories),
    codes: ordered(codes),
  };
};

export function lintSummary(
  report: LintReport,
  baseline: LintBaseline = {
    status: "not-supplied",
    reason:
      "No complete prior report supplied; changed-path selection alone does not establish warning history.",
  },
  options: LintSummaryOptions = {},
) {
  const paths = options.paths ?? [];
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 8;
  validateLintSummaryOptions(options);
  const comparison = compareLintReports(report, baseline);
  const selected = report.diagnostics
    .map((d, index) => ({
      ...d,
      state: comparison.states[index] as FindingState,
    }))
    .filter(
      (d) =>
        d.severity === "error" ||
        d.state === "introduced" ||
        !paths.length ||
        paths.includes(d.path),
    );
  selected.sort(
    (a, b) =>
      (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1) ||
      (a.state === "introduced" ? 0 : 1) - (b.state === "introduced" ? 0 : 1) ||
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.code.localeCompare(b.code),
  );
  let rows = selected.slice(offset, offset + limit).map((d) => ({
    ...d,
    message: d.message.slice(0, 512),
    messageOmitted: d.message.length > 512,
  }));
  const globalCounts = counts(report.diagnostics);
  const resolvedCounts = ["available", "partial"].includes(
    comparison.baseline.status,
  )
    ? counts(comparison.resolved)
    : null;
  const build = () => ({
    schema: "docket-lint-summary/v1",
    authority:
      "complete global validation; selection changes presentation only",
    inputVersion: report.inputVersion,
    coverage: report.profile.coverage,
    observedAt: report.observedAt,
    global: globalCounts,
    comparisonUnit:
      "diagnostic signature occurrences; identical occurrences have no individual historical identity",
    delta: comparison.counts,
    baseline: comparison.baseline,
    selection: {
      changedPaths: paths.length,
      includesAllStructuralErrors: true,
      total: selected.length,
      offset,
      shown: rows.length,
      omitted: selected.length - rows.length,
      nextOffset:
        offset + rows.length < selected.length ? offset + rows.length : null,
    },
    diagnostics: rows,
    relocations: comparison.relocations.slice(0, 4),
    omittedRelocations: Math.max(0, comparison.relocations.length - 4),
    resolved: resolvedCounts,
    ...(options.artifact ? { artifact: options.artifact } : {}),
    details: {
      cli: "docket lint --json",
      mcp: { tool: "lint", arguments: { view: "full" } },
      pages:
        "Reuse selectors/baseline with the returned nextOffset; complete saved report retains all current findings.",
    },
  });
  while (
    rows.length &&
    Buffer.byteLength(JSON.stringify(build(), null, 2)) > LINT_SUMMARY_MAX_BYTES
  )
    rows = rows.slice(0, -1);
  const result = build();
  if (
    Buffer.byteLength(JSON.stringify(result, null, 2)) > LINT_SUMMARY_MAX_BYTES
  )
    throw new Error(
      "Summary metadata exceeds the bounded contract; use the complete diagnostic route.",
    );
  if (selected.length > offset && !rows.length)
    throw new Error(
      "A source reference exceeds the summary budget; use the complete diagnostic route.",
    );
  return result;
}
