// Exact one-shot search: retain sources for this call and hydrate only the
// Markdown neighborhoods that can contribute to its ranked results.
import { loadMetadataBundle } from "./bundle";
import type { DocketConfig } from "./config";
import type { FileStore } from "./filestore";
import { parseConcept } from "./parse";
import { buildSchemas } from "./schema";
import { attachSearchNeighborhoods, searchBundle } from "./search";

export async function searchFresh(
  store: FileStore,
  config: DocketConfig,
  query: string,
  opts: { limit?: number } = {},
) {
  const paths = await store.list();
  const sources = new Map<string, Promise<string>>();
  const capture: FileStore = {
    list: async () => paths,
    read: (path) => {
      let source = sources.get(path);
      if (!source) {
        source = store.read(path);
        sources.set(path, source);
      }
      return source;
    },
    write: async () => {
      throw new Error("search capture is read-only");
    },
  };
  const bundle = await loadMetadataBundle(capture, config, { cache: false });
  const hits = await searchBundle(capture, bundle, query, {
    ...opts,
    includeGraph: false,
  });
  const byPath = new Map(
    bundle.concepts.map((concept) => [concept.path, concept]),
  );
  const selected = new Set(
    hits.filter((hit) => byPath.has(hit.path)).map((hit) => hit.path),
  );
  if (!selected.size) return hits;
  const names = [...selected].map((path) => path.split("/").at(-1) ?? "");
  // resolveLink requires a literal .md filename. In unescaped ASCII source,
  // an inbound URL must contain that filename. Escapes, entities, percent
  // forms and control normalization use the complete parser conservatively.
  // Non-ASCII/complex filenames likewise retain a complete graph capture.
  const simpleNames = names.every((name) => /^[A-Za-z0-9_.-]+\.md$/.test(name));
  const schemas = buildSchemas(config);
  const concepts = [];
  for (const concept of bundle.concepts) {
    const source = await capture.read(concept.path);
    const possible =
      selected.has(concept.path) ||
      !simpleNames ||
      /[\\&%\0\r\t]/.test(source) ||
      names.some((name) => source.includes(name));
    concepts.push(
      possible
        ? (parseConcept(concept.path, source, schemas).concept ?? concept)
        : concept,
    );
  }
  attachSearchNeighborhoods(hits, concepts, paths);
  return hits;
}
