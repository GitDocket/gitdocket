/** Bounded advisory evidence. Local canonical state retains all write/readiness authority. */
import type { TaskProgress, TaskProgressEvidence } from "./task-observations";

export const TASK_DRIFT_MAX_BYTES = 3072;
export const DRIFT_MESSAGES = {
  "terminal-closeout-unmerged":
    "This open item has a terminal closeout on an unmerged branch; reconcile it.",
  "same-task-conflict":
    "Same-task source or pickup evidence conflicts; review before continuing.",
  "foreign-pickup":
    "This item is picked up in another checkout; a marker does not prove a running agent or exclusive claim.",
  "foreign-source-change":
    "Another source changed this item from its shared baseline; review relevant changes.",
  "local-reopening":
    "Local open state differs from a terminal baseline; preserve the local reopening rather than importing an inherited terminal copy.",
  "incompatible-baseline":
    "Source/baseline identity is incompatible or unavailable; do not infer integration or completion.",
  "evidence-incomplete":
    "Coordination evidence is incomplete or unavailable; absence of a warning does not prove absence of another writer.",
} as const;
export type TaskDriftCode = keyof typeof DRIFT_MESSAGES;
export function taskDriftOutcome(receipt: ReturnType<typeof taskDriftReceipt>) {
  return {
    driftState: !receipt.complete
      ? ("incomplete" as const)
      : receipt.warnings.some(
            (warning) => warning.code === "same-task-conflict",
          )
        ? ("conflict" as const)
        : receipt.warnings.length
          ? ("advisory" as const)
          : ("none" as const),
    driftWarnings: receipt.warnings.length,
  };
}
export function overviewDriftOutcome(
  receipt: ReturnType<typeof overviewDrift>,
) {
  return {
    driftState: !receipt.complete
      ? ("incomplete" as const)
      : receipt.items.some((item) =>
            item.warnings.some(
              (warning) => warning.code === "same-task-conflict",
            ),
          )
        ? ("conflict" as const)
        : receipt.observedTotal
          ? ("advisory" as const)
          : ("none" as const),
    driftWarnings: receipt.items.reduce(
      (total, item) => total + item.warnings.length,
      0,
    ),
  };
}
const terminal = (status: string | null | undefined) =>
  status === "done" || status === "closed";
export function taskDriftCodes(task: TaskProgress): TaskDriftCode[] {
  const codes = new Set<TaskDriftCode>();
  if (
    task.localStatus !== null &&
    !terminal(task.localStatus) &&
    task.observations.some(
      (o) =>
        o.committed?.task?.id === task.id &&
        o.committed.compatible &&
        !o.committed.integrated &&
        terminal(o.committed.task.status) &&
        o.baselineAvailable &&
        o.base?.id === task.id &&
        o.base.status !== o.committed.task.status &&
        !terminal(o.base.status),
    )
  )
    codes.add("terminal-closeout-unmerged");
  if (task.state === "conflict") codes.add("same-task-conflict");
  if (task.pickedUpElsewhere) codes.add("foreign-pickup");
  if (
    task.observations.some(
      (o) => !o.baselineAvailable || o.configuration?.compatible === false,
    )
  )
    codes.add("incompatible-baseline");
  if (
    task.localStatus !== null &&
    !terminal(task.localStatus) &&
    task.observations.some((o) => terminal(o.base?.status))
  )
    codes.add("local-reopening");
  if (
    !codes.has("terminal-closeout-unmerged") &&
    task.observations.some(
      (o) => o.task.version && o.task.version !== o.base?.version,
    )
  )
    codes.add("foreign-source-change");
  return [...codes];
}
const identity = (value: string | undefined | null, limit = 512) =>
  value && Buffer.byteLength(value) <= limit ? value : null;
