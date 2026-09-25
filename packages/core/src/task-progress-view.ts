import type { TaskProgress, TaskProgressEvidence } from "./task-observations";

export function taskProgressLabel(progress: TaskProgress): string {
  if (!progress.observations.length)
    return `${progress.state === "conflict" ? "Multiple pickups" : "Picked up elsewhere"} · task state unavailable · ${progress.pickupSources?.join(", ") ?? "unknown source"}`;
  const labels = [
    ...new Set(
      progress.observations.map((o) => {
        const state =
          o.task.status === "done" && !o.integrated
            ? "Done in branch · awaiting integration"
            : o.task.status;
        const source =
          o.refs
            .map((r) => r.replace(/^refs\/(heads|remotes)\//, ""))
            .join(", ") ||
          o.worktree ||
          o.head.slice(0, 7);
        return `${state} · ${source}${o.active ? " · picked up" : ""}${o.uncommitted ? " · uncommitted" : ""}`;
      }),
    ),
  ];
  return `${progress.state === "conflict" ? "Conflicting observations · " : ""}${labels.join("; ")}`;
}

export function withTaskProgress<T extends { id: string }>(
  item: T,
  evidence?: TaskProgressEvidence,
) {
  const progress = evidence?.tasks.find((p) => p.id === item.id);
  return {
    ...item,
    ...(progress ? { progress, progressObservedAt: evidence?.observedAt } : {}),
    ...(evidence && !evidence.complete ? { progressIncomplete: true } : {}),
  };
}

export function foreignTaskSummaries(evidence?: TaskProgressEvidence) {
  return (evidence?.tasks ?? [])
    .filter((p) => p.localStatus === null)
    .map((p) =>
      withTaskProgress(
        {
          id: p.id,
          title: p.title,
          type: "Task",
          status: null,
          path: null,
          foreignOnly: true,
        },
        evidence,
      ),
    );
}

/** Overview is a preview; dedicated task progress reads retain the bounded full scan. */
export function previewTaskProgress(
  evidence: TaskProgressEvidence,
  limit = 20,
): TaskProgressEvidence {
  const tasks = [...evidence.tasks]
    .sort(
      (a, b) =>
        Number(b.pickedUpElsewhere) - Number(a.pickedUpElsewhere) ||
        Number(b.state === "conflict") - Number(a.state === "conflict"),
    )
    .slice(0, limit);
  const truncated = tasks.length < evidence.tasks.length;
  return {
    ...evidence,
    tasks,
    observations: tasks.flatMap((t) => t.observations),
    complete: evidence.complete && !truncated,
    diagnostics: [
      ...evidence.diagnostics,
      ...(truncated
        ? [
            "Overview task progress preview omitted additional tasks; use task progress for the full bounded scan",
          ]
        : []),
    ],
  };
}
