// Optional local-Git coordination for sequential work-item creation. The core
// create path accepts this boundary explicitly so in-memory, filesystem-only,
// and future hosted stores keep deterministic max+1 behavior without needing
// a system Git binary.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { reservedConceptIds } from "./concept-ids";
import { parseConfig } from "./config";
import { mapFiles } from "./file-batch";
import { acquireFileLock } from "./file-lock";
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

  const ids = await mapFiles(paths, async (path) => {
    const source = await store.read(path).catch((error: unknown) => {
      throw new Error(
        `cannot read linked work item ${join(worktree, config.bundle, path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return reservedConceptIds(source, path).filter((id) =>
      id.startsWith(`${project}-`),
    );
  });
  return ids.flat();
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

    const lockDirectory = await acquireFileLock(
      join(commonDirectory, LOCK_DIRECTORY),
      this.options,
      "Docket ID-allocation",
    );
    try {
      return await create(await repositoryIds(this.repoRoot, project));
    } finally {
      await lockDirectory.release();
    }
  }
}
