// SQLite cache: disposable, derived, gitignored — files stay the
// source of truth. bun:sqlite makes this module Bun-only, so it ships as the
// `@gitdocket/core/cache` subpath and the main entry stays runtime-portable.
// Callers with a repo (the CLI) pass in git-derived activity rows.

import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
    const records = execFileSync(
      "git",
      [
        "log",
        `--format=%x1e%H%x1f%cI%x1f%s%x1f%(trailers:key=${trailerKey},valueonly)`,
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).split("\x1e");
    return records.slice(1).flatMap((record) => {
      const [sha, date, subject, trailers] = record.split("\x1f");
      if (!sha || !date) return [];
      return (trailers ?? "")
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((id) => ({
          taskId: byId(id)?.fm.id ?? id, // aliases resolve to the canonical id
          sha,
          date,
          subject: (subject ?? "").trim(),
        }));
    });
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
