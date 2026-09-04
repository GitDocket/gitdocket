// Live repo state for the server: bundle + in-memory sqlite cache + git
// activity, rebuilt when stale. The working tree is the database — a short
// TTL keeps requests fresh against outside edits (agents committing mid-
// session) without re-parsing on every fetch; writes invalidate immediately.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  type Bundle,
  type DocketConfig,
  LocalFileStore,
  loadBundle,
} from "@gitdocket/core";
import {
  buildCache,
  type GitEvidence,
  scanActivity,
  scanGitEvidence,
  scanRepoMarkers,
} from "@gitdocket/core/cache";

export interface RepoState {
  bundle: Bundle;
  db: Database;
  git: GitEvidence;
}

export interface RepoContext {
  root: string;
  config: DocketConfig;
  store: LocalFileStore;
  state(): Promise<RepoState>;
  invalidate(): void;
}

export function createRepoContext(
  root: string,
  config: DocketConfig,
  opts: { ttlMs?: number } = {},
): RepoContext {
  const store = new LocalFileStore(join(root, config.bundle));
  const ttl = opts.ttlMs ?? 2000;
  let cached: { state: RepoState; at: number } | undefined;

  return {
    root,
    config,
    store,
    async state() {
      if (cached && Date.now() - cached.at < ttl) return cached.state;
      cached?.state.db.close();
      const bundle = await loadBundle(store, config);
      const db = new Database(":memory:");
      const git = scanGitEvidence(root, config.git.trailer, bundle.byId);
      buildCache(
        db,
        bundle,
        scanActivity(root, config.git.trailer, bundle.byId),
        await scanRepoMarkers(root, config, bundle),
      );
      cached = { state: { bundle, db, git }, at: Date.now() };
      return cached.state;
    },
    invalidate() {
      cached?.state.db.close();
      cached = undefined;
    },
  };
}
