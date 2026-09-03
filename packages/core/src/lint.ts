// PM 101 encoded as lint, not UI. Errors are profile conformance
// per the spec's Conformance section; warnings are practice. Core stays
// git-free: callers with a repo (the CLI) compute git-derived inputs like
// the trailerless-commit count and pass them in.

import type { Bundle } from "./bundle";
import type { FileStore } from "./filestore";
import { type Diagnostic, isReserved } from "./parse";
import {
  parseStateOfPlay,
  presentStateOfPlay,
  STATE_OF_PLAY_PATH,
} from "./state-of-play";
import type { VerifyMarker } from "./verify";

export interface LintOptions {
  now?: Date;
  /** Staleness threshold for in-flight statuses and the Freshness watermark. */
  maxAgeDays?: number;
  /** Commits without a Task trailer since the watermark — computed by callers with git. */
  trailerlessCommits?: number;
  /** Task-linked commits after overview.md's as_of watermark, computed by Git-aware callers. */
  stateOfPlayCommitsAgo?: number;
  /**
   * docket:verifies markers scanned by callers with repo access.
   * The epic's only lint rule: an unresolvable target warns; "spec is
   * unverified" deliberately does not — that lives in `verify status`.
   */
  verifyMarkers?: VerifyMarker[];
}

export interface FreshnessWatermark {
  sha: string;
  /** The `## YYYY-MM-DD` section the watermark entry sits under. */
  date?: string;
}

/**
 * Latest `**Freshness** … reviewed through <sha>` entry in log.md
 * (newest-first, so first match wins). Prose may sit between the marker and
 * the sha — init's baseline stamp reads "baseline at adoption; reviewed
 * through `<sha>`".
 */
export function findFreshnessWatermark(
  logSource: string,
): FreshnessWatermark | undefined {
  let date: string | undefined;
  for (const line of logSource.split("\n")) {
    const heading = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (heading) {
      date = heading[1];
      continue;
    }
    const mark = line.match(
      /\*\*Freshness\*\*.*reviewed through `?([0-9a-f]{7,40})`?/,
    );
    if (mark?.[1]) return { sha: mark[1], date };
  }
  return undefined;
}

