import type { GitEvidence } from "./cache";
import type {
  OverviewModel,
  OverviewTask,
  OverviewWorkstream,
} from "./overview";
import type { StateOfPlayView } from "./state-of-play";
import { overviewDrift } from "./task-drift";

export const AGENT_OVERVIEW_LIMITS = {
  encodedBytes: 16384,
  workstreams: 5,
  active: 3,
  next: 2,
  recent: 3,
  attention: 5,
  git: 3,
  title: 160,
  summary: 240,
  context: 1200,
} as const;

export interface OverviewSelection<T> {
  items: T[];
  total: number;
  omitted: number;
}

const excerpt = (text: string, max: number) => ({
  text: text.length > max ? `${text.slice(0, max - 1)}…` : text,
  truncated: text.length > max,
});
const title = (value: string | null) =>
  value === null ? null : excerpt(value, AGENT_OVERVIEW_LIMITS.title).text;

/** Reserve one representative of each available category before filling by canonical order. */
function representatives<T>(
  items: readonly T[],
  categories: ((item: T) => boolean)[],
): T[] {
  const selected = new Set<T>();
  for (const matches of categories) {
    const first = items.find(matches);
    if (first) selected.add(first);
  }
  for (const item of items) selected.add(item);
  return [...selected];
}

function select<T, R>(
  items: readonly T[],
  limit: number,
  project: (item: T) => R,
): OverviewSelection<R> {
  const chosen = items.slice(0, limit);
  return {
    items: chosen.map(project),
    total: items.length,
    omitted: items.length - chosen.length,
  };
}
const task = (item: OverviewTask) => ({
  path: item.path,
  id: item.id,
  title: title(item.title),
  status: item.status,
  priority: item.priority,
  rank: item.rank,
  ...(item.currentState
    ? {
        currentState: excerpt(item.currentState, AGENT_OVERVIEW_LIMITS.summary),
        sourceVersion: item.sourceVersion,
      }
    : {}),
});
const active = (items: OverviewTask[]) =>
  select(
    representatives(items, [
      (item) => item.status === "in-review",
      (item) => item.status === "in-progress",
    ]),
    AGENT_OVERVIEW_LIMITS.active,
    task,
  );
const group = (value: OverviewModel["loose"] & {}) => ({
  active: active(value.now),
  next: {
    items: value.next.slice(0, AGENT_OVERVIEW_LIMITS.next).map(task),
    total: value.nextTotal,
    omitted:
      value.nextTotal - Math.min(value.next.length, AGENT_OVERVIEW_LIMITS.next),
  },
  blockedOnly: value.blockedOnly,
});
const stream = (value: OverviewWorkstream) => ({
  epic: {
    ...value.epic,
    title: title(value.epic.title),
    ...(value.epic.currentState
      ? {
          currentState: excerpt(
            value.epic.currentState,
            AGENT_OVERVIEW_LIMITS.summary,
          ),
        }
      : {}),
  },
  progress: value.progress,
  needsCleanup: value.needsCleanup,
  ...group(value),
});

