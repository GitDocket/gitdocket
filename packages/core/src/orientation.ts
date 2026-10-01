// Repository orientation is one bounded, read-only derivation shared by the
// CLI and MCP. It intentionally reads only the bundle, the optional committed
// product checkpoint, and task-linked Git activity; it never writes cache or
// bundle state.

import { Database } from "bun:sqlite";
import { type AgentOverview, projectAgentOverview } from "./agent-overview";
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
import { overviewDrift } from "./task-drift";
import { previewTaskProgress, withTaskProgress } from "./task-progress-view";

export type RepositoryOverview = OverviewModel & {
  narrative?: StateOfPlayView;
  git: GitEvidence;
  coordination: ReturnType<typeof overviewDrift>;
};
export type RepositoryBriefing = AgentOverview & {
  contextProblem: "missing" | "malformed" | "unavailable" | null;
};

export interface RepositoryOverviewInput {
  /** Core callers retain the full default; agent clients explicitly request brief. */
  view?: "brief" | "full";
  bundle: Bundle;
  config: DocketConfig;
  store: FileStore;
  /** Omit outside a Git-backed repository; the derived task selection remains valid. */
  root?: string;
  /** Borrowed process owner. The caller retains responsibility for closing it. */
  evidence?: GitEvidenceIndex;
}

export function deriveRepositoryOverview(
  input: RepositoryOverviewInput & { view: "brief" },
): Promise<RepositoryBriefing>;
export function deriveRepositoryOverview(
  input: RepositoryOverviewInput & { view?: "full" },
): Promise<RepositoryOverview>;
export function deriveRepositoryOverview(
  input: RepositoryOverviewInput,
): Promise<RepositoryOverview | RepositoryBriefing>;
export async function deriveRepositoryOverview({
  bundle,
  config,
  store,
  root,
  evidence: borrowedEvidence,
  view = "full",
}: RepositoryOverviewInput): Promise<RepositoryOverview | RepositoryBriefing> {
  const db = new Database(":memory:");
  const evidence =
    borrowedEvidence ??
    (root
      ? new GitEvidenceIndex(root, config.git.trailer, {
          bundlePath: config.bundle,
        })
      : undefined);
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
    let contextProblem: "missing" | "malformed" | "unavailable" | null = null;
    const source = await store
      .read(STATE_OF_PLAY_PATH)
      .catch(async (error: unknown) => {
        contextProblem =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unavailable";
        if (!(error as NodeJS.ErrnoException).code) {
          const paths = await store.list().catch(() => undefined);
          if (paths && !paths.includes(STATE_OF_PLAY_PATH))
            contextProblem = "missing";
        }
        return undefined;
      });
    const note = source ? parseStateOfPlay(source).note : undefined;
    if (source !== undefined && !note) contextProblem = "malformed";
    const model = deriveOverview(bundle, db, {
      agentCandidates: view === "brief",
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
    const coordination = overviewDrift(git.taskProgress);
    if (git.taskProgress)
      git.taskProgress = previewTaskProgress(git.taskProgress);
    const narrative = note
      ? presentStateOfPlay(
          note,
          await evidence?.countSince(note.asOf, git.checkpoint),
        )
      : undefined;
    const viewModel = {
      ...model,
      ...(model.upNext
        ? { upNext: withTaskProgress(model.upNext, git.taskProgress) }
        : {}),
      git,
      coordination,
    };
    if (view === "brief")
      return {
        ...projectAgentOverview(viewModel, git, narrative),
        coordination,
        contextProblem,
      };
    return narrative ? { narrative, ...viewModel } : viewModel;
  } finally {
    if (!borrowedEvidence) evidence?.close();
    db.close();
  }
}
