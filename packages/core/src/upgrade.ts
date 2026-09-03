// docket upgrade — pure per-file transforms. Every vendored item retains a
// provenance story, and each category has an explicit upgrade
// story: adapters regenerate when marked (never merged), repo-owned workflows
// 3-way merge against the shipped text at their origin version. Filesystem
// and git orchestration live in the CLI; the merge itself is injected so this
// module stays runtime-portable.

import {
  formatOrigin,
  parseOrigin,
  recoverOrigin,
  type ShippedHistory,
  shippedHistory,
  shippedWorkflow,
} from "./shipped";
import { DOCKET_VERSION } from "./version";
import { hasAdapterMarker } from "./workflows";

export type UpgradeAction =
  | "regenerated"
  | "replaced"
  | "merged"
  | "conflict"
  | "up-to-date"
  | "skipped";

export interface UpgradeResult {
  action: UpgradeAction;
  /** File content after the upgrade (unchanged for up-to-date/skipped). */
  content: string;
  /** Provenance version the file carried before, when determinable. */
  from?: string;
  reason?: string;
}

/**
 * Three-way merge: base = shipped text at origin, ours = the repo's copy,
 * theirs = the new shipped text. Returns merged content and whether conflict
 * markers were left behind. Injected by the caller (`git merge-file` in the
 * CLI) — core doesn't carry a diff3 implementation.
 */
export type Merge3 = (
  base: string,
  ours: string,
  theirs: string,
) => { content: string; conflict: boolean };

/**
 * Version carried by a docket marker line (skill stub, section fence, hook
 * block). Undefined for legacy unversioned markers — report those as
 * upgradable from an unknown version, never a blocker.
 */
export function markerVersion(text: string): string | undefined {
  return text.match(
    /(?:docket init|docket prepare-commit-msg|>>> docket(?: mcp)?)@(\d+\.\d+\.\d+)/,
  )?.[1];
}

/**
 * Upgrade a regenerable adapter: marked files are overwritten with the
 * current generation, hand-authored files are never touched (same rule as
 * init). `generated` is today's render of the same adapter.
 */
export function upgradeAdapter(
  existing: string,
  generated: string,
): UpgradeResult {
  const from = markerVersion(existing);
  if (existing === generated)
    return { action: "up-to-date", content: existing, from };
  if (hasAdapterMarker(existing))
    return { action: "regenerated", content: generated, from };
  return {
    action: "skipped",
    content: existing,
    reason: "hand-authored — remove to regenerate",
  };
}

/** Set (or insert) the `origin:` line inside a frontmatter block. */
function stampOrigin(fm: string, value: string): string {
  if (/^origin:.*$/m.test(fm))
    return fm.replace(/^origin:.*$/m, `origin: ${value}`);
  if (/^tags:/m.test(fm))
    return fm.replace(/^tags:/m, `origin: ${value}\ntags:`);
  return fm.replace(/\n---\n$/, `\norigin: ${value}\n---\n`);
}

/**
 * Upgrade a repo-owned workflow file. Origin comes from the `origin:`
 * frontmatter stamp, falling back to text-match recovery for pre-stamp
 * copies. Unmodified from origin → replace with the new shipped body;
 * diverged → 3-way merge. Only the body and the origin line change — the
 * rest of the frontmatter (timestamp, any customized fields) is repo-owned
 * and never touched. Merges — clean or conflicted — stamp the new version:
 * after resolution the new shipped text is the base the copy descends from.
 */
export function upgradeWorkflowFile(
  source: string,
  opts: { merge3: Merge3; history?: ShippedHistory; current?: string },
): UpgradeResult {
  const history = opts.history ?? shippedHistory();
  const current = opts.current ?? DOCKET_VERSION;

  const fmMatch = source.match(/^---\n[\s\S]*?\n---\n/);
  if (!fmMatch)
    return { action: "skipped", content: source, reason: "no frontmatter" };
  const fm = fmMatch[0];
  const body = source.slice(fm.length).trim();

  const stamped = fm.match(/^origin:\s*(\S+)\s*$/m);
  const origin = stamped?.[1]
    ? parseOrigin(stamped[1])
    : recoverOrigin(source, history);
  if (!origin) {
    return {
      action: "skipped",
      content: source,
      reason: stamped
        ? `malformed origin "${stamped[1]}"`
        : "origin unknown — customized before stamping, resolve by hand",
    };
  }

  const base = shippedWorkflow(origin.slug, origin.version, history);
  if (base === undefined) {
    return {
      action: "skipped",
      content: source,
      from: origin.version,
      reason: `no shipped text for ${formatOrigin(origin)}`,
    };
  }
  const available = shippedWorkflow(origin.slug, current, history);
  if (available === undefined) {
    return {
      action: "skipped",
      content: source,
      from: origin.version,
      reason: `${origin.slug} is not shipped at ${current}`,
    };
  }

  const newFm = stampOrigin(fm, `${origin.slug}@${current}`);
  const rebuild = (newBody: string) => `${newFm}\n${newBody.trim()}\n`;

  if (body === base.trim()) {
    const content = rebuild(available);
    return content === source
      ? { action: "up-to-date", content: source, from: origin.version }
      : { action: "replaced", content, from: origin.version };
  }

  const merged = opts.merge3(base.trim(), body, available.trim());
  const content = rebuild(merged.content);
  if (merged.conflict)
    return { action: "conflict", content, from: origin.version };
  if (content === source) {
    // Nothing propagated. When the copy still differs from the shipped text,
    // say so instead of a bare up-to-date — this is either a customization
    // (fine) or a copy vendored from a since-edited pre-release template
    // A bare report would hide this change.
    const reason =
      body === available.trim()
        ? {}
        : {
            reason: `differs from shipped ${current} — local text kept (customized, or the template changed in place)`,
          };
    return {
      action: "up-to-date",
      content: source,
      from: origin.version,
      ...reason,
    };
  }
  return { action: "merged", content, from: origin.version };
}