/** Select from live candidates, before full-view execution caps. Does not author or refresh context. */
export function projectAgentOverview(
  model: OverviewModel,
  git: GitEvidence,
  narrative?: StateOfPlayView,
) {
  const streams = representatives(model.workstreams.current, [
    (item) => item.next.some((next) => next.id === model.upNext?.id),
    (item) => item.now.some((now) => now.status === "in-review"),
    (item) => item.now.some((now) => now.status === "in-progress"),
    (item) => item.blockedOnly,
  ]);
  const attention = representatives(model.execution.needsAttention, [
    (item) => item.reason === "blocked",
    (item) => item.reason === "stale",
    (item) => item.reason === "needs-cleanup",
  ]);
  const worktrees = git.worktrees.filter(
    (item) =>
      !item.current &&
      (!item.available ||
        item.dirty ||
        item.activeTaskId ||
        item.mergedIntoCurrentHead === false),
  );
  const context = narrative
    ? {
        path: "overview.md",
        asOf: narrative.asOf,
        reviewedAt: "reviewedAt" in narrative ? narrative.reviewedAt : null,
        review: narrative.review,
        taskCommitsAgo: narrative.taskCommitsAgo,
        excerpt: excerpt(narrative.body, AGENT_OVERVIEW_LIMITS.context),
      }
    : null;
  const result = {
    format: "agent-overview/v1" as const,
    budget: {
      maxBytes: AGENT_OVERVIEW_LIMITS.encodedBytes,
      omittedForBytes: 0,
      contextExcerptReduced: false,
    },
    checkpoint: model.execution.checkpoint,
    upNext: model.upNext ? task(model.upNext) : null,
    workstreams: select(streams, AGENT_OVERVIEW_LIMITS.workstreams, stream),
    loose: model.loose ? group(model.loose) : null,
    recent: select(
      model.execution.shipped,
      AGENT_OVERVIEW_LIMITS.recent,
      (item) => ({
        id: item.id,
        path: item.path,
        title: title(item.title),
        status: item.status,
        summary: excerpt(item.summary, AGENT_OVERVIEW_LIMITS.summary),
        occurredAt: item.occurredAt,
      }),
    ),
    needsAttention: select(
      attention,
      AGENT_OVERVIEW_LIMITS.attention,
      (item) => ({
        id: item.id,
        path: item.path,
        title: title(item.title),
        reason: item.reason,
        status: item.status,
        summary: excerpt(item.summary, AGENT_OVERVIEW_LIMITS.summary),
        occurredAt: item.occurredAt,
      }),
    ),
    context,
    coordination: overviewDrift(git.taskProgress),
    git: {
      status: git.status,
      historyComplete: git.historyComplete ?? false,
      truncated: git.truncated,
      reason: git.reason
        ? excerpt(git.reason, AGENT_OVERVIEW_LIMITS.summary)
        : null,
      // Counts concern admitted evidence, never an assertion of complete repository history.
      unmerged: observed(
        select(git.unmergedActivity, AGENT_OVERVIEW_LIMITS.git, (item) => ({
          taskId: item.taskId,
          sha: item.sha,
          date: item.date,
          subject: excerpt(item.subject, AGENT_OVERVIEW_LIMITS.summary),
        })),
      ),
      worktrees: observed(
        select(worktrees, AGENT_OVERVIEW_LIMITS.git, (item) => ({
          path: item.path,
          head: item.head,
          activeTaskId: item.activeTaskId,
          dirty: item.dirty,
          available: item.available,
          mergedIntoCurrentHead: item.mergedIntoCurrentHead,
        })),
      ),
    },
    details: {
      cli: "docket overview --json --full",
      mcp: { tool: "overview", arguments: { view: "full" as const } },
      context: {
        cli: "docket source overview.md --json",
        mcp: { tool: "source_page", arguments: { path: "overview.md" } },
      },
    },
  };
  // Preserve canonical next identity and complete coordination warnings. Omit
  // only selected display records, with their existing total/omitted counters.
  const selections: { items: unknown[]; omitted: number }[] = [
    result.workstreams,
    result.recent,
    result.needsAttention,
    result.git.unmerged,
    result.git.worktrees,
    ...(result.loose ? [result.loose.active, result.loose.next] : []),
  ];
  while (
    Buffer.byteLength(JSON.stringify(result, null, 2)) >
    AGENT_OVERVIEW_LIMITS.encodedBytes
  ) {
    const largest = selections
      .filter((s) => s.items.length)
      .sort(
        (a, b) =>
          Buffer.byteLength(JSON.stringify(b.items.at(-1))) -
          Buffer.byteLength(JSON.stringify(a.items.at(-1))),
      )[0];
    if (largest) {
      largest.items.pop();
      largest.omitted++;
      result.budget.omittedForBytes++;
    } else if (result.context?.excerpt.text.length) {
      result.context.excerpt.text = result.context.excerpt.text.slice(
        0,
        Math.floor(result.context.excerpt.text.length / 2),
      );
      result.context.excerpt.truncated = true;
      result.budget.contextExcerptReduced = true;
    } else
      throw new Error(
        "Overview identity/coordination exceeds the 16 KiB agent budget; use the explicit full overview view.",
      );
  }
  return result;
}
function observed<T>({ total, ...selection }: OverviewSelection<T>) {
  return { ...selection, observedTotal: total };
}
export type AgentOverview = ReturnType<typeof projectAgentOverview>;
