// Disposable, generation-scoped exact search. No embeddings or persistent state.
import type { Bundle } from "./bundle";
import { resolveLink } from "./lint";
import type { Concept } from "./parse";
import type { NeighborRef, SearchHit } from "./search";
import { recordWork } from "./work-metrics";

const tokens = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/** Visit exact ASCII search tokens without materializing every repeated word. */
function eachToken(value: string, visit: (word: string) => void): void {
  const lower = value.toLowerCase();
  let start = -1;
  for (let index = 0; index <= lower.length; index++) {
    const code = lower.charCodeAt(index);
    const word = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (word && start < 0) start = index;
    else if (!word && start >= 0) {
      visit(lower.slice(start, index));
      start = -1;
    }
  }
}
const compact = (value: string) => value.toLowerCase().replace(/[-\s]/g, "");
const matches = (values: readonly string[], term: string) =>
  values.some((value) => value.startsWith(term));

interface Document {
  source: string;
  concept?: Concept;
  key: number;
  words: readonly string[];
  fields: string[];
  id?: string;
  title?: string;
  number?: string;
}

/** Snapshots share unchanged documents/postings; updates never mutate a reader. */
export class SearchIndex {
  private readonly documents: ReadonlyMap<string, Document>;
  private readonly postings: ReadonlyMap<string, Uint32Array>;
  private readonly paths = new Map<number, string>();
  private nextKey = 0;
  private readonly vocabulary: string[];
  private readonly pathOrder: ReadonlyMap<string, number>;
  private readonly identities = new Map<string, string>();
  private readonly inbound = new Map<string, Set<string>>();

  constructor(
    bundle: Bundle,
    sources: ReadonlyMap<string, string>,
    previous?: SearchIndex,
  ) {
    // Rebase a long-lived owner before its numeric keys could wrap. Rebuilding
    // this generation leaves older readers and their postings untouched.
    if (previous && previous.nextKey > 0x100000000 - sources.size)
      previous = undefined;
    const byPath = new Map(
      bundle.concepts.map((concept) => [concept.path, concept]),
    );
    const documents = new Map<string, Document>();
    this.nextKey = previous?.nextKey ?? 0;
    const postings = new Map(previous?.postings);
    const vocabulary = new Map<string, string>();
    for (const word of postings.keys()) vocabulary.set(word, word);
    const intern = (word: string) => {
      const existing = vocabulary.get(word);
      if (existing !== undefined) return existing;
      vocabulary.set(word, word);
      return word;
    };
    const changed = new Map<string, Set<number>>();
    const initial = new Map<string, number[]>();
    const change = (word: string) => {
      let paths = changed.get(word);
      if (!paths) {
        paths = new Set(postings.get(word));
        changed.set(word, paths);
      }
      return paths;
    };
    for (const [path, old] of previous?.documents ?? []) {
      if (sources.has(path)) continue;
      for (const word of old.words) change(word).delete(old.key);
    }
    for (const [path, source] of sources) {
      const concept = byPath.get(path);
      const old = previous?.documents.get(path);
      if (old?.source === source && old.concept === concept) {
        documents.set(path, old);
        this.paths.set(old.key, path);
        continue;
      }
      const fm = concept?.fm;
      recordWork("searchDocument");
      const id = typeof fm?.id === "string" ? fm.id : undefined;
      const fields = tokens(`${id ?? ""} ${fm?.title ?? ""}`).map(intern);
      const words = new Set(fields);
      eachToken(source, (word) => words.add(intern(word)));
      const key = old?.key ?? this.nextKey++;
      if (key > 0xffffffff)
        throw new Error(
          "Search document capacity exceeded; restart the index.",
        );
      this.paths.set(key, path);
      documents.set(path, {
        source,
        concept,
        key,
        words: [...words],
        fields,
        id,
        title: fm?.title,
        number:
          fm?.type === "Task" || fm?.type === "Epic"
            ? id?.match(/-(\d+)$/)?.[1]
            : undefined,
      });
      const oldWords = old ? new Set(old.words) : undefined;
      for (const word of words) {
        if (oldWords?.has(word)) continue;
        if (previous) change(word).add(key);
        else {
          const keys = initial.get(word);
          if (keys) keys.push(key);
          else initial.set(word, [key]);
        }
      }
      for (const word of oldWords ?? [])
        if (!words.has(word)) change(word).delete(key);
    }
    for (const [word, keys] of initial)
      postings.set(word, Uint32Array.from(keys));
    for (const [word, paths] of changed) {
      if (paths.size) postings.set(word, Uint32Array.from(paths));
      else postings.delete(word);
    }
    this.documents = documents;
    this.pathOrder = new Map(
      [...sources.keys()].map((path, index) => [path, index]),
    );
    this.postings = postings;
    this.vocabulary = [...postings.keys()].sort();
    for (const concept of bundle.concepts) {
      const id = concept.fm.id;
      if (typeof id === "string" && !this.identities.has(compact(id)))
        this.identities.set(compact(id), id);
      for (const link of concept.links) {
        if (!link.internal) continue;
        const target = resolveLink(concept.path, link.target);
        if (!target || target === concept.path) continue;
        this.inbound.get(target)?.add(concept.path) ??
          this.inbound.set(target, new Set([concept.path]));
      }
    }
  }

