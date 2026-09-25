// One published generation per repository. Requests lease it across awaits.
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Bundle,
  BundleIndex,
  type BundleSnapshot,
  type DocketConfig,
  LocalFileStore,
  parseConfig,
} from "@gitdocket/core";
import {
  type ActivityRow,
  buildCache,
  type GitCheckpoint,
  type GitEvidence,
  GitEvidenceIndex,
  scanRepoMarkers,
} from "@gitdocket/core/cache";

export interface RepoState {
  bundle: Bundle;
  db: Database;
  git: GitEvidence;
  config: DocketConfig;
  store: LocalFileStore;
  sources: BundleSnapshot["sources"];
  search: BundleSnapshot["search"];
  generation: number;
  countSince(sha: string): Promise<number | undefined>;
}
export interface RepoLease {
  state: RepoState;
  error?: string;
  release(): void;
}
export interface RepoContext {
  root: string;
  readonly config: DocketConfig;
  readonly store: LocalFileStore;
  /** Use acquire() when retaining a database across awaits. */
  state(): Promise<RepoState>;
  telemetryDimensions?(): {
    indexState: "uninitialized" | "search";
    concepts: number | null;
    generation: number | null;
  };
  acquire(): Promise<RepoLease>;
  invalidate(paths?: readonly string[]): void;
  invalidateGit(): void;
  refresh(options?: { background?: boolean }): Promise<RepoState>;
  subscribe(changed: () => void): () => void;
  mutate<T>(
    write: (store: LocalFileStore, config: DocketConfig) => Promise<T>,
  ): Promise<T>;
  countSince(
    sha: string,
    checkpoint: GitCheckpoint | null,
  ): Promise<number | undefined>;
  close(): void;
}
interface Slot {
  state: RepoState;
  database: { db: Database; owners: number };
  readers: number;
  retired: boolean;
  disposed: boolean;
}
export function createRepoContext(
  root: string,
  initialConfig: DocketConfig,
  opts: {
    ttlMs?: number;
    onBuild?: () => void;
    loadConfig?: () => Promise<DocketConfig>;
  } = {},
): RepoContext {
  let config = initialConfig;
  let store = new LocalFileStore(join(root, config.bundle));
  let index = new BundleIndex(store);
  let evidence = new GitEvidenceIndex(root, config.git.trailer, {
    bundlePath: config.bundle,
  });
  let published: Slot | undefined;
  let snapshot: BundleSnapshot | undefined;
  let gitKey: string | undefined;
  let markersKey: string | undefined;
  let activity: ActivityRow[] = [];
  let epoch = 0;
  let builtEpoch = -1;
  let requiredEpoch = 0;
  let pending: Promise<RepoState> | undefined;
  let writes: Promise<void> = Promise.resolve();
  let full = true;
  const paths = new Set<string>();
  const listeners = new Set<() => void>();
  let closed = false;
  let failure: { message: string; at: number } | undefined;
  let notifiedFailure: string | undefined;
  const notify = () => {
    for (const changed of listeners) {
      try {
        changed();
      } catch {
        /* Publication is already committed. */
      }
    }
  };

  const dispose = (slot: Slot) => {
    if (slot.retired && !slot.disposed && slot.readers === 0) {
      slot.disposed = true;
      slot.database.owners--;
      if (slot.database.owners === 0) slot.database.db.close();
    }
  };
  const checkOpen = () => {
    if (closed) throw new Error("Repository context is closed");
  };
  const loadConfig =
    opts.loadConfig ??
    (async () => {
      const source = await readFile(join(root, "docket.yaml"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      return source === undefined ? initialConfig : parseConfig(source);
    });
  const configure = (next: DocketConfig) => {
    if (JSON.stringify(config) === JSON.stringify(next)) return;
    if (config.bundle !== next.bundle) {
      index.close();
      store = new LocalFileStore(join(root, next.bundle));
      index = new BundleIndex(store);
      snapshot = undefined;
    }
    if (config.git.trailer !== next.git.trailer) {
      evidence.close();
      evidence = new GitEvidenceIndex(root, next.git.trailer, {
        bundlePath: next.bundle,
      });
    }
    config = next;
    full = true;
  };
  const invalidate = (changedPaths?: readonly string[]) => {
    if (closed) return;
    epoch++;
    requiredEpoch = epoch;
    failure = undefined;
    if (changedPaths === undefined) full = true;
    else for (const path of changedPaths) paths.add(path);
  };
  const build = async (): Promise<RepoState> => {
    for (;;) {
      checkOpen();
      const target = epoch;
      const loadedConfig = await loadConfig();
      checkOpen();
      configure(loadedConfig);
      const nextConfig = config;
      const currentIndex = index;
      const currentEvidence = evidence;
      const changedPaths = full ? undefined : [...paths];
      full = false;
      paths.clear();
      let next: BundleSnapshot;
      try {
        next = await currentIndex.refresh(nextConfig, { changedPaths });
      } catch (error) {
        if (target !== epoch && !closed) continue;
        throw error;
      }
      let git: Awaited<ReturnType<GitEvidenceIndex["snapshot"]>>;
      try {
        git = await currentEvidence.snapshot(next.bundle.byId);
      } catch (error) {
        if (target !== epoch && !closed) continue;
        throw error;
      }
      const markers = await scanRepoMarkers(root, nextConfig, next.bundle);
      checkOpen();
      if (
        target !== epoch ||
        currentIndex !== index ||
        currentEvidence !== evidence
      )
        continue;
      const nextGitKey = JSON.stringify(git.git);
      const nextMarkersKey = JSON.stringify(markers);
      const sameActivity =
        activity.length === git.activity.length &&
        activity.every((row, i) => {
          const next = git.activity[i];
          return (
            row === next ||
            (next &&
              row.sha === next.sha &&
              row.taskId === next.taskId &&
              row.date === next.date &&
              row.subject === next.subject)
          );
        });
      if (
        published &&
        snapshot === next &&
        gitKey === nextGitKey &&
        sameActivity &&
        markersKey === nextMarkersKey
      ) {
        builtEpoch = target;
        failure = undefined;
        if (notifiedFailure !== undefined) {
          notifiedFailure = undefined;
          notify();
        }
        return published.state;
      }
      const reusable =
        published &&
        snapshot === next &&
        markersKey === nextMarkersKey &&
        sameActivity &&
        published.state.git.checkpoint?.revision ===
          git.git.checkpoint?.revision &&
        published.state.git.historyComplete === git.git.historyComplete &&
        published.state.git.status === git.git.status;
      let database = reusable ? published?.database : undefined;
      if (!database) {
        opts.onBuild?.();
        const db = new Database(":memory:");
        try {
          buildCache(db, next.bundle, git.activity, markers);
        } catch (error) {
          db.close();
          throw error;
        }
        database = { db, owners: 0 };
      }
      database.owners++;
      const state: RepoState = {
        bundle: next.bundle,
        db: database.db,
        git: git.git,
        config: nextConfig,
        store,
        sources: next.sources,
        search: next.search,
        generation: (published?.state.generation ?? 0) + 1,
        countSince: (sha) =>
          currentEvidence.countSince(sha, git.git.checkpoint),
      };
      const previous = published;
      published = {
        state,
        database,
        readers: 0,
        retired: false,
        disposed: false,
      };
      snapshot = next;
      gitKey = nextGitKey;
      markersKey = nextMarkersKey;
      activity = git.activity;
      builtEpoch = target;
      failure = undefined;
      notifiedFailure = undefined;
      if (previous) {
        previous.retired = true;
        dispose(previous);
      }
      notify();
      return state;
    }
  };
  const ensure = async (): Promise<RepoState> => {
    checkOpen();
    if (published && builtEpoch === epoch) return published.state;
    if (!pending)
      pending = build()
        .catch((error) => {
          full = true;
          failure = {
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          };
          if (!closed && failure.message !== notifiedFailure) {
            notifiedFailure = failure.message;
            notify();
          }
          throw error;
        })
        .finally(() => {
          pending = undefined;
        });
    await pending;
    checkOpen();
    return builtEpoch === epoch && published ? published.state : ensure();
  };
  return {
    root,
    telemetryDimensions: () => ({
      indexState: published ? "search" : "uninitialized",
      concepts: published?.state.bundle.concepts.length ?? null,
      generation: published?.state.generation ?? null,
    }),
    get config() {
      return config;
    },
    get store() {
      return store;
    },
    async state() {
      if (opts.ttlMs === 0 && !pending) {
        invalidate();
        evidence.invalidate();
      }
      return ensure();
    },
    async acquire() {
      checkOpen();
      if (opts.ttlMs === 0 && !pending) {
        invalidate();
        evidence.invalidate();
      }
      try {
        if (
          (!published || builtEpoch < requiredEpoch) &&
          (!failure || !published || Date.now() - failure.at >= 500)
        )
          await ensure();
      } catch (error) {
        if (!published) throw error;
      }
      checkOpen();
      const slot = published;
      if (!slot) throw new Error("Repository has no published snapshot");
      slot.readers++;
      let released = false;
      return {
        state: slot.state,
        ...(failure ? { error: failure.message } : {}),
        release() {
          if (released) return;
          released = true;
          slot.readers--;
          dispose(slot);
        },
      };
    },
    invalidate,
    invalidateGit() {
      evidence.invalidate();
      invalidate([]);
    },
    async refresh(options) {
      if (options?.background) {
        epoch++;
        full = true;
      } else invalidate();
      return ensure();
    },
    subscribe(changed) {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
    mutate(write) {
      const next = writes.then(async () => {
        checkOpen();
        const latest = await loadConfig();
        checkOpen();
        if (JSON.stringify(config) !== JSON.stringify(latest)) {
          invalidate();
          configure(latest);
        }
        try {
          return await write(store, config);
        } finally {
          invalidate();
          void ensure().catch(() => {});
        }
      });
      writes = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    countSince(sha, checkpoint) {
      return evidence.countSince(sha, checkpoint);
    },
    close() {
      if (closed) return;
      closed = true;
      index.close();
      evidence.close();
      listeners.clear();
      if (published) {
        published.retired = true;
        dispose(published);
        published = undefined;
      }
      snapshot = undefined;
      activity = [];
    },
  };
}
