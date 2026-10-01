/** Explicit compact write contract; complete authored reads keep their own API. */
import { DocumentEditError } from "./document-edit";
import { TaskEditError } from "./ops";
import { ReconcileError } from "./reconcile";

export const RECEIPT_SCHEMA = "docket-receipt/v1";
export const RECEIPT_MAX_BYTES = 8192;
export const COMPACT_WRITE_OPERATIONS = [
  "task_create",
  "decision_create",
  "document_create",
  "document_edit",
  "task_edit",
  "set_status",
  "task_close",
  "task_stop",
  "append_log",
  "index",
] as const;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const versionText = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
const compactDrift = (value: unknown) => {
  const drift = record(value);
  if (drift.schema !== "task-drift/v1") return undefined;
  // With no admitted foreign source, retain coverage/warnings. The enclosing
  // write already identifies its source; null identities and read hints add no evidence.
  if (
    Array.isArray(drift.sources) &&
    !drift.sources.length &&
    drift.omittedSources === 0 &&
    !drift.pickupSources &&
    !drift.omittedPickupSources
  )
    return {
      schema: drift.schema,
      authority: drift.authority,
      observedAt: drift.observedAt,
      complete: drift.complete,
      warnings: drift.warnings,
    };
  return value;
};

export function errorReceipt(
  operation: string,
  error: unknown,
  argumentError = false,
) {
  const detail = record(error);
  const typed =
    error instanceof TaskEditError ||
    error instanceof DocumentEditError ||
    error instanceof ReconcileError;
  const code = argumentError
    ? "invalid-arguments"
    : typed
      ? error.code
      : "operation-failed";
  const mutation = argumentError
    ? "unchanged"
    : error instanceof TaskEditError
      ? error.mutation
      : error instanceof DocumentEditError || error instanceof ReconcileError
        ? "unchanged"
        : "unknown";
  const message =
    error instanceof Error
      ? error.message
      : (text(detail.message) ?? "Operation failed.");
  return {
    schema: RECEIPT_SCHEMA,
    operation: operation.slice(0, 64),
    ok: false,
    error: {
      code,
      message: message.slice(0, 512),
      messageOmitted: message.length > 512,
    },
    mutation,
    ...(error instanceof TaskEditError && versionText(error.version)
      ? { version: error.version }
      : {}),
    recovery:
      mutation === "unchanged"
        ? "Correct the request or reconcile the current source before retrying."
        : "Inspect current source and state before retrying; no rollback or unchanged state is claimed.",
  };
}

export function compactWriteReceipt(
  operation: string,
  value: unknown,
  checkout?: object,
) {
  const data = record(value);
  const document = record(data.document);
  const path =
    text(data.path) ??
    text(document.path) ??
    (operation === "index" ? "index.md" : undefined);
  const paths = Array.isArray(data.paths)
    ? data.paths.filter((p): p is string => typeof p === "string")
    : path
      ? [path]
      : [];
  const version = versionText(data.version) ?? versionText(document.version);
  const changed = typeof data.changed === "boolean" ? data.changed : true;
  const mutation = ["unchanged", "applied", "partial", "unknown"].includes(
    String(data.mutation),
  )
    ? String(data.mutation)
    : changed
      ? "applied"
      : "unchanged";
  const receipt = {
    schema: RECEIPT_SCHEMA,
    operation: operation.slice(0, 64),
    ok: data.ok !== false,
    ...(checkout ? { checkout } : {}),
    ...(compactDrift(data.drift) ? { drift: compactDrift(data.drift) } : {}),
    ...(data.instructions
      ? {
          instructions:
            record(data.instructions).status === "absent"
              ? { status: "absent" }
              : data.instructions,
        }
      : {}),
    changed,
    mutation,
    ...(text(data.id) ? { id: data.id } : {}),
    ...(path ? { path } : {}),
    paths,
    ...(version ? { version } : {}),
    ...(data.from !== undefined ? { from: data.from } : {}),
    ...(data.to !== undefined ? { to: data.to } : {}),
    ...(operation === "task_edit"
      ? {
          fields: Object.fromEntries(
            ["priority", "rank", "epic"]
              .filter((key) => key in data)
              .map((key) => [key, data[key]]),
          ),
        }
      : {}),
    ...(operation === "index"
      ? {
          indexChanged: data.indexChanged ?? data.changed,
          cache: data.cache ?? "unsupported",
          verifyMarkerCount: data.verifyMarkerCount ?? null,
          ...(data.refresh ? { refresh: data.refresh } : {}),
        }
      : {}),
    ...(operation === "task_stop"
      ? {
          activeTaskId: data.activeTaskId ?? null,
          statusChanged: false,
          ...(data.cleanup ? { cleanup: data.cleanup } : {}),
          ...(data.error ? { error: data.error } : {}),
        }
      : {}),
    ...(operation === "task_close" && data.closure
      ? { closure: data.closure }
      : {}),
    discovery: {
      index:
        operation === "index"
          ? (data.indexChanged ?? changed)
            ? "refreshed"
            : "unchanged"
          : changed
            ? "pending-batch-assessment"
            : "not-required-by-this-operation",
      bundleLog: "not-written",
      parentEpic: "not-written",
    },
    remaining: Array.isArray(data.remaining)
      ? data.remaining
      : operation === "task_close"
        ? [
            "refresh discovery and validate final narrative, documentation, state and log changes",
            "commit the validated closure with its task trailer",
            "run the returned matching cleanup after commit",
          ]
        : changed &&
            (operation === "document_edit" ||
              operation === "document_create" ||
              operation === "task_create" ||
              operation === "decision_create")
          ? [
              "refresh required discovery after the source batch",
              "validate final bundle changes",
            ]
          : [],
    detail: path
      ? {
          operation: operation === "index" ? "source_page" : "document_read",
          path,
        }
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(receipt, null, 2)) <= RECEIPT_MAX_BYTES)
    return receipt;
  // An exceptional oversized identity is explicit, never a silently truncated
  // usable source pointer or a recommendation to repeat the mutation.
  return {
    schema: RECEIPT_SCHEMA,
    operation: operation.slice(0, 64),
    ok: data.ok !== false,
    changed,
    mutation,
    ...(version ? { version } : {}),
    paths: [],
    omittedPaths: paths.length,
    ...(checkout ? { checkout } : {}),
    error: {
      code: "receipt-details-required",
      message:
        "Source metadata exceeds the compact receipt budget; inspect the complete read view before continuing. Do not repeat this write to retrieve its result.",
    },
    detail: {
      operation: operation === "index" ? "source_page" : "document_read",
      useOriginalRequestTarget: true,
    },
    remaining: ["inspect complete source metadata"],
  };
}
