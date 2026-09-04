// Optional local-Git coordination for sequential work-item creation. The core
// create path accepts this boundary explicitly so in-memory, filesystem-only,
// and future hosted stores keep deterministic max+1 behavior without needing
// a system Git binary.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseConfig } from "./config";
import { LocalFileStore } from "./filestore";

const execFileAsync = promisify(execFile);

export interface WorkItemIdCoordinator {
  allocate<T>(
    project: string,
    create: (knownIds: ReadonlySet<string>) => Promise<T>,
  ): Promise<T>;
}

export interface GitWorktreeIdCoordinatorOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  retryDelayMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const LOCK_DIRECTORY = "docket/id-allocation.lock";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

async function git(
  repoRoot: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function gitCommonDirectory(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
    const value = stdout.trim();
    if (!value) throw new Error("git returned an empty common directory");
    return isAbsolute(value) ? value : resolve(repoRoot, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) return null;
    throw new Error(`cannot resolve Git common directory: ${message}`);
  }
}

async function linkedWorktrees(repoRoot: string): Promise<string[]> {
  const { stdout } = await git(repoRoot, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const paths = stdout
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return [...new Set(paths)];
}

function readableWorkItemId(source: string): string | null {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter?.[1]) return null;
  const id = frontmatter[1].match(/^id:\s*['"]?([^\s'"#]+)['"]?\s*(?:#.*)?$/m);
  return id?.[1] ?? null;
}

async function idsInWorktree(
  worktree: string,
  project: string,
): Promise<string[]> {
  let configSource: string;
  try {
    configSource = await readFile(join(worktree, "docket.yaml"), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      try {
        await stat(worktree);
      } catch (worktreeError) {
        if (errorCode(worktreeError) === "ENOENT") {
          throw new Error(
            `linked worktree disappeared during ID allocation: ${worktree}; prune or restore it, then retry`,
          );
        }
        throw worktreeError;
      }
      // A live worktree from before Docket adoption does not participate in
      // this repository's work-item namespace.
      return [];
    }
    throw error;
  }

  const config = parseConfig(configSource);
  const store = new LocalFileStore(resolve(worktree, config.bundle));
  let paths: string[];
  try {
    paths = await store.list();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(
        `cannot scan configured bundle ${config.bundle} in linked worktree ${worktree}; restore it or remove the stale worktree`,
      );
    }
    throw error;
  }

  const ids: string[] = [];
  for (const path of paths) {
    if (!/^work\/(?:tasks|epics)\/.+\.md$/.test(path)) continue;
    const source = await store.read(path).catch((error: unknown) => {
      throw new Error(
        `cannot read linked work item ${join(worktree, config.bundle, path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const id = readableWorkItemId(source);
    if (!id) {
      throw new Error(
        `cannot allocate an ID while linked work item ${join(worktree, config.bundle, path)} has no readable frontmatter id`,
      );
    }
    if (id.startsWith(`${project}-`)) ids.push(id);
  }
  return ids;
}

async function repositoryIds(
  repoRoot: string,
  project: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const worktree of await linkedWorktrees(repoRoot)) {
    for (const id of await idsInWorktree(worktree, project)) ids.add(id);
  }
  return ids;
}

interface LockOwner {
  pid?: number;
  host?: string;
  startedAt?: string;
}

async function readOwner(lockDirectory: string): Promise<LockOwner | null> {
  try {
    return JSON.parse(
      await readFile(join(lockDirectory, "owner.json"), "utf8"),
    ) as LockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function lockIsStale(
  lockDirectory: string,
  staleLockMs: number,
): Promise<boolean> {
  const owner = await readOwner(lockDirectory);
  if (
    owner?.host === hostname() &&
    typeof owner.pid === "number" &&
    Number.isInteger(owner.pid)
  ) {
    return !processIsAlive(owner.pid);
  }
  const metadata = await stat(lockDirectory);
  return Date.now() - metadata.mtimeMs >= staleLockMs;
}

async function acquireLock(
  commonDirectory: string,
  options: Required<GitWorktreeIdCoordinatorOptions>,
): Promise<string> {
  const parent = join(commonDirectory, "docket");
  const lockDirectory = join(commonDirectory, LOCK_DIRECTORY);
  await mkdir(parent, { recursive: true });
  const started = Date.now();

  for (;;) {
    try {
      await mkdir(lockDirectory);
      await writeFile(
        join(lockDirectory, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          host: hostname(),
          startedAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      return lockDirectory;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;

      if (
        await lockIsStale(lockDirectory, options.staleLockMs).catch(() => true)
      ) {
        const staleDirectory = `${lockDirectory}.stale-${process.pid}-${Date.now()}`;
        try {
          await rename(lockDirectory, staleDirectory);
          await rm(staleDirectory, { recursive: true, force: true });
          continue;
        } catch (recoveryError) {
          if (
            errorCode(recoveryError) === "ENOENT" ||
            errorCode(recoveryError) === "EEXIST"
          ) {
            continue;
          }
          throw new Error(
            `cannot recover stale Docket ID-allocation lock ${lockDirectory}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          );
        }
      }

      if (Date.now() - started >= options.lockTimeoutMs) {
        const owner = await readOwner(lockDirectory);
        throw new Error(
          `timed out after ${options.lockTimeoutMs}ms waiting for Docket ID-allocation lock ${lockDirectory}${owner ? ` (owner ${owner.host ?? "unknown"}:${owner.pid ?? "unknown"}, started ${owner.startedAt ?? "unknown"})` : ""}`,
        );
      }
      await sleep(options.retryDelayMs);
    }
  }
}

/**
 * Same-repository coordinator for LocalFileStore creation. The lock lives in
 * Git's common directory, so every linked worktree uses one allocation
 * boundary. The scan reads each live worktree's own docket.yaml and working
 * files, which includes staged, unstaged, and untracked concepts.
 */
export class GitWorktreeIdCoordinator implements WorkItemIdCoordinator {
  private readonly options: Required<GitWorktreeIdCoordinatorOptions>;

  constructor(
    private readonly repoRoot: string,
    options: GitWorktreeIdCoordinatorOptions = {},
  ) {
    this.options = {
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      staleLockMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    };
  }

  async allocate<T>(
    project: string,
    create: (knownIds: ReadonlySet<string>) => Promise<T>,
  ): Promise<T> {
    const commonDirectory = await gitCommonDirectory(this.repoRoot);
    if (!commonDirectory) return create(new Set());

    const lockDirectory = await acquireLock(commonDirectory, this.options);
    try {
      return await create(await repositoryIds(this.repoRoot, project));
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }
}
