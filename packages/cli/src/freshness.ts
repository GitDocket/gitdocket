// Freshness-nag support: count commits since the watermark
// that never answered the reconciliation question. Trailerless *work* commits
// are the risk; tracker-only chores are sanctioned trailerless (the
// docket-freshness/groom workflows clear the active task on purpose), so
// counting them made every sweep re-fire the nag it had just cleared.

import { execFileSync } from "node:child_process";

/** Sanctioned tracker-only commits — the repo commit-style convention. */
const CHORE_PREFIX = /^chore\(docket\):/;

/**
 * Commits in `sha..HEAD` lacking the Task trailer, excluding sanctioned
 * `chore(docket):` chores. Undefined if git can't answer (not a checkout, or
 * the watermark sha is gone after a rebase).
 */
export function trailerlessSince(
  root: string,
  sha: string,
  trailer: string,
): number | undefined {
  try {
    const records = execFileSync(
      "git",
      [
        "log",
        `${sha}..HEAD`,
        `--format=%x1e%s%x1f%(trailers:key=${trailer},valueonly)`,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).split("\x1e");
    return records.slice(1).filter((record) => {
      const [subject, trailers] = record.split("\x1f");
      return !trailers?.trim() && !CHORE_PREFIX.test(subject ?? "");
    }).length;
  } catch {
    return undefined;
  }
}
