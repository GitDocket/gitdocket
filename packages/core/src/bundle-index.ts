import {
  assembleBundle,
  type Bundle,
  clearMetadata,
  seedMetadata,
} from "./bundle";
import type { DocketConfig } from "./config";
import { mapFiles } from "./file-batch";
import type { FileStore } from "./filestore";
import { parseConcept } from "./parse";
import { buildSchemas } from "./schema";
import { SearchIndex } from "./search-index";
import { shareSourceMetadata } from "./source-page";

interface Entry {
  version?: string;
  source: string;
  parsed: ReturnType<typeof parseConcept>;
}

export interface BundleSnapshot {
  readonly generation: number;
  readonly bundle: Bundle;
  readonly sources: ReadonlyMap<string, string>;
  readonly search: SearchIndex;
}

/**
 * Process-local, disposable state. A refresh reconciles the full file inventory
 * but only reads changed versioned files and only parses changed contents.
 * Stores without reliable versions fall back to reading/comparing source.
 * No cache files are read or written, including on read-only orientation paths.
 */
export class BundleIndex {
  private entries = new Map<string, Entry>();
  private configKey?: string;
  private current?: BundleSnapshot;
  private pending: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();

  constructor(private readonly store: FileStore) {}

  /** Published snapshots remain coherent while the next generation is built. */
  get snapshot(): BundleSnapshot | undefined {
    return this.current;
  }

  refresh(
    config: DocketConfig,
    options: { changedPaths?: readonly string[] } = {},
  ): Promise<BundleSnapshot> {
    // Serialize refreshes; a failed build never poisons later attempts.
    const next = this.pending.then(() =>
      this.build(config, options.changedPaths),
    );
    this.pending = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  close(): void {
    this.controller.abort();
    this.current = undefined;
    this.entries.clear();
    clearMetadata(this.store);
  }

  private async build(
    config: DocketConfig,
    changedPaths?: readonly string[],
  ): Promise<BundleSnapshot> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    const key = JSON.stringify(config);
    const schemas = buildSchemas(config);
    // Event paths are an optimization hint, never the reconciliation policy.
    // Owners must periodically call refresh without hints to recover missed
    // events; configuration changes always perform a complete reconciliation.
    const inventory = await this.store.list();
    const listed = new Set(inventory);
    const partial =
      changedPaths !== undefined &&
      this.store.version !== undefined &&
      key === this.configKey &&
      this.current !== undefined &&
      changedPaths.every((path) => listed.has(path) || this.entries.has(path));
    const paths = partial ? [...new Set(changedPaths)].sort() : inventory;
    const updates = await mapFiles(
      paths,
      async (path): Promise<[string, Entry | undefined]> => {
        if (!listed.has(path)) return [path, undefined];
        const old = this.entries.get(path);
        let version: string | undefined;
        try {
          version = await this.store.version?.(path);
        } catch (error) {
          if (partial && (error as NodeJS.ErrnoException).code === "ENOENT")
            return [path, undefined];
          throw error;
        }
        if (
          !partial &&
          old &&
          version !== undefined &&
          version === old.version &&
          key === this.configKey
        )
          return [path, old];
        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          const source = await this.store.read(path);
          const after = await this.store.version?.(path);
          if (version !== after) {
            version = after;
            continue;
          }
          if (
            old?.source === source &&
            old.version === after &&
            key === this.configKey
          )
            return [path, old];
          const parsed =
            old?.source === source && key === this.configKey
              ? old.parsed
              : parseConcept(path, source, schemas);
          return [path, { version: after, source, parsed }];
        }
        throw new Error(`file changed repeatedly while loading: ${path}`);
      },
      signal,
    );
    signal.throwIfAborted();
    const nextEntries = partial
      ? new Map(this.entries)
      : new Map<string, Entry>();
    for (const [path, entry] of updates) {
      if (entry) nextEntries.set(path, entry);
      else nextEntries.delete(path);
    }
    const entries = [...nextEntries].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (
      key === this.configKey &&
      entries.length === this.entries.size &&
      entries.every(([path, entry]) => this.entries.get(path) === entry) &&
      this.current
    )
      return this.current;
    const concepts = entries.flatMap(([, entry]) =>
      entry.parsed.concept ? [entry.parsed.concept] : [],
    );
    const diagnostics = entries.flatMap(
      ([, entry]) => entry.parsed.diagnostics,
    );
    const bundle = assembleBundle(config, concepts, diagnostics);
    const sources = new Map(
      entries.map(([path, entry]) => [path, entry.source]),
    );
    const search = new SearchIndex(bundle, sources, this.current?.search);
    shareSourceMetadata(this.current?.sources, sources);
    signal.throwIfAborted();
    const snapshot = {
      generation: (this.current?.generation ?? 0) + 1,
      bundle,
      sources,
      search,
    };
    this.entries = new Map(entries);
    this.configKey = key;
    this.current = snapshot;
    seedMetadata(this.store, config, entries);
    return snapshot;
  }
}
