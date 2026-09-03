// Repository orientation is one bounded, read-only derivation shared by the
// CLI and MCP. It intentionally reads only the bundle, the optional committed
// product checkpoint, and task-linked Git activity; it never writes cache or
// bundle state.

import { Database } from "bun:sqlite";
import type { Bundle } from "./bundle";
import {
  buildCache,
  gitCheckpoint,
  scanActivity,
  taskLinkedCommitsSince,
} from "./cache";
import type { DocketConfig } from "./config";
import type { FileStore } from "./filestore";
import { deriveOverview, type OverviewModel } from "./overview";
import {
  parseStateOfPlay,
  presentStateOfPlay,
  REENTRY_CONTEXT_FORMAT,
  REENTRY_CONTEXT_V1_FORMAT,
  STATE_OF_PLAY_PATH,
  type StateOfPlayView,
} from "./state-of-play";

export type RepositoryOverview = OverviewModel & {
  narrative?: StateOfPlayView;
};

export interface RepositoryOverviewInput {
  bundle: Bundle;
  config: DocketConfig;
  store: FileStore;
  /** Omit outside a Git-backed repository; the derived task selection remains valid. */
  root?: string;
}

export async function deriveRepositoryOverview({
  bundle,
  config,
  store,
  root,
}: RepositoryOverviewInput): Promise<RepositoryOverview> {
  const db = new Database(":memory:");
  try {
    buildCache(
      db,
      bundle,
      root ? scanActivity(root, config.git.trailer, bundle.byId) : [],
    );
    const source = await store.read(STATE_OF_PLAY_PATH).catch(() => undefined);
    const note = source ? parseStateOfPlay(source).note : undefined;
    const checkpoint = root ? gitCheckpoint(root) : undefined;
    const model = deriveOverview(bundle, db, {
      checkpoint,
      historyAvailable: Boolean(checkpoint),
      decisionLinks:
        note?.format === REENTRY_CONTEXT_FORMAT
          ? note.decisionLinks
          : note?.format === REENTRY_CONTEXT_V1_FORMAT
            ? note.assessment.decisionLinks
            : undefined,
    });
    const narrative = note
      ? presentStateOfPlay(
          note,
          root
            ? taskLinkedCommitsSince(root, config.git.trailer, note.asOf)
            : undefined,
        )
      : undefined;
    return narrative ? { narrative, ...model } : model;
  } finally {
    db.close();
  }
}
