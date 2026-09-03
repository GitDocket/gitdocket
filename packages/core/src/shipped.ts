// Shipped-text history for vendored workflows. Scaffolded workflows
// are repo-owned and may diverge deliberately, so upgrading them is a
// 3-way merge — which needs the base text: what docket shipped at the version
// the repo scaffolded from. That base lives in shipped-history.json, keyed by
// version, kept forever (a few KB of markdown per release).
//
// The current version's texts derive live from DOCKET_WORKFLOWS; the ledger's
// head entry must mirror them at all times (guard-tested — editing a template
// without running `bun run sync-shipped` fails the suite, because it would
// silently rewrite the merge base under every copy vendored at this version,
// Bumping DOCKET_VERSION needs no freeze step: the old head is
// already the frozen record of the outgoing release. See
// docket/reference/releasing.md.

import LEDGER from "./shipped-history.json";
import { DOCKET_VERSION } from "./version";
import { DOCKET_WORKFLOWS } from "./workflows";

/** Provenance of a vendored workflow: which shipped text it descends from. */
export interface Origin {
  /** Workflow slug at ship time, e.g. `docket-close`. */
  slug: string;
  /** Engine version whose shipped text is the merge base, e.g. `0.0.1`. */
  version: string;
}

/** Render an origin as the frontmatter value: `<slug>@<version>`. */
export const formatOrigin = (o: Origin): string => `${o.slug}@${o.version}`;

/** Parse an `origin:` frontmatter value; undefined when malformed. */
export function parseOrigin(value: string): Origin | undefined {
  const match = value.trim().match(/^([a-z0-9-]+)@(\d+\.\d+\.\d+)$/);
  return match?.[1] && match[2]
    ? { slug: match[1], version: match[2] }
    : undefined;
}

/** Shipped workflow bodies per version, newest first. */
export type ShippedHistory = readonly {
  version: string;
  bodies: Record<string, string>;
}[];

/** Frozen bodies of past versions, newest first — the ledger minus the live head. */
const FROZEN: ShippedHistory = LEDGER.filter(
  (h) => h.version !== DOCKET_VERSION,
).map((entry) => ({
  version: entry.version,
  // Different releases legitimately carry different workflow slugs. JSON
  // inference models an absent historical slug as `undefined`; the shipped
  // contract models only the string entries that actually existed.
  bodies: Object.fromEntries(
    Object.entries(entry.bodies).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    ),
  ),
}));

/** All shipped versions, newest first — current release derives live. */
export function shippedHistory(): ShippedHistory {
  const current = {
    version: DOCKET_VERSION,
    bodies: Object.fromEntries(DOCKET_WORKFLOWS.map((w) => [w.slug, w.body])),
  };
  return [current, ...FROZEN];
}

/** The workflow body docket shipped at `version`; undefined if never shipped. */
export function shippedWorkflow(
  slug: string,
  version: string,
  history: ShippedHistory = shippedHistory(),
): string | undefined {
  return history.find((h) => h.version === version)?.bodies[slug];
}

/**
 * Recover provenance for an un-stamped copy by matching its text against
 * every shipped body. Takes the full file source (frontmatter is stripped —
 * timestamps vary per repo, the body is what's vendored). Only exact
 * (whitespace-trimmed) matches recover; a modified copy returns undefined —
 * its true origin is unknowable after the fact, which is why new scaffolds
 * are stamped at birth. Newest matching version wins.
 */
export function recoverOrigin(
  source: string,
  history: ShippedHistory = shippedHistory(),
): Origin | undefined {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  for (const { version, bodies } of history) {
    for (const [slug, shipped] of Object.entries(bodies)) {
      if (shipped.trim() === body) return { slug, version };
    }
  }
  return undefined;
}
