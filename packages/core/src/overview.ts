// Shared Home/CLI overview derivation. This module is Bun-only
// because it reads the disposable sqlite cache; the main core entry remains
// runtime-portable.

import type { Database } from "bun:sqlite";
import { type Bundle, readyWorkItems } from "./bundle";
import { resolveLink } from "./lint";
import type { Decision, WorkItem } from "./parse";
import {
  byManualOrder,
  type DecisionStatus,
  isTerminalStatus,
  type Priority,
  type Status,
} from "./states";

/** A fortnight keeps recently-moving work visible without turning Home into history. */
export const OVERVIEW_ACTIVITY_WINDOW_DAYS = 14;
/** Two next picks keep each workstream scannable; the full queue stays in Tasks. */
export const OVERVIEW_NEXT_LIMIT = 2;
/** Idle workstreams only enter through ready work when they are near the global front. */
export const OVERVIEW_READY_HEAD_LIMIT = 10;
/** Outcome-shaped execution groups remain brief; complete inventories stay elsewhere. */
export const OVERVIEW_EXECUTION_GROUP_LIMIT = 5;
/** Summaries stay scannable; concept links retain the complete authored text. */
export const OVERVIEW_SUMMARY_MAX_LENGTH = 360;

export interface OverviewTask {
  path: string;
  id: string;
  title: string | null;
  status: Status;
  priority: Priority;
  rank: number | null;
}

export interface OverviewEpic {
  path: string;
  id: string;
  title: string | null;
  status: Status;
  priority: Priority;
}

export interface OverviewProgress {
  done: number;
  total: number;
}

/**
 * True when child-task completion and the epic's own lifecycle disagree.
 * This is a prompt for human reconciliation, never authority to close an epic.
 */
export const epicNeedsCleanup = (
  status: string | null,
  progress: OverviewProgress,
): boolean =>
  !isTerminalStatus(status ?? "") &&
  progress.total > 0 &&
  progress.done === progress.total;

export interface OverviewGroup {
  now: OverviewTask[];
  next: OverviewTask[];
  /** Full ready count before the display cap, for a truthful “N more” link. */
  nextTotal: number;
  blockedOnly: boolean;
  lastActivity: string | null;
}

export interface OverviewWorkstream extends OverviewGroup {
  epic: OverviewEpic;
  progress: OverviewProgress;
  needsCleanup: boolean;
}

export interface OverviewWorkstreams {
  /** Admitted streams with work in progress, ready work, or blocked open work. */
  current: OverviewWorkstream[];
  /** Streams admitted only by the recent-activity window. */
  recentOnly: OverviewWorkstream[];
}

export interface OverviewModel {
  upNext: OverviewTask | null;
  workstreams: OverviewWorkstreams;
  loose: OverviewGroup | null;
  execution: OverviewExecutionSummary;
}

export interface OverviewCheckpoint {
  /** Git revision served to the reader, null when Git history is unavailable. */
  revision: string | null;
  /** Revision time, or the newest canonical task/decision movement as fallback. */
  time: string | null;
}

export type OverviewDeltaMode = "shared-recent" | "history-unavailable";

export interface OverviewDeltaScope {
  mode: OverviewDeltaMode;
  after: string | null;
  requested: null;
  fallback: "first-visit" | "history-unavailable";
}

export interface OverviewConceptRef {
  path: string;
  id: string;
  title: string | null;
}

export interface OverviewExecutionItem extends OverviewConceptRef {
  status: Status;
  /** Authored outcome/description when available, otherwise the concept title. */
  summary: string;
  occurredAt: string | null;
  supportingConcepts: OverviewConceptRef[];
}

export type OverviewAttentionReason = "blocked" | "stale" | "needs-cleanup";

export interface OverviewAttentionItem extends OverviewExecutionItem {
  reason: OverviewAttentionReason;
}

export type OverviewChangeKind =
  | "queued"
  | "started"
  | "in-review"
  | "blocked"
  | "completed"
  | "closed"
  | "needs-cleanup";

export interface OverviewMaterialChange extends OverviewExecutionItem {
  change: OverviewChangeKind;
}

export interface OverviewDecision {
  path: string;
  id: string;
  title: string | null;
  status: DecisionStatus;
  choice: string;
  rationale: string | null;
  consequence: string | null;
  occurredAt: string | null;
  curated: boolean;
}

export interface OverviewExecutionSummary {
  checkpoint: OverviewCheckpoint;
  scope: OverviewDeltaScope;
  shipped: OverviewExecutionItem[];
  inFlight: OverviewExecutionItem[];
  upNext: OverviewExecutionItem[];
  needsAttention: OverviewAttentionItem[];
  changes: OverviewMaterialChange[];
  decisions: OverviewDecision[];
}