/** Resolve an internal link against the bundle root; undefined = not checkable (non-md, escapes bundle). */
export function resolveLink(
  fromPath: string,
  target: string,
): string | undefined {
  const clean = target.split("#")[0] ?? "";
  if (!clean.endsWith(".md")) return undefined;
  const parts = clean.startsWith("/")
    ? clean.slice(1).split("/")
    : [...fromPath.split("/").slice(0, -1), ...clean.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

export async function lintBundle(
  store: FileStore,
  bundle: Bundle,
  opts: LintOptions = {},
): Promise<Diagnostic[]> {
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.maxAgeDays ?? 14;
  const out: Diagnostic[] = [...bundle.diagnostics];
  const files = new Set(await store.list());
  const report = (severity: Diagnostic["severity"]) => {
    return (path: string, message: string) =>
      out.push({ path, message, severity });
  };
  const error = report("error");
  const warn = report("warning");
  const ageDays = (iso: string): number =>
    (now.getTime() - new Date(iso).getTime()) / 86_400_000;

  for (const item of bundle.workItems) {
    // Conformance: every depends_on entry resolves to an existing task id.
    for (const dep of item.fm.depends_on) {
      if (bundle.byId(dep)?.kind !== "work")
        error(item.path, `depends_on ${dep} does not resolve to a work item`);
    }

    const filename = item.path.split("/").at(-1) ?? item.path;
    if (!filename.startsWith(`${item.fm.id}-`))
      warn(
        item.path,
        `filename does not start with ${item.fm.id}- (slug drift?)`,
      );

    if (item.fm.type === "Epic" && !item.fm.spec)
      warn(item.path, "epic has no spec link");

    if (
      item.fm.status === "done" &&
      /^\s*- \[ \]/m.test(await store.read(item.path))
    )
      warn(item.path, "done but has unchecked criteria");

    if (item.fm.status === "in-progress" || item.fm.status === "in-review") {
      const ts = item.fm.timestamp;
      if (typeof ts === "string" && ageDays(ts) > maxAgeDays)
        warn(
          item.path,
          `${item.fm.status} but untouched for ${Math.floor(ageDays(ts))} days — stale?`,
        );
    }
  }

  for (const concept of bundle.concepts) {
    for (const link of concept.links) {
      if (!link.internal) continue;
      const resolved = resolveLink(concept.path, link.target);
      if (resolved && !files.has(resolved))
        warn(concept.path, `broken link: ${link.target}`);
    }
  }

  // overview.md is optional. The linked re-entry note expires on either
  // substantial task-linked movement or review age. Superseded formats stay
  // readable and are accepted non-destructively but ask for a linked refresh.
  if (files.has(STATE_OF_PLAY_PATH)) {
    const parsed = parseStateOfPlay(await store.read(STATE_OF_PLAY_PATH));
    out.push(...parsed.diagnostics);
    if (parsed.note) {
      const view = presentStateOfPlay(parsed.note, opts.stateOfPlayCommitsAgo, {
        now,
      });
      if (view.review.status === "needs-review") {
        const why = [
          ...(view.review.reasons.includes("legacy-format")
            ? ["legacy prose format"]
            : []),
          ...(view.review.reasons.includes("superseded-format")
            ? ["superseded re-entry/v1 format"]
            : []),
          ...(view.review.reasons.includes("evidence-moved")
            ? [`${view.taskCommitsAgo} task-linked commits behind ${view.asOf}`]
            : []),
          ...(view.review.reasons.includes("review-expired")
            ? [`reviewed ${view.review.reviewedDaysAgo} days ago`]
            : []),
        ].join(", ");
        warn(
          STATE_OF_PLAY_PATH,
          `product context needs review (${why}) — run the docket-state-of-play workflow`,
        );
      }
    }
  }

  // Reserved files (index.md, log.md) aren't concepts, but the hand-maintained
  // index is exactly where links rot — check them with a light regex pass.
  for (const path of files) {
    if (!isReserved(path)) continue;
    const source = await store.read(path);
    for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // external
      const resolved = resolveLink(path, target);
      if (resolved && !files.has(resolved))
        warn(path, `broken link: ${target}`);
    }
  }

  // Stray merge-conflict markers: an ordinary git merge — or a
  // docket upgrade conflict left unresolved — can land markers in committed
  // files, and upgrade re-runs report up-to-date once origin is bumped, so
  // lint is the recurring nag. Requires all three marker lines at line
  // starts; a fenced code block quoting a complete conflict still trips this
  // (accepted — quote partial markers instead).
  for (const path of files) {
    const source = await store.read(path);
    if (
      /^<{7} /m.test(source) &&
      /^={7}$/m.test(source) &&
      /^>{7} /m.test(source)
    )
      warn(path, "merge-conflict markers present — resolve and remove them");
  }

  // Verification markers: the target must name an existing concept
  // by bundle-absolute path. Marker sources live outside the bundle, so the
  // diagnostic path is repo-relative.
  for (const m of opts.verifyMarkers ?? []) {
    if (!m.spec || !files.has(m.spec))
      warn(
        m.source,
        `docket:verifies target does not resolve: ${m.target} (line ${m.line})`,
      );
  }

  // Freshness nag — only for bundles that keep a log.md at all.
  if (files.has("log.md")) {
    const watermark = findFreshnessWatermark(await store.read("log.md"));
    if (!watermark) {
      warn(
        "log.md",
        "no **Freshness** watermark — run the docket-freshness workflow",
      );
    } else {
      if (watermark.date && ageDays(watermark.date) > maxAgeDays)
        warn(
          "log.md",
          `Freshness watermark is ${Math.floor(ageDays(watermark.date))} days old — run the docket-freshness workflow`,
        );
      if ((opts.trailerlessCommits ?? 0) > 0)
        warn(
          "log.md",
          `${opts.trailerlessCommits} trailerless work commit(s) since Freshness watermark ${watermark.sha} (tracker-only chore(docket) commits exempt) — run /docket-freshness`,
        );
    }
  }

  return out;
}
