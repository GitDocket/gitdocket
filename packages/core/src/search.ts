// Read-side ranked text search over a bundle's files. Lives in core so every
// surface (CLI, MCP, web) shares one definition of "search" — hits carry
// the owning concept's id/title when the file parses as one.
//
// Search is the entry-point finder: queries are tokenized, terms
// match anywhere in any order, and results come back best-first — more terms
// matched beats fewer, title/id matches outweigh body matches. One hit per
// file, snippeted at its best-matching line. No index build, no dependencies;
// same bundle + query always yields the same ordering.

import type { Bundle } from "./bundle";
import type { FileStore } from "./filestore";
import { resolveLink } from "./lint";

/** A neighboring concept: identity only, never contents — hits stay compact. */
export interface NeighborRef {
  path: string;
  id?: string;
  title?: string;
}

export interface SearchHit {
  path: string;
  /** 1-based line of the best-matching snippet. */
  line: number;
  text: string;
  id?: string;
  title?: string;
  /** Distinct query terms that matched this file. */
  matched: string[];
  score: number;
  /** Outbound links of the owning concept (concept hits only). */
  links?: NeighborRef[];
  /** Concepts that link here (concept hits only). */
  backlinks?: NeighborRef[];
}

const FIELD_WEIGHT = 3; // term found in frontmatter title/id
const BODY_WEIGHT = 1;

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A term hits a token by prefix — "navig" finds "navigation", "dkt" finds a Docket ID. */
const hasMatch = (tokens: string[], term: string): boolean =>
  tokens.some((t) => t.startsWith(term));

export async function searchBundle(
  store: FileStore,
  bundle: Bundle,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchHit[]> {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const limit = Math.max(1, opts.limit ?? 20);

  const byPath = new Map(bundle.concepts.map((c) => [c.path, c]));
  const allPaths = await store.list();
  const exists = new Set(allPaths);
  const hits: SearchHit[] = [];

  for (const path of allPaths) {
    const lines = (await store.read(path)).split("\n");
    const lineTokens = lines.map(tokenize);
    const fm = byPath.get(path)?.fm;
    const id = typeof fm?.id === "string" ? fm.id : undefined;
    const fieldTokens = tokenize(`${id ?? ""} ${fm?.title ?? ""}`);

    const matched = terms.filter(
      (t) =>
        hasMatch(fieldTokens, t) || lineTokens.some((lt) => hasMatch(lt, t)),
    );
    if (matched.length === 0) continue;

    // Snippet: the line matching the most terms, earliest on ties. Frontmatter
    // lines participate, so title/id-only matches still snippet somewhere real.
    let best = 0;
    let bestCount = 0;
    for (const [i, tokens] of lineTokens.entries()) {
      const count = terms.filter((t) => hasMatch(tokens, t)).length;
      if (count > bestCount) {
        bestCount = count;
        best = i;
      }
    }

    hits.push({
      path,
      line: best + 1,
      text: (lines[best] ?? "").trim(),
      ...(id ? { id } : {}),
      ...(fm?.title ? { title: fm.title } : {}),
      matched,
      score: matched.reduce(
        (s, t) => s + (hasMatch(fieldTokens, t) ? FIELD_WEIGHT : BODY_WEIGHT),
        0,
      ),
    });
  }

  // Best-first after the full scan: more terms, then weight, then path for
  // a deterministic total order. Limit applies here, not during the scan.
  hits.sort(
    (a, z) =>
      z.matched.length - a.matched.length ||
      z.score - a.score ||
      a.path.localeCompare(z.path),
  );
  const top = hits.slice(0, limit);

  // Neighborhood: the hit is the foothold, its links are the map.
  // Derived from the same parse lint/index use — no second source of truth —
  // and only for the hits that survived ranking.
  const inbound = new Map<string, Set<string>>();
  for (const c of bundle.concepts)
    for (const l of c.links) {
      if (!l.internal) continue;
      const to = resolveLink(c.path, l.target);
      if (!to || to === c.path) continue;
      inbound.get(to)?.add(c.path) ?? inbound.set(to, new Set([c.path]));
    }
  const ref = (path: string): NeighborRef => {
    const fm = byPath.get(path)?.fm;
    return {
      path,
      ...(typeof fm?.id === "string" ? { id: fm.id } : {}),
      ...(fm?.title ? { title: fm.title } : {}),
    };
  };
  for (const hit of top) {
    const concept = byPath.get(hit.path);
    if (!concept) continue; // non-concept file: no neighborhood, no error
    const outbound = new Set<string>();
    for (const l of concept.links) {
      if (!l.internal) continue;
      const to = resolveLink(concept.path, l.target);
      if (to && to !== concept.path && exists.has(to)) outbound.add(to);
    }
    hit.links = [...outbound].map(ref);
    hit.backlinks = [...(inbound.get(hit.path) ?? [])].sort().map(ref);
  }
  return top;
}
