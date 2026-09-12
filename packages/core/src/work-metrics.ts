import { AsyncLocalStorage } from "node:async_hooks";
// Optional, process-local benchmark observer. No recording, persistence, or
// telemetry occurs unless a caller explicitly installs an observer.
export type WorkMetric =
  | "parse"
  | "readyRow"
  | "dependencyEdge"
  | "searchDocument";
let observer: ((metric: WorkMetric, count: number) => void) | undefined;

export function observeWork(next: typeof observer): () => void {
  const previous = observer;
  observer = next;
  return () => {
    observer = previous;
  };
}

export function recordWork(metric: WorkMetric, count = 1): void {
  observer?.(metric, count);
  const counts = workCounts.getStore();
  if (counts) counts[metric] += count;
}

/** Async-local counters isolate overlapping surface requests; shared in-flight
 * work belongs to its initiating request, never duplicated across waiters. */
export type WorkCounts = Record<WorkMetric, number>;
export const workCounts = new AsyncLocalStorage<WorkCounts>();
export function newWorkCounts(): WorkCounts {
  return { parse: 0, readyRow: 0, dependencyEdge: 0, searchDocument: 0 };
}
