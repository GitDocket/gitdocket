import {
  type Bundle,
  BundleIndex,
  type BundleSnapshot,
  clearMetadata,
  type DocketConfig,
  type FileStore,
  loadMetadataBundle,
  readProjectGuidance,
} from "@gitdocket/core";
import { GitEvidenceIndex } from "@gitdocket/core/cache";

export interface RepositoryInput {
  store: FileStore;
  config: DocketConfig;
}
export type RepositoryResolver = () => Promise<RepositoryInput>;
interface ReadSnapshot extends RepositoryInput {
  snapshot: BundleSnapshot;
}

/** Reconcile on every read; concurrent readers share only the in-flight work.
 * Writes validate live files inside one queue and invalidate even on failure.
 */
export class RepositoryOwner {
  private current?: RepositoryInput & { index: BundleIndex };
  private pending?: Promise<ReadSnapshot>;
  private pendingMetadata?: Promise<RepositoryInput & { bundle: Bundle }>;
  private writes: Promise<void> = Promise.resolve();
  private epoch = 0;
  private closed = false;
  private readonly controller = new AbortController();
  private metadataStore?: FileStore;
  private metadataCount?: number;

  dimensions() {
    const snapshot = this.current?.index.snapshot;
    return {
      indexState: snapshot
        ? ("search" as const)
        : this.metadataCount !== undefined
          ? ("metadata" as const)
          : ("uninitialized" as const),
      concepts: snapshot?.bundle.concepts.length ?? this.metadataCount ?? null,
      generation: snapshot?.generation ?? null,
    };
  }
  private pageSources = new Map<string, string>();
  private git?: { trailer: string; index: GitEvidenceIndex };

  constructor(
    private readonly resolve: RepositoryResolver,
    private readonly root?: string,
  ) {}

  private check() {
    if (this.closed) throw new Error("MCP repository is closed");
  }

  read(): Promise<ReadSnapshot> {
    this.check();
    if (this.pending) return this.pending;
    const next = this.refresh();
    this.pending = next;
    void next
      .finally(() => {
        if (this.pending === next) this.pending = undefined;
      })
      .catch(() => {});
    return next;
  }

  private async refresh(): Promise<ReadSnapshot> {
    for (;;) {
      const writes = this.writes;
      await writes;
      if (writes !== this.writes) continue;
      this.check();
      const epoch = this.epoch;
      const input = await this.resolve();
      this.check();
      if (!this.current || this.current.store !== input.store) {
        this.current?.index.close();
        this.current = { ...input, index: new BundleIndex(input.store) };
      }
      const snapshot = await this.current.index.refresh(input.config);
      this.check();
      if (epoch !== this.epoch) continue;
      return { ...input, snapshot };
    }
  }

  metadata(): Promise<RepositoryInput & { bundle: Bundle }> {
    this.check();
    if (this.pendingMetadata) return this.pendingMetadata;
    const next = this.consistent(async (input) => {
      if (this.metadataStore && this.metadataStore !== input.store)
        clearMetadata(this.metadataStore);
      this.metadataStore = input.store;
      const bundle = await loadMetadataBundle(input.store, input.config, {
        signal: this.controller.signal,
      });
      this.metadataCount = bundle.concepts.length;
      return { ...input, bundle };
    });
    this.pendingMetadata = next;
    void next
      .finally(() => {
        if (this.pendingMetadata === next) this.pendingMetadata = undefined;
      })
      .catch(() => {});
    return next;
  }

  source(path: string): Promise<string> {
    return this.consistent(async ({ store }) => {
      if (!(await store.list()).includes(path))
        throw new Error(`not found: ${path}`);
      return store.read(path);
    });
  }

  guidance() {
    return this.consistent(({ store, config }) =>
      readProjectGuidance(store, config),
    );
  }

  async sourceMap(path: string): Promise<ReadonlyMap<string, string>> {
    const source = await this.source(path);
    this.check();
    if (this.pageSources.get(path) !== source)
      this.pageSources = new Map([[path, source]]);
    return this.pageSources;
  }

  private async consistent<T>(
    read: (input: RepositoryInput) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const writes = this.writes;
      await writes;
      if (writes !== this.writes) continue;
      this.check();
      const epoch = this.epoch;
      const input = await this.resolve();
      this.check();
      const result = await read(input);
      this.check();
      if (epoch === this.epoch) return result;
    }
  }

  mutate<T>(operation: (input: RepositoryInput) => Promise<T>): Promise<T> {
    this.check();
    this.epoch++;
    const next = this.writes.then(async () => {
      this.check();
      const input = await this.resolve();
      this.check();
      try {
        return await operation(input);
      } finally {
        this.epoch++;
      }
    });
    this.writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  evidence(config: DocketConfig): GitEvidenceIndex | undefined {
    this.check();
    if (!this.root) return undefined;
    if (!this.git || this.git.trailer !== config.git.trailer) {
      this.git?.index.close();
      this.git = {
        trailer: config.git.trailer,
        index: new GitEvidenceIndex(this.root, config.git.trailer),
      };
    }
    return this.git.index;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.epoch++;
    this.current?.index.close();
    this.git?.index.close();
    if (this.metadataStore) clearMetadata(this.metadataStore);
    this.metadataStore = undefined;
    this.pageSources = new Map();
    this.current = undefined;
    this.git = undefined;
  }
}

/** Keep source reads coherent with the parsed generation. */
export function snapshotStore(snapshot: BundleSnapshot): FileStore {
  return {
    list: async () => [...snapshot.sources.keys()],
    read: async (path) => {
      const source = snapshot.sources.get(path);
      if (source === undefined) throw new Error(`not found: ${path}`);
      return source;
    },
    write: async () => {
      throw new Error("snapshot is read-only");
    },
  };
}