  private candidates(term: string): Set<string> {
    // Prefix range in the vocabulary, rather than scanning every document.
    let low = 0;
    let high = this.vocabulary.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.vocabulary[middle] ?? "") < term) low = middle + 1;
      else high = middle;
    }
    const paths = new Set<string>();
    for (let index = low; index < this.vocabulary.length; index++) {
      const word = this.vocabulary[index];
      if (!word?.startsWith(term)) break;
      for (const key of this.postings.get(word) ?? []) {
        const path = this.paths.get(key);
        if (path !== undefined) paths.add(path);
      }
    }
    return paths;
  }

  search(query: string, opts: { limit?: number } = {}): SearchHit[] {
    return this.searchPage(query, opts).hits;
  }
  searchPage(
    query: string,
    opts: {
      limit?: number;
      offset?: number;
      includeGraph?: boolean;
      maxSnippetChars?: number;
    } = {},
  ): { hits: SearchHit[]; total: number } {
    const lookup = query.trim().toLowerCase();
    const canonicalId = this.identities.get(compact(lookup));
    const terms = [...new Set(tokens(canonicalId ?? query))];
    if (!terms.length) return { hits: [], total: 0 };
    const number = lookup.match(/^#?(\d+)$/)?.[1];
    const matched = new Map<string, string[]>();
    for (const term of terms) {
      for (const path of this.candidates(term)) {
        if (number && !this.documents.get(path)?.number?.startsWith(number))
          continue;
        const values = matched.get(path);
        if (values) values.push(term);
        else matched.set(path, [term]);
      }
    }
    const ranked = [...matched].map(([path, terms]) => {
      const doc = this.documents.get(path);
      if (!doc) throw new Error(`search index is missing ${path}`);
      return {
        path,
        doc,
        matched: terms,
        exact: Boolean(
          doc.id &&
            (doc.id === canonicalId || (number && doc.number === number)),
        ),
        score: terms.reduce(
          (sum, term) => sum + (matches(doc.fields, term) ? 3 : 1),
          0,
        ),
      };
    });
    ranked.sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.matched.length - a.matched.length ||
        b.score - a.score ||
        a.path.localeCompare(b.path) ||
        (this.pathOrder.get(a.path) ?? 0) - (this.pathOrder.get(b.path) ?? 0),
    );
    const ref = (path: string): NeighborRef => {
      const doc = this.documents.get(path);
      return {
        path,
        ...(typeof doc?.id === "string" ? { id: doc.id } : {}),
        ...(doc?.title ? { title: doc.title } : {}),
      };
    };
    const hits = ranked
      .slice(
        opts.offset ?? 0,
        (opts.offset ?? 0) + Math.max(1, opts.limit ?? 20),
      )
      .map(({ path, doc, matched, score }) => {
        // Only surviving results need snippets. Source is retained once per file;
        // large logs do not retain a second copy as line/token object graphs.
        const lines = doc.source.split("\n");
        let best = 0;
        let count = 0;
        for (let line = 0; line < lines.length; line++) {
          const words = tokens(lines[line] ?? "");
          const found = terms.filter((term) => matches(words, term)).length;
          if (found > count) {
            best = line;
            count = found;
          }
          if (count === matched.length) break;
        }
        const hit: SearchHit = {
          path,
          line: best + 1,
          text: (lines[best] ?? "").trim().slice(0, opts.maxSnippetChars),
          matched,
          score,
          ...(doc.id ? { id: doc.id } : {}),
          ...(doc.title ? { title: doc.title } : {}),
        };
        if (doc.concept && opts.includeGraph !== false) {
          const outbound = new Set<string>();
          for (const link of doc.concept.links) {
            if (!link.internal) continue;
            const target = resolveLink(path, link.target);
            if (target && target !== path && this.documents.has(target))
              outbound.add(target);
          }
          hit.links = [...outbound].map(ref);
          hit.backlinks = [...(this.inbound.get(path) ?? [])].sort().map(ref);
        }
        return hit;
      });
    return { hits, total: ranked.length };
  }
}