export interface OverviewOptions {
  /** Injectable wall clock for deterministic activity-window tests. */
  now?: Date;
  /** Current repository checkpoint supplied by the Git-aware caller. */
  checkpoint?: Partial<OverviewCheckpoint>;
  /** Whether the caller could inspect Git, distinct from a valid empty history. */
  historyAvailable?: boolean;
  /** Explicit decision links curated by the authored product checkpoint. */
  decisionLinks?: string[];
}

interface ActivityDateRow {
  taskId: string;
  sha: string;
  date: string;
}

const taskRef = (task: WorkItem): OverviewTask => ({
  path: task.path,
  id: task.fm.id,
  title: task.fm.title ?? null,
  status: task.fm.status,
  priority: task.fm.priority,
  rank: task.fm.rank ?? null,
});

const epicRef = (epic: WorkItem): OverviewEpic => ({
  path: epic.path,
  id: epic.fm.id,
  title: epic.fm.title ?? null,
  status: epic.fm.status,
  priority: epic.fm.priority,
});

const newest = (dates: Iterable<string | undefined>): string | null => {
  let result = "";
  for (const date of dates) {
    if (date && date > result) result = date;
  }
  return result || null;
};

const transitionDate = (item: WorkItem): string | undefined =>
  typeof item.fm.timestamp === "string" ? item.fm.timestamp : undefined;

const conceptTimestamp = (item: WorkItem | Decision): string | undefined =>
  typeof item.fm.timestamp === "string" ? item.fm.timestamp : undefined;

const plainSummary = (markdown: string | undefined): string | undefined => {
  const paragraph = markdown
    ?.split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!paragraph) return undefined;
  const text = paragraph
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`>#]/g, "")
    .replace(/^[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= OVERVIEW_SUMMARY_MAX_LENGTH) return text;
  const clipped = text.slice(0, OVERVIEW_SUMMARY_MAX_LENGTH - 1);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > 240 ? boundary : clipped.length).trim()}…`;
};

const movementDate = (
  item: WorkItem,
  activityByTask: ReadonlyMap<string, ActivityDateRow[]>,
): string | null =>
  newest([
    transitionDate(item),
    ...(activityByTask.get(item.fm.id) ?? []).map((row) => row.date),
  ]);

const inScope = (date: string | null, after: number): boolean =>
  date !== null &&
  Number.isFinite(Date.parse(date)) &&
  Date.parse(date) > after;

const ref = (item: WorkItem | Decision): OverviewConceptRef => ({
  path: item.path,
  id: item.fm.id,
  title: item.fm.title ?? null,
});

function deriveDeltaScope(
  cutoff: number,
  hasCanonicalHistory: boolean,
): OverviewDeltaScope {
  return hasCanonicalHistory
    ? {
        mode: "shared-recent",
        after: new Date(cutoff).toISOString(),
        requested: null,
        fallback: "first-visit",
      }
    : {
        mode: "history-unavailable",
        after: null,
        requested: null,
        fallback: "history-unavailable",
      };
}

/**
 * Derive the complete overview model once. Callers render this value as-is;
 * selection and ordering do not belong in the CLI, API, or browser.
 */
