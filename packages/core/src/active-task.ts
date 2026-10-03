/** Checkout-local lifecycle state. Current engine pickup/stop writers cooperate
 * through one lock; external/older writers must still be detected conservatively.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock, type FileLockOptions } from "./file-lock";
import { TaskEditError } from "./ops";

export interface ActiveTaskState {
  id: string | null;
  token: string | null;
}
interface Source {
  text: string;
  identity: string;
}
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const identity = (s: Awaited<ReturnType<typeof lstat>>) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const validId = (value: string) =>
  value.length <= 128 && /^[A-Za-z0-9_][A-Za-z0-9_-]*-\d+$/.test(value);
const validToken = (value: string) =>
  value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);

async function source(path: string): Promise<Source | null> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 512)
      throw new Error("Lifecycle state must be a bounded regular file.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(513);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const text = bytes.subarray(0, bytesRead).toString("utf8");
      const after = await file.stat();
      if (identity(before) !== identity(after) || Buffer.byteLength(text) > 512)
        throw new Error("Lifecycle state changed while reading.");
      return { text, identity: identity(after) };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}
const value = (s: Source | null, valid: (s: string) => boolean) => {
  if (s === null) return null;
  const text = s.text.replace(/\r?\n$/, "");
  if (!valid(text)) throw new Error("Lifecycle state has an invalid value.");
  return text;
};

export interface ActiveTaskLease {
  state: ActiveTaskState;
  assertUnchanged(): Promise<void>;
  write(id: string, token: string): Promise<void>;
  clear(remove?: typeof unlink): Promise<string[]>;
}

export async function withActiveTaskLock<T>(
  root: string,
  operation: (lease: ActiveTaskLease) => Promise<T>,
  options: Partial<FileLockOptions> = {},
): Promise<T> {
  const directory = join(root, ".docket");
  const marker = join(directory, "active-task");
  const token = join(directory, "workflow-token");
  let entered = false;
  try {
    await mkdir(directory, { recursive: true });
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Lifecycle directory must be a real directory.");
    const lockPath = join(directory, "active-task.lock");
    const existing = await lstat(lockPath).catch((error) => {
      if (code(error) !== "ENOENT") throw error;
      return null;
    });
    if (existing && !existing.isDirectory())
      throw new Error("Lifecycle lock must be a real directory.");
    const lock = await acquireFileLock(
      lockPath,
      {
        lockTimeoutMs: 10000,
        staleLockMs: 300000,
        retryDelayMs: 25,
        ...options,
      },
      "Docket active task",
    );
    try {
      const [originalMarker, originalToken] = await Promise.all([
        source(marker),
        source(token),
      ]);
      const state = {
        id: value(originalMarker, validId),
        token: value(originalToken, validToken),
      };
      const same = (a: Source | null, b: Source | null) =>
        a?.text === b?.text && a?.identity === b?.identity;
      const assertUnchanged = async () => {
        if (
          !same(originalMarker, await source(marker)) ||
          !same(originalToken, await source(token))
        )
          throw new TaskEditError(
            "source-conflict",
            "Active task or workflow token changed; no cleanup is authorized.",
          );
      };
      entered = true;
      return await operation({
        state,
        assertUnchanged,
        write: async (id, workflow) => {
          if (!validId(id) || !validToken(workflow))
            throw new TaskEditError(
              "invalid-request",
              "Invalid lifecycle value.",
            );
          if (!state.id && state.token)
            throw new TaskEditError(
              "source-conflict",
              "An orphan workflow token must be reviewed before pickup.",
            );
          await assertUnchanged();
          try {
            // O_NOFOLLOW refuses a replacement symlink even after preflight.
            for (const [path, content] of [
              [marker, id],
              [token, workflow],
            ]) {
              const file = await open(
                path as string,
                constants.O_WRONLY |
                  constants.O_CREAT |
                  constants.O_TRUNC |
                  constants.O_NOFOLLOW,
                0o600,
              );
              try {
                await file.writeFile(`${content}\n`);
              } finally {
                await file.close();
              }
            }
          } catch {
            throw new TaskEditError(
              "write-failed",
              "Pickup lifecycle write failed; inspect current state.",
              "unknown",
            );
          }
        },
        clear: async (remove = unlink) => {
          const paths: string[] = [];
          try {
            await assertUnchanged();
            if (originalMarker) {
              await remove(marker);
              paths.push(".docket/active-task");
            }
            if (originalToken) {
              if (
                (await source(marker)) ||
                !same(originalToken, await source(token))
              )
                throw new Error("Lifecycle state changed during cleanup.");
              await remove(token);
              paths.push(".docket/workflow-token");
            }
            if ((await source(marker)) || (await source(token)))
              throw new Error("Lifecycle state reappeared during cleanup.");
            return paths;
          } catch (error) {
            let mutation = "unknown";
            try {
              const [nowMarker, nowToken] = await Promise.all([
                source(marker),
                source(token),
              ]);
              paths.length = 0;
              if (originalMarker && !nowMarker)
                paths.push(".docket/active-task");
              if (originalToken && !nowToken)
                paths.push(".docket/workflow-token");
              if (
                (!nowMarker || same(originalMarker, nowMarker)) &&
                (!nowToken || same(originalToken, nowToken))
              )
                mutation =
                  !nowMarker && !nowToken
                    ? "applied"
                    : paths.length
                      ? "partial"
                      : "unchanged";
            } catch {
              /* Readback uncertainty must remain explicit. */
            }
            throw new ActiveTaskCleanupError(paths, mutation, error);
          }
        },
      });
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (
      error instanceof TaskEditError ||
      error instanceof ActiveTaskCleanupError
    )
      throw error;
    throw new TaskEditError(
      "unavailable",
      entered
        ? "Lifecycle operation or lock release failed; inspect current state."
        : "Active-task state is unreadable, unsafe or unwritable; no cleanup was attempted.",
      entered ? "unknown" : "unchanged",
    );
  }
}

