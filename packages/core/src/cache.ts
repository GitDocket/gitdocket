// SQLite cache: disposable, derived, gitignored — files stay the
// source of truth. bun:sqlite makes this module Bun-only, so it ships as the
// `@gitdocket/core/cache` subpath and the main entry stays runtime-portable.
// Callers with a repo (the CLI) pass in git-derived activity rows.

import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import type { Bundle } from "./bundle";
import type { DocketConfig } from "./config";
import { resolveLink } from "./lint";
import {
  resolveVerifyMarkers,
  scanVerifyMarkers,
  type VerifyMarker,
} from "./verify";

export interface ActivityRow {
  taskId: string;
  sha: string;
  date: string;
  subject: string;
}

export interface GitCheckpoint {
  revision: string;
  time: string;
}

export interface GitWorktreeEvidence {
  path: string;
  head: string;
  ref: string | null;
  activeTaskId: string | null;
  dirty: boolean | null;
  mergedIntoCurrentHead: boolean | null;
  current: boolean;
  available: boolean;
}

export interface GitActivityObservation extends ActivityRow {
  /** Unmerged observations are evidence only; current-checkout state stays canonical. */
  mergedIntoCurrentHead: false;
  refs: string[];
  worktrees: string[];
}

export interface GitEvidence {
  status: "available" | "history-unavailable";
  checkpoint: GitCheckpoint | null;
  /** Canonical activity reachable from the calling checkout's HEAD. */
  activity: ActivityRow[];
  /** Bounded task-linked commits reachable from local tips but not current HEAD. */
  unmergedActivity: GitActivityObservation[];
  /** Bounded linked-checkout inventory, including checkout-local active markers. */
  worktrees: GitWorktreeEvidence[];
  truncated: boolean;
  reason?: string;
}

export interface GitEvidenceOptions {
  commitLimit?: number;
  refLimit?: number;
  worktreeLimit?: number;
  /** Test seam: pinned SHA inventory must survive refs/worktrees disappearing. */
  afterInventory?: () => void;
}

export const GIT_EVIDENCE_COMMIT_LIMIT = 50;
export const GIT_EVIDENCE_REF_LIMIT = 128;
export const GIT_EVIDENCE_WORKTREE_LIMIT = 64;
const GIT_EVIDENCE_SCAN_LIMIT_PER_TIP = 500;

/** Current Git revision and commit time, or undefined outside usable history. */
export function gitCheckpoint(cwd: string): GitCheckpoint | undefined {
  try {
    const [revision, time] = execFileSync(
      "git",
      ["show", "-s", "--format=%H%x1f%cI", "HEAD"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\x1f");
    return revision && time ? { revision, time } : undefined;
  } catch {
    return undefined;
  }
}

const gitOutput = (cwd: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });

function parseActivityRecords(
  output: string,
  byId: Bundle["byId"],
): ActivityRow[] {
  return output
    .split("\x1e")
    .slice(1)
    .flatMap((record) => {
      const [sha, date, subject, trailers] = record.split("\x1f");
      if (!sha || !date) return [];
      return (trailers ?? "")
        .split("\n")
        .map((trailer) => trailer.trim())
        .filter(Boolean)
        .map((id) => ({
          taskId: byId(id)?.fm.id ?? id,
          sha,
          date,
          subject: (subject ?? "").trim(),
        }));
    });
}

function scanHeadActivity(
  cwd: string,
  trailerKey: string,
  byId: Bundle["byId"],
): ActivityRow[] {
  return parseActivityRecords(
    gitOutput(cwd, [
      "log",
      "HEAD",
      `--format=%x1e%H%x1f%cI%x1f%s%x1f%(trailers:key=${trailerKey},valueonly)`,
    ]),
    byId,
  );
}

interface TipSources {
  refs: Set<string>;
  worktrees: Set<string>;
}

function mergedInto(cwd: string, commit: string, head: string): boolean | null {
  const result = Bun.spawnSync(
    ["git", "merge-base", "--is-ancestor", commit, head],
    { cwd, stdout: "ignore", stderr: "ignore" },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return null;
}

function worktreeEvidence(
  cwd: string,
  currentHead: string,
): GitWorktreeEvidence[] {
  const output = gitOutput(cwd, ["worktree", "list", "--porcelain", "-z"]);
  return output
    .split("\0\0")
    .filter(Boolean)
    .flatMap((record): GitWorktreeEvidence[] => {
      const fields = record.split("\0");
      const path = fields
        .find((field) => field.startsWith("worktree "))
        ?.slice("worktree ".length);
      const head = fields
        .find((field) => field.startsWith("HEAD "))
        ?.slice("HEAD ".length);
      if (!path || !head) return [];
      const ref =
        fields
          .find((field) => field.startsWith("branch "))
          ?.slice("branch ".length) ?? null;
      let activeTaskId: string | null = null;
      let dirty: boolean | null = null;
      let available = true;
      try {
        activeTaskId =
          readFileSync(join(path, ".docket", "active-task"), "utf8").trim() ||
          null;
      } catch {
        // A missing marker is the normal idle state; availability is checked
        // independently through Git status below.
      }
      try {
        dirty =
          gitOutput(path, [
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
          ]).trim().length > 0;
      } catch {
        available = false;
      }
      return [
        {
          path,
          head,
          ref,
          activeTaskId,
          dirty,
          mergedIntoCurrentHead: mergedInto(cwd, head, currentHead),
          current: resolve(path) === resolve(cwd),
          available,
        },
      ];
    });
}

function refTips(cwd: string): { ref: string; head: string }[] {
  return gitOutput(cwd, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    "refs/heads",
    "refs/remotes",
  ])
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [ref, head] = line.split("\t");
      return ref && head && /^[0-9a-f]{40}$/i.test(head) ? [{ ref, head }] : [];
    });
}

