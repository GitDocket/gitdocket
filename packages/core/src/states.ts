// The task-profile state machine (docs/specs/okf-task-profile.md).

export const STATES = [
  "todo",
  "in-progress",
  "blocked",
  "in-review",
  "done",
  "closed",
] as const;
export type Status = (typeof STATES)[number];

export const TERMINAL_STATES = ["done", "closed"] as const;

export const WORK_ITEM_TYPES = ["Epic", "Task"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export const DECISION_STATES = ["proposed", "accepted", "superseded"] as const;
export type DecisionStatus = (typeof DECISION_STATES)[number];

export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];

export function isStatus(value: string): value is Status {
  return (STATES as readonly string[]).includes(value);
}

export function isTerminalStatus(value: string): value is Status {
  return (TERMINAL_STATES as readonly string[]).includes(value);
}

export function isPriority(value: string): value is Priority {
  return (PRIORITIES as readonly string[]).includes(value);
}

/**
 * Allowed transitions (normative — mirrored in the task profile spec):
 * `done` is reachable from any non-blocked state, `closed` from every
 * non-terminal state, `blocked` from every non-terminal state, and both
 * `done` and `closed` are terminal.
 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  todo: ["in-progress", "blocked", "done", "closed"],
  "in-progress": ["in-review", "done", "closed", "blocked", "todo"],
  "in-review": ["done", "closed", "in-progress", "blocked"],
  blocked: ["todo", "in-progress", "closed"],
  done: [],
  closed: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Manual order: ranked items first, lower `rank` first, priority as
 * the tiebreak and the order for the unranked tail. The ready lists (CLI and
 * MCP) sort with this so "next task" honors hand-set order.
 */
export function byManualOrder(
  a: { id?: string; rank?: number; priority?: Priority },
  z: { id?: string; rank?: number; priority?: Priority },
): number {
  const ar = typeof a.rank === "number" ? a.rank : null;
  const zr = typeof z.rank === "number" ? z.rank : null;
  if (ar !== null && zr !== null && ar !== zr) return ar - zr;
  if ((ar !== null) !== (zr !== null)) return ar !== null ? -1 : 1;
  const priority = (a.priority ?? "p2").localeCompare(z.priority ?? "p2");
  if (priority !== 0) return priority;
  return (a.id ?? "").localeCompare(z.id ?? "", undefined, { numeric: true });
}

/**
 * `ready` is derived, never written: a task is ready iff it is `todo` and
 * every dependency is `done`. Unknown dependency IDs make a task not-ready
 * (lint flags them separately).
 */
export function isReady(
  status: Status,
  dependsOn: readonly string[],
  statusById: ReadonlyMap<string, Status>,
): boolean {
  if (status !== "todo") return false;
  return dependsOn.every((id) => statusById.get(id) === "done");
}