class ActiveTaskCleanupError extends Error {
  constructor(
    readonly paths: string[],
    readonly mutation: string,
    readonly cause: unknown,
  ) {
    super("Active-task cleanup failed; inspect current state before retrying.");
  }
}
export interface StopTaskOptions {
  id?: string;
  workflowToken?: string;
  /** The CLI supplies source-bound closure-commit verification here. */
  verifyCommit?: () => Promise<void>;
  /** Filesystem adapter for deterministic interrupted-cleanup qualification. */
  remove?: typeof unlink;
  lockOptions?: Partial<FileLockOptions>;
}

export async function stopActiveTask(
  root: string,
  options: StopTaskOptions = {},
) {
  let activeTaskId: string | null = null;
  const result = (
    disposition: string,
    paths: string[] = [],
    message?: string,
  ) => ({
    ok: !message,
    changed: paths.length > 0,
    mutation: message
      ? paths.length
        ? "partial"
        : "unchanged"
      : paths.length
        ? "applied"
        : "unchanged",
    paths,
    activeTaskId,
    cleanup: {
      disposition,
      scoped: options.id !== undefined,
      expectedTaskId: options.id && validId(options.id) ? options.id : null,
    },
    ...(message
      ? {
          error: { code: disposition, message },
          remaining: [
            "Review current lifecycle state; do not clear another task.",
          ],
        }
      : { error: undefined, remaining: [] }),
  });
  if (
    (options.id !== undefined && !validId(options.id)) ||
    (options.workflowToken !== undefined &&
      !validToken(options.workflowToken)) ||
    (options.workflowToken !== undefined && options.id === undefined)
  )
    return result(
      "invalid-request",
      [],
      "Scoped cleanup requires valid task and workflow identities.",
    );
  try {
    return await withActiveTaskLock(
      root,
      async (lease) => {
        activeTaskId = lease.state.id;
        if (options.id && activeTaskId && activeTaskId !== options.id)
          return result(
            "marker-mismatch",
            [],
            "A different task is active; it was left untouched.",
          );
        if (
          options.workflowToken &&
          lease.state.token !== options.workflowToken
        ) {
          if (!lease.state.id && !lease.state.token)
            return result("already-clear");
          return result(
            "workflow-mismatch",
            [],
            "The workflow token differs; lifecycle state was left untouched.",
          );
        }
        if (!lease.state.id && !lease.state.token)
          return result(options.id ? "already-clear" : "no-active-marker");
        if (!lease.state.id && lease.state.token && !options.workflowToken)
          return result(
            "orphan-token",
            [],
            "No active marker identifies this workflow token; it was left untouched.",
          );
        if (options.verifyCommit) {
          try {
            await options.verifyCommit();
          } catch {
            return result(
              "commit-not-ready",
              [],
              "Closure commit must contain this terminal task source and its task trailer, and be an ancestor of HEAD.",
            );
          }
        }
        const paths = await lease.clear(options.remove);
        return result(
          lease.state.id ? "cleared" : "associated-token-cleared",
          paths,
        );
      },
      options.lockOptions,
    );
  } catch (error) {
    if (error instanceof ActiveTaskCleanupError)
      return {
        ...result(
          error.mutation === "applied"
            ? "cleared-with-error"
            : "cleanup-failed",
          error.paths,
          error.message,
        ),
        ...(error.mutation === "applied"
          ? {
              remaining: [
                "Lifecycle files are verified absent; do not repeat cleanup solely for this error.",
              ],
            }
          : {}),
        mutation: error.mutation,
      };
    return {
      ...result(
        "state-unavailable",
        [],
        error instanceof Error ? error.message : "Lifecycle state unavailable.",
      ),
      mutation: error instanceof TaskEditError ? error.mutation : "unknown",
    };
  }
}