export function deriveOverview(
  bundle: Bundle,
  db: Database,
  options: OverviewOptions = {},
): OverviewModel {
  const now = options.now ?? new Date();
  const cutoff =
    now.getTime() - OVERVIEW_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const tasks = bundle.workItems.filter((item) => item.fm.type === "Task");
  const epics = bundle.workItems.filter((item) => item.fm.type === "Epic");
  const epicByPath = new Map(epics.map((epic) => [epic.path, epic]));

  const epicPathFor = (task: WorkItem): string | undefined => {
    if (typeof task.fm.epic !== "string") return undefined;
    const path = resolveLink(task.path, task.fm.epic);
    return path && epicByPath.has(path) ? path : undefined;
  };

  const tasksByEpic = new Map<string, WorkItem[]>();
  const looseTasks: WorkItem[] = [];
  for (const task of tasks) {
    const path = epicPathFor(task);
    if (!path) {
      looseTasks.push(task);
      continue;
    }
    const children = tasksByEpic.get(path) ?? [];
    children.push(task);
    tasksByEpic.set(path, children);
  }

  const activityRows = db
    .query("SELECT task_id AS taskId, sha, date FROM activity")
    .all() as ActivityDateRow[];
  const activityByTask = new Map<string, ActivityDateRow[]>();
  for (const row of activityRows) {
    const rows = activityByTask.get(row.taskId) ?? [];
    rows.push(row);
    activityByTask.set(row.taskId, rows);
  }

  const ready = readyWorkItems(bundle);
  const readyPosition = new Map(
    ready.map((task, index) => [task.fm.id, index] as const),
  );
  const nearHead = new Set(
    ready.slice(0, OVERVIEW_READY_HEAD_LIMIT).map((task) => task.fm.id),
  );

  const groupFor = (members: WorkItem[]): OverviewGroup => {
    const nowTasks = members
      .filter((task) => task.fm.status === "in-progress")
      .sort((a, z) => byManualOrder(a.fm, z.fm));
    const readyMembers = ready.filter((task) => members.includes(task));
    const nextTasks = readyMembers.slice(0, OVERVIEW_NEXT_LIMIT);
    const dates = members.flatMap((task) => [
      transitionDate(task),
      ...(activityByTask.get(task.fm.id) ?? []).map((row) => row.date),
    ]);
    return {
      now: nowTasks.map(taskRef),
      next: nextTasks.map(taskRef),
      nextTotal: readyMembers.length,
      blockedOnly:
        nowTasks.length === 0 &&
        nextTasks.length === 0 &&
        members.some((task) => task.fm.status === "blocked"),
      lastActivity: newest(dates),
    };
  };

  const workstreams = epics.flatMap((epic): OverviewWorkstream[] => {
    const members = tasksByEpic.get(epic.path) ?? [];
    const group = groupFor(members);
    const progress = {
      done: members.filter((task) => task.fm.status === "done").length,
      total: members.length,
    };
    const hasRecentCommit = members.some((task) =>
      (activityByTask.get(task.fm.id) ?? []).some(
        (row) => Date.parse(row.date) >= cutoff,
      ),
    );
    const hasNearHeadReady = members.some((task) => nearHead.has(task.fm.id));
    if (group.now.length === 0 && !hasRecentCommit && !hasNearHeadReady)
      return [];
    return [
      {
        epic: epicRef(epic),
        progress,
        needsCleanup: epicNeedsCleanup(epic.fm.status, progress),
        ...group,
        lastActivity: newest([
          transitionDate(epic),
          group.lastActivity ?? undefined,
        ]),
      },
    ];
  });

  workstreams.sort((a, z) => {
    const activity = (z.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
    if (activity !== 0) return activity;
    const nextPosition = (stream: OverviewWorkstream): number =>
      Math.min(
        ...stream.next.map(
          (task) => readyPosition.get(task.id) ?? Number.POSITIVE_INFINITY,
        ),
      );
    const readyOrder = nextPosition(a) - nextPosition(z);
    return Number.isNaN(readyOrder) || readyOrder === 0
      ? a.epic.id.localeCompare(z.epic.id)
      : readyOrder;
  });

  // Admission above stays governed by the established activity and ready-head
  // thresholds. Classification happens once, after ordering, so every surface
  // receives the same mutually-exclusive current/recent-only groups.
  const isCurrent = (stream: OverviewWorkstream): boolean =>
    stream.now.length > 0 || stream.nextTotal > 0 || stream.blockedOnly;
  const current = workstreams.filter(isCurrent);
  const recentOnly = workstreams.filter((stream) => !isCurrent(stream));

  const looseGroup = groupFor(looseTasks);
  const looseHasRecentCommit = looseTasks.some((task) =>
    (activityByTask.get(task.fm.id) ?? []).some(
      (row) => Date.parse(row.date) >= cutoff,
    ),
  );
  const loose =
    looseGroup.now.length > 0 ||
    looseGroup.next.length > 0 ||
    looseHasRecentCommit
      ? looseGroup
      : null;

  const movementDates = [
    ...tasks.map((task) => movementDate(task, activityByTask)),
    ...epics.map((item) => conceptTimestamp(item) ?? null),
    ...bundle.decisions.map((item) => conceptTimestamp(item) ?? null),
  ].filter((date): date is string => Boolean(date));
  const checkpoint: OverviewCheckpoint = {
    revision: options.checkpoint?.revision ?? null,
    time: newest([options.checkpoint?.time ?? undefined, ...movementDates]),
  };
  const hasCanonicalHistory =
    movementDates.length > 0 || options.historyAvailable === true;
  const scope = deriveDeltaScope(cutoff, hasCanonicalHistory);
  const scopeAfter = scope.after ? Date.parse(scope.after) : Number.NaN;

  const taskEpic = (task: WorkItem): WorkItem | undefined => {
    const path = epicPathFor(task);
    return path ? epicByPath.get(path) : undefined;
  };
  const executionItem = (item: WorkItem): OverviewExecutionItem => {
    const parent = item.fm.type === "Task" ? taskEpic(item) : undefined;
    const authored =
      item.fm.type === "Task" && item.fm.status === "done"
        ? plainSummary(item.outcome)
        : undefined;
    const summary =
      authored ??
      plainSummary(
        typeof item.fm.description === "string"
          ? item.fm.description
          : undefined,
      ) ??
      item.fm.title ??
      item.fm.id;
    return {
      ...ref(item),
      status: item.fm.status,
      summary,
      occurredAt:
        item.fm.type === "Task"
          ? movementDate(item, activityByTask)
          : (conceptTimestamp(item) ?? null),
      supportingConcepts: parent ? [ref(parent)] : [],
    };
  };
  const newestFirst = <T extends { occurredAt: string | null; id: string }>(
    items: T[],
  ): T[] =>
    items.sort(
      (a, z) =>
        (z.occurredAt ?? "").localeCompare(a.occurredAt ?? "") ||
        a.id.localeCompare(z.id, undefined, { numeric: true }),
    );
  const bounded = <T>(items: T[]): T[] =>
    items.slice(0, OVERVIEW_EXECUTION_GROUP_LIMIT);
  const movedInScope = (item: WorkItem): boolean =>
    Number.isFinite(scopeAfter) &&
    inScope(
      item.fm.type === "Task"
        ? movementDate(item, activityByTask)
        : (conceptTimestamp(item) ?? null),
      scopeAfter,
    );

  const shippedCandidates = tasks.filter((task) => task.fm.status === "done");
  const shipped = bounded(
    newestFirst(
      (Number.isFinite(scopeAfter)
        ? shippedCandidates.filter(movedInScope)
        : shippedCandidates
      ).map(executionItem),
    ),
  );

  const inFlight = bounded(
    newestFirst(
      tasks
        .filter(
          (task) =>
            task.fm.status === "in-progress" || task.fm.status === "in-review",
        )
        .map(executionItem),
    ),
  );

  const executionUpNext = bounded(ready.map(executionItem));
  const cleanupEpics = epics.filter((epic) => {
    const members = tasksByEpic.get(epic.path) ?? [];
    return epicNeedsCleanup(epic.fm.status, {
      done: members.filter((task) => task.fm.status === "done").length,
      total: members.length,
    });
  });
  const needsAttention: OverviewAttentionItem[] = [
    ...tasks
      .filter((task) => task.fm.status === "blocked")
      .map((task) => ({ ...executionItem(task), reason: "blocked" as const })),
    ...tasks
      .filter(
        (task) =>
          (task.fm.status === "in-progress" ||
            task.fm.status === "in-review") &&
          !inScope(movementDate(task, activityByTask), cutoff),
      )
      .map((task) => ({ ...executionItem(task), reason: "stale" as const })),
    ...cleanupEpics.map((epic) => ({
      ...executionItem(epic),
      reason: "needs-cleanup" as const,
    })),
  ];

  const changeFor = (item: WorkItem): OverviewChangeKind => {
    if (item.fm.type === "Epic") return "needs-cleanup";
    if (item.fm.status === "done") return "completed";
    if (item.fm.status === "closed") return "closed";
    if (item.fm.status === "in-progress") return "started";
    if (item.fm.status === "in-review") return "in-review";
    if (item.fm.status === "blocked") return "blocked";
    return "queued";
  };
  const changes = Number.isFinite(scopeAfter)
    ? bounded(
        newestFirst(
          [
            ...tasks.filter(movedInScope),
            ...cleanupEpics.filter(movedInScope),
          ].map((item) => ({
            ...executionItem(item),
            change: changeFor(item),
          })),
        ),
      )
    : [];

  const curatedPaths = new Set(
    (options.decisionLinks ?? []).map((path) => path.replace(/^\//, "")),
  );
  const decisions = bounded(
    bundle.decisions
      .filter((decision) => {
        const curated = curatedPaths.has(decision.path);
        return (
          curated ||
          (Number.isFinite(scopeAfter) &&
            inScope(conceptTimestamp(decision) ?? null, scopeAfter))
        );
      })
      .map(
        (decision): OverviewDecision => ({
          ...ref(decision),
          status: decision.fm.status,
          choice:
            plainSummary(decision.decision) ??
            plainSummary(decision.fm.description) ??
            decision.fm.title ??
            decision.fm.id,
          rationale: plainSummary(decision.context) ?? null,
          consequence: plainSummary(decision.consequences) ?? null,
          occurredAt: conceptTimestamp(decision) ?? null,
          curated: curatedPaths.has(decision.path),
        }),
      )
      .sort(
        (a, z) =>
          Number(z.curated) - Number(a.curated) ||
          (z.occurredAt ?? "").localeCompare(a.occurredAt ?? "") ||
          a.id.localeCompare(z.id, undefined, { numeric: true }),
      ),
  );

  return {
    upNext: ready[0] ? taskRef(ready[0]) : null,
    workstreams: { current, recentOnly },
    loose,
    execution: {
      checkpoint,
      scope,
      shipped,
      inFlight,
      upNext: executionUpNext,
      needsAttention: bounded(newestFirst(needsAttention)),
      changes,
      decisions,
    },
  };
}