export function taskDriftReceipt(id: string, evidence?: TaskProgressEvidence) {
  const task = evidence?.tasks.find((task) => task.id === id);
  const codes = task ? taskDriftCodes(task) : [];
  if (!evidence?.complete) codes.push("evidence-incomplete");
  const candidates = task?.observations ?? [];
  const pickupSources = (task?.pickupSources ?? [])
    .filter((path) => identity(path, 256))
    .slice(0, 2);
  let sources = candidates.slice(0, 3).map((source) => ({
    ...(identity(source.task.path)
      ? { path: source.task.path }
      : { pathOmitted: true }),
    ...(source.worktree === null
      ? {}
      : identity(source.worktree)
        ? { worktree: source.worktree }
        : { worktreeOmitted: true }),
    refs: source.refs.filter((ref) => identity(ref, 128)).slice(0, 3),
    ...(source.refs.length >
    source.refs.filter((ref) => identity(ref, 128)).slice(0, 3).length
      ? {
          omittedRefs:
            source.refs.length -
            source.refs.filter((ref) => identity(ref, 128)).slice(0, 3).length,
        }
      : {}),
    head: identity(source.head, 64),
    baselineRevision: identity(source.baselineRevision, 64),
    sourceVersion: source.task.version ?? null,
    baselineVersion: source.base?.version ?? null,
    savedStatus: source.task.status,
    active: source.active,
    uncommitted: source.uncommitted,
    compatible: source.configuration?.compatible ?? null,
    committed: source.committed
      ? {
          status: source.committed.task?.status ?? null,
          ...(source.committed.task?.version === source.task.version
            ? {}
            : { version: source.committed.task?.version ?? null }),
          integrated: source.committed.integrated,
          compatible: source.committed.compatible,
        }
      : null,
  }));
  const base = {
    schema: "task-drift/v1" as const,
    authority: "advisory" as const,
    observedAt: evidence?.observedAt ?? null,
    complete: evidence?.complete ?? false,
    local: {
      id: identity(id, 128),
      idOmitted: !identity(id, 128),
      status: task?.localStatus ?? null,
      path: identity(task?.localPath),
      version: task?.localVersion ?? null,
    },
    warnings: codes.map((code) => ({ code, message: DRIFT_MESSAGES[code] })),
    ...(task?.pickedUpElsewhere
      ? {
          pickupSources,
          omittedPickupSources:
            (task.pickupSources?.length ?? 0) - pickupSources.length,
        }
      : {}),
    detail: { cli: "docket task progress <id> --json", mcp: "task_progress" },
  };
  let receipt = {
    ...base,
    sources,
    omittedSources: candidates.length - sources.length,
  };
  while (
    sources.length &&
    Buffer.byteLength(JSON.stringify(receipt, null, 2)) > TASK_DRIFT_MAX_BYTES
  ) {
    sources = sources.slice(0, -1);
    receipt = {
      ...base,
      sources,
      omittedSources: candidates.length - sources.length,
    };
  }
  while (
    pickupSources.length &&
    Buffer.byteLength(JSON.stringify(receipt, null, 2)) > TASK_DRIFT_MAX_BYTES
  ) {
    pickupSources.pop();
    receipt.omittedPickupSources =
      (task?.pickupSources?.length ?? 0) - pickupSources.length;
  }
  return receipt;
}
export function overviewDrift(evidence?: TaskProgressEvidence) {
  const candidates = (evidence?.tasks ?? [])
    .filter((task) => taskDriftCodes(task).length)
    .sort(
      (a, b) =>
        Number(taskDriftCodes(b).includes("terminal-closeout-unmerged")) -
          Number(taskDriftCodes(a).includes("terminal-closeout-unmerged")) ||
        Number(b.state === "conflict") - Number(a.state === "conflict") ||
        a.id.localeCompare(b.id, undefined, { numeric: true }),
    );
  let items = candidates
    .slice(0, 3)
    .map((task) => taskDriftReceipt(task.id, evidence));
  const project = () => ({
    authority: "advisory" as const,
    observedAt: evidence?.observedAt ?? null,
    complete: evidence?.complete ?? false,
    items,
    observedTotal: candidates.length,
    omitted: candidates.length - items.length,
    ...(evidence?.complete
      ? {}
      : {
          warning: {
            code: "evidence-incomplete",
            message: DRIFT_MESSAGES["evidence-incomplete"],
          },
        }),
  });
  while (
    items.length &&
    Buffer.byteLength(JSON.stringify(project(), null, 2)) > 4096
  )
    items = items.slice(0, -1);
  return project();
}
