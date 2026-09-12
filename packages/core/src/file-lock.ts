// Exclusive local engine writes; shared by ID allocation and checkout mutations.
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
export interface FileLockOptions {
  lockTimeoutMs: number;
  staleLockMs: number;
  retryDelayMs: number;
}
export interface FileLock {
  release(): Promise<void>;
}
const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
const absent = (error: unknown) => errorCode(error) === "ENOENT";
const occupied = (error: unknown) =>
  ["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
interface LockOwner {
  pid?: number;
  host?: string;
  startedAt?: string;
}
interface Observation {
  name?: string;
  owner?: LockOwner;
  stale: boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function observe(
  directory: string,
  staleMs: number,
): Promise<Observation> {
  const names = await readdir(directory);
  // owner.json is accepted for recovery of an interrupted older allocator.
  const name =
    names.find((name) => /^owner-[a-f0-9-]+\.json$/.test(name)) ??
    (names.includes("owner.json") ? "owner.json" : undefined);
  let owner: LockOwner | undefined;
  if (name) {
    try {
      owner = JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch (error) {
      if (absent(error)) throw error;
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const stale =
    owner?.host === hostname() &&
    typeof owner.pid === "number" &&
    Number.isInteger(owner.pid)
      ? !processIsAlive(owner.pid)
      : Date.now() - (await stat(directory)).mtimeMs >= staleMs;
  return { name, owner, stale };
}

async function removeEmpty(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!absent(error) && !occupied(error)) throw error;
  }
}

/** Publish a prepared, nonempty directory atomically. Live ownership never has
 * an empty-directory window. Removal addresses a unique owner filename, then
 * rmdir removes only an empty directory; it cannot remove a replacement owner.
 */
export async function acquireFileLock(
  directory: string,
  options: FileLockOptions,
  label = "Docket",
): Promise<FileLock> {
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const ownerName = `owner-${token}.json`;
  const candidate = join(parent, `.${basename(directory)}.candidate-${token}`);
  let published = false;
  const started = Date.now();
  await mkdir(candidate, { mode: 0o700 });
  try {
    await writeFile(
      join(candidate, ownerName),
      `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    for (;;) {
      let observation: Observation | undefined;
      try {
        observation = await observe(directory, options.staleLockMs);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (observation?.stale) {
        if (observation.name) {
          // Another recoverer may already have removed this exact owner. In
          // that case, never act on the directory using the old observation.
          try {
            await unlink(join(directory, observation.name));
          } catch (error) {
            if (!absent(error)) throw error;
            // Retry from a new observation, but still enforce the deadline.
            observation = undefined;
          }
        }
        if (observation) await removeEmpty(directory);
      }
      if (!observation || observation.stale) {
        try {
          await rename(candidate, directory);
          published = true;
          let released = false;
          return {
            release: async () => {
              if (released) return;
              released = true;
              try {
                await unlink(join(directory, ownerName));
              } catch (error) {
                if (absent(error)) return;
                throw error;
              }
              await removeEmpty(directory);
            },
          };
        } catch (error) {
          if (!occupied(error)) throw error;
        }
      }
      if (Date.now() - started >= options.lockTimeoutMs) {
        const owner = observation?.owner;
        throw new Error(
          `timed out after ${options.lockTimeoutMs}ms waiting for ${label} lock ${directory}${owner ? ` (owner ${owner.host ?? "unknown"}:${owner.pid ?? "unknown"}, started ${owner.startedAt ?? "unknown"})` : ""}`,
        );
      }
      await sleep(options.retryDelayMs);
    }
  } finally {
    // This unpublished candidate belongs only to this attempt. Failure to
    // publish owner metadata cannot strand a shared lock directory.
    if (!published) await rm(candidate, { recursive: true, force: true });
  }
}