/**
 * Read-only, local Git evidence. Current-checkout bundle data remains the only
 * source for identity, status, readiness, rollups, and authored narrative;
 * these pinned observations never hydrate concepts from another ref.
 */
export function scanGitEvidence(
  cwd: string,
  trailerKey: string,
  byId: Bundle["byId"],
  options: GitEvidenceOptions = {},
): GitEvidence {
  const checkpoint = gitCheckpoint(cwd);
  if (!checkpoint) {
    return {
      status: "history-unavailable",
      checkpoint: null,
      activity: [],
      unmergedActivity: [],
      worktrees: [],
      truncated: false,
      reason: "Git history is unavailable from this checkout",
    };
  }

  try {
    const commitLimit = options.commitLimit ?? GIT_EVIDENCE_COMMIT_LIMIT;
    const refLimit = options.refLimit ?? GIT_EVIDENCE_REF_LIMIT;
    const worktreeLimit = options.worktreeLimit ?? GIT_EVIDENCE_WORKTREE_LIMIT;
    const allRefs = refTips(cwd).sort((a, z) => a.ref.localeCompare(z.ref));
    const allWorktrees = worktreeEvidence(cwd, checkpoint.revision).sort(
      (a, z) => a.path.localeCompare(z.path),
    );
    const refs = allRefs.slice(0, refLimit);
    const worktrees = allWorktrees.slice(0, worktreeLimit);
    let truncated =
      refs.length < allRefs.length || worktrees.length < allWorktrees.length;

    const tips = new Map<string, TipSources>();
    const sourcesFor = (head: string): TipSources => {
      const existing = tips.get(head) ?? {
        refs: new Set<string>(),
        worktrees: new Set<string>(),
      };
      tips.set(head, existing);
      return existing;
    };
    for (const { ref, head } of refs) sourcesFor(head).refs.add(ref);
    for (const worktree of worktrees) {
      const sources = sourcesFor(worktree.head);
      sources.worktrees.add(worktree.path);
      if (worktree.ref) sources.refs.add(worktree.ref);
    }

    // Refs may disappear after this point; every subsequent read uses the
    // immutable object ID captured above.
    options.afterInventory?.();

    const observations = new Map<
      string,
      GitActivityObservation & {
        refSet: Set<string>;
        worktreeSet: Set<string>;
      }
    >();
    for (const [tip, sources] of tips) {
      if (tip === checkpoint.revision) continue;
      const rows = parseActivityRecords(
        gitOutput(cwd, [
          "log",
          tip,
          "--not",
          checkpoint.revision,
          `--max-count=${GIT_EVIDENCE_SCAN_LIMIT_PER_TIP + 1}`,
          `--format=%x1e%H%x1f%cI%x1f%s%x1f%(trailers:key=${trailerKey},valueonly)`,
        ]),
        byId,
      );
      if (rows.length > GIT_EVIDENCE_SCAN_LIMIT_PER_TIP) truncated = true;
      for (const row of rows.slice(0, GIT_EVIDENCE_SCAN_LIMIT_PER_TIP)) {
        const key = `${row.sha}\x1f${row.taskId}`;
        const observation = observations.get(key) ?? {
          ...row,
          mergedIntoCurrentHead: false as const,
          refs: [],
          worktrees: [],
          refSet: new Set<string>(),
          worktreeSet: new Set<string>(),
        };
        for (const ref of sources.refs) observation.refSet.add(ref);
        for (const path of sources.worktrees) observation.worktreeSet.add(path);
        observations.set(key, observation);
      }
    }

    const unmergedActivity = [...observations.values()]
      .sort(
        (a, z) =>
          z.date.localeCompare(a.date) ||
          a.sha.localeCompare(z.sha) ||
          a.taskId.localeCompare(z.taskId),
      )
      .map(({ refSet, worktreeSet, ...observation }) => ({
        ...observation,
        refs: [...refSet].sort(),
        worktrees: [...worktreeSet].sort(),
      }));
    if (unmergedActivity.length > commitLimit) truncated = true;

    const allActivity = scanHeadActivity(cwd, trailerKey, byId);
    if (allActivity.length > commitLimit) truncated = true;

    return {
      status: "available",
      checkpoint,
      activity: allActivity.slice(0, commitLimit),
      unmergedActivity: unmergedActivity.slice(0, commitLimit),
      worktrees,
      truncated,
    };
  } catch (error) {
    return {
      status: "history-unavailable",
      checkpoint,
      activity: [],
      unmergedActivity: [],
      worktrees: [],
      truncated: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Scan configured repo files for verification markers. This lives beside the
 * cache because both `docket index` and `docket serve` populate the same
 * disposable verification rows from it. No config means a fully dormant
 * feature, and nothing here invokes a test runner.
 */
export async function scanRepoMarkers(
  root: string,
  config: DocketConfig,
  bundle: Bundle,
): Promise<VerifyMarker[]> {
  if (!config.verify) return [];
  const seen = new Set<string>();
  const markers: VerifyMarker[] = [];
  for (const pattern of config.verify.tests) {
    for await (const path of new Glob(pattern).scan({ cwd: root })) {
      const posix = path.replaceAll("\\", "/");
      if (posix.includes("node_modules/") || seen.has(posix)) continue;
      seen.add(posix);
      const content = await readFile(join(root, path), "utf8").catch(() => "");
      markers.push(...scanVerifyMarkers(posix, content));
    }
  }
  markers.sort((a, z) => a.source.localeCompare(z.source) || a.line - z.line);
  return resolveVerifyMarkers(
    markers,
    new Set(bundle.concepts.map((concept) => concept.path)),
  );
}

/** Every commit carrying a Task trailer, one row per (task, commit). Empty if git can't answer. */
export function scanActivity(
  cwd: string,
  trailerKey: string,
  byId: Bundle["byId"],
): ActivityRow[] {
  try {
    return scanHeadActivity(cwd, trailerKey, byId);
  } catch {
    return [];
  }
}

/**
 * Count distinct Task-trailered commits after a state-of-play watermark.
 * Undefined means Git could not resolve the watermark/repository; callers
 * render that uncertainty instead of pretending the note is current.
 */
export function taskLinkedCommitsSince(
  cwd: string,
  trailerKey: string,
  sha: string,
): number | undefined {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return undefined;
  try {
    const records = execFileSync(
      "git",
      [
        "log",
        `${sha}..HEAD`,
        `--format=%x1e%H%x1f%(trailers:key=${trailerKey},valueonly)`,
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).split("\x1e");
    return records.slice(1).filter((record) => {
      const [, trailers = ""] = record.split("\x1f");
      return trailers.trim().length > 0;
    }).length;
  } catch {
    return undefined;
  }
}

const SCHEMA = `
DROP VIEW IF EXISTS backlinks;
DROP VIEW IF EXISTS board;
DROP VIEW IF EXISTS epic_rollup;
DROP TABLE IF EXISTS concepts;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS activity;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS verification_results;
CREATE TABLE concepts (
  path TEXT PRIMARY KEY,
  id TEXT,
  type TEXT NOT NULL,
  title TEXT,
  status TEXT,
  priority TEXT,
  rank REAL,
  epic TEXT,
  timestamp TEXT
);
CREATE TABLE links (from_path TEXT NOT NULL, target TEXT NOT NULL, to_path TEXT);
CREATE TABLE activity (task_id TEXT NOT NULL, sha TEXT NOT NULL, date TEXT NOT NULL, subject TEXT NOT NULL);
-- Verification linkage: resolved docket:verifies markers.
-- kind is 'test' today; 'case' arrives with the eval profile (Phase B).
CREATE TABLE verifications (
  concept_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_path TEXT NOT NULL,
  line INTEGER,
  anchor TEXT
);
-- Populated by verify ingest; empty until then. Ephemeral by design:
-- a cache of CI's last word, dropped on rebuild like every other table.
CREATE TABLE verification_results (
  source_path TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  ran_at TEXT,
  detail TEXT
);
CREATE VIEW backlinks AS
  SELECT to_path AS path, from_path FROM links WHERE to_path IS NOT NULL;
-- Terminal history sorts by transition time (setStatus bumps timestamp),
-- newest first; active columns lead with manual rank — unranked
-- tasks trail in the default priority-then-id order.
CREATE VIEW board AS
  SELECT status, priority, rank, id, title, path, timestamp FROM concepts
  WHERE type = 'Task'
  ORDER BY status,
           CASE WHEN status IN ('done', 'closed') THEN timestamp END DESC,
           rank IS NULL, rank,
           priority, id;
-- last_activity: freshest timestamp across the epic and its tasks (setStatus
-- bumps timestamps, so this tracks the latest status transition anywhere in
-- the epic). Empty string when nothing is stamped, so DESC sorts it last.
CREATE VIEW epic_rollup AS
  SELECT e.id AS epic_id, e.title AS epic_title,
         COUNT(t.path) AS total,
         COALESCE(SUM(t.status = 'done'), 0) AS done,
         COALESCE(SUM(t.status = 'closed'), 0) AS closed,
         max(COALESCE(MAX(t.timestamp), ''), COALESCE(e.timestamp, '')) AS last_activity
  FROM concepts e
  LEFT JOIN concepts t ON t.type = 'Task' AND t.epic LIKE '%/' || e.id || '-%'
  WHERE e.type = 'Epic'
  GROUP BY e.path;
`;

/** Rebuild the cache from scratch — it is derived and disposable, never migrated. */
export function buildCache(
  db: Database,
  bundle: Bundle,
  activity: ActivityRow[] = [],
  verifications: VerifyMarker[] = [],
): void {
  db.exec(SCHEMA);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const paths = new Set(bundle.concepts.map((c) => c.path));

  const insertConcept = db.prepare(
    "INSERT INTO concepts (path, id, type, title, status, priority, rank, epic, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertLink = db.prepare(
    "INSERT INTO links (from_path, target, to_path) VALUES (?, ?, ?)",
  );
  const insertActivity = db.prepare(
    "INSERT INTO activity (task_id, sha, date, subject) VALUES (?, ?, ?, ?)",
  );
  const insertVerification = db.prepare(
    "INSERT INTO verifications (concept_path, kind, source_path, line, anchor) VALUES (?, ?, ?, ?, ?)",
  );

  db.transaction(() => {
    for (const c of bundle.concepts) {
      insertConcept.run(
        c.path,
        str(c.fm.id),
        c.fm.type,
        c.fm.title ?? null,
        str(c.fm.status),
        str(c.fm.priority),
        typeof c.fm.rank === "number" ? c.fm.rank : null,
        str(c.fm.epic),
        str(c.fm.timestamp),
      );
      for (const l of c.links) {
        if (!l.internal) continue;
        const resolved = resolveLink(c.path, l.target);
        insertLink.run(
          c.path,
          l.target,
          resolved && paths.has(resolved) ? resolved : null,
        );
      }
    }
    for (const a of activity)
      insertActivity.run(a.taskId, a.sha, a.date, a.subject);
    for (const v of verifications) {
      if (!v.spec) continue; // unresolved markers are lint's problem, not rows
      insertVerification.run(
        v.spec,
        "test",
        v.source,
        v.line,
        v.anchor ?? null,
      );
    }
  })();
}
