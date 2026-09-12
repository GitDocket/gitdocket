// Repository orientation is one bounded, read-only derivation shared by the
// CLI and MCP. It intentionally reads only the bundle, the optional committed
// product checkpoint, and task-linked Git activity; it never writes cache or
// bundle state.

import { Database } from "bun:sqlite";
import type { Bundle } from "./bundle";
import { buildCache, type GitEvidence, GitEvidenceIndex } from "./cache";
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
  git: GitEvidence;
};

export interface RepositoryOverviewInput {
  bundle: Bundle;
  config: DocketConfig;
  store: FileStore;
  /** Omit outside a Git-backed repository; the derived task selection remains valid. */
  root?: string;
  /** Borrowed process owner. The caller retains responsibility for closing it. */
  evidence?: GitEvidenceIndex;
}

export async function deriveRepositoryOverview({
  bundle,
  config,
  store,
  root,
  evidence: borrowedEvidence,
}: RepositoryOverviewInput): Promise<RepositoryOverview> {
  const db = new Database(":memory:");
  const evidence =
    borrowedEvidence ??
    (root ? new GitEvidenceIndex(root, config.git.trailer) : undefined);
  try {
    const snapshot = await evidence?.snapshot(bundle.byId);
    const git = snapshot
      ? snapshot.git
      : {
          status: "history-unavailable" as const,
          checkpoint: null,
          activity: [],
          unmergedActivity: [],
          worktrees: [],
          truncated: false,
          reason: "repository root was not provided",
        };
    buildCache(db, bundle, snapshot?.activity ?? []);
    const source = await store.read(STATE_OF_PLAY_PATH).catch(() => undefined);
    const note = source ? parseStateOfPlay(source).note : undefined;
    const model = deriveOverview(bundle, db, {
      checkpoint: git.checkpoint ?? undefined,
      historyAvailable:
        git.status === "available" && git.historyComplete !== false,
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
          await evidence?.countSince(note.asOf, git.checkpoint),
        )
      : undefined;
    return narrative ? { narrative, ...model, git } : { ...model, git };
  } finally {
    if (!borrowedEvidence) evidence?.close();
    db.close();
  }
}
