// Verification linkage: a `docket:verifies /specs/x.md`
// comment in a test file claims that file protects that spec. Linkage is
// derived, never declared — this module is pure text/graph logic; the CLI
// owns globbing and file IO, and Docket never runs the tests it maps.

import type { Bundle } from "./bundle";

export const VERIFY_TOKEN = "docket:verifies";

export interface VerifyMarker {
  /** Repo-relative path of the file carrying the marker. */
  source: string;
  /** 1-indexed line the marker sits on. */
  line: number;
  /** Raw target as written: `/specs/x.md` or `/specs/x.md#anchor`. */
  target: string;
  /** Bundle path of the target concept — undefined when unresolvable. */
  spec?: string;
  /** Heading anchor, preserved for finer-than-file grain. */
  anchor?: string;
}

// Any comment syntax matches: the token is distinctive enough that we scan
// raw text rather than parse per-language comments. Consequence: a string
// literal containing the token also matches (this bit our own test fixtures)
// — files that must *mention* the token split it, keeping coverage explicit.
const MARKER = new RegExp(`${VERIFY_TOKEN}\\s+(\\S+)`);

// Targets are path-shaped; cut at the first character that isn't. Sheds
// trailing comment closers (`-->`, `*/`) and quote/punctuation debris.
const trimTarget = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9._/#-].*$/, "");

/** Extract raw markers from one file's text. `spec` stays unset — resolve separately. */
export function scanVerifyMarkers(
  source: string,
  content: string,
): VerifyMarker[] {
  const out: VerifyMarker[] = [];
  content.split("\n").forEach((text, i) => {
    const match = text.match(MARKER);
    if (!match?.[1]) return;
    const target = trimTarget(match[1]);
    if (!target) return;
    const anchor = target.split("#")[1];
    out.push({
      source,
      line: i + 1,
      target,
      ...(anchor ? { anchor } : {}),
    });
  });
  return out;
}

/**
 * Fill `spec` on markers whose target is a bundle-absolute `.md` path naming
 * an existing concept. Anything else (relative paths, missing files) stays
 * unresolved — lint turns those into warnings.
 */
export function resolveVerifyMarkers(
  markers: VerifyMarker[],
  conceptPaths: ReadonlySet<string>,
): VerifyMarker[] {
  return markers.map((m) => {
    const clean = m.target.split("#")[0] ?? "";
    if (!clean.startsWith("/") || !clean.endsWith(".md")) return m;
    const path = clean.slice(1);
    return conceptPaths.has(path) ? { ...m, spec: path } : m;
  });
}

export interface VerifySource {
  source: string;
  line: number;
  anchor?: string;
}

export interface VerifyStatusRow {
  /** Bundle path of the spec (or other targeted concept). */
  spec: string;
  title?: string;
  type: string;
  sources: VerifySource[];
  /** True only for Spec-type concepts nothing verifies — the signal is zero. */
  unverified: boolean;
}

/**
 * Presence per spec: every `type: Spec` concept, plus any other concept a
 * marker targets. Presence marks only — no counts-as-scores.
 */
export function verifyStatus(
  bundle: Bundle,
  markers: VerifyMarker[],
): VerifyStatusRow[] {
  const bySpec = new Map<string, VerifySource[]>();
  for (const m of markers) {
    if (!m.spec) continue;
    const sources = bySpec.get(m.spec) ?? [];
    sources.push({
      source: m.source,
      line: m.line,
      ...(m.anchor ? { anchor: m.anchor } : {}),
    });
    bySpec.set(m.spec, sources);
  }

  const rows: VerifyStatusRow[] = [];
  for (const c of bundle.concepts) {
    const targeted = bySpec.has(c.path);
    if (c.fm.type !== "Spec" && !targeted) continue;
    rows.push({
      spec: c.path,
      title: c.fm.title,
      type: c.fm.type,
      sources: bySpec.get(c.path) ?? [],
      unverified: c.fm.type === "Spec" && !targeted,
    });
  }
  return rows.sort((a, z) => a.spec.localeCompare(z.spec));
}
