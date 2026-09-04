// The serve --commit committer: one path-scoped commit per successful UI
// write. Commit construction happens in a temporary index; the live index is
// observed only so selected entries can be reconciled after a successful CAS
// update without sweeping or overwriting concurrent staging.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CommitOp {
  /** Bundle-relative paths the op touched. */
  paths: string[];
  /** Full commit message, trailer included. */
  message: string;
}

export type Committer = (op: CommitOp) => Promise<void>;

export interface CommitterOptions {
  /** Bounded compare-and-swap retries when another commit advances HEAD. */
  maxHeadUpdateAttempts?: number;
  /** Deterministic concurrency seam used by real-repository tests. */
  beforeHeadUpdate?: (
    attempt: number,
    baseHead: string | null,
  ) => void | Promise<void>;
}

interface IndexEntry {
  mode: string;
  objectId: string;
  stage: number;
}

type SelectedEntries = Map<string, IndexEntry[]>;

const indexEntriesEqual = (
  left: readonly IndexEntry[],
  right: readonly IndexEntry[],
): boolean =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.mode === right[index]?.mode &&
      entry.objectId === right[index]?.objectId &&
      entry.stage === right[index]?.stage,
  );

const selectedEntriesEqual = (
  left: ReadonlyMap<string, readonly IndexEntry[]>,
  right: ReadonlyMap<string, readonly IndexEntry[]>,
  paths: readonly string[],
): boolean =>
  paths.every((path) =>
    indexEntriesEqual(left.get(path) ?? [], right.get(path) ?? []),
  );

function parseIndexEntries(output: string): Map<string, IndexEntry[]> {
  const parsed = new Map<string, IndexEntry[]>();
  for (const record of output.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    const [mode, objectId, stageText] = record.slice(0, tab).split(" ");
    const stage = Number(stageText);
    if (!mode || !objectId || !Number.isInteger(stage)) continue;
    const entries = parsed.get(path) ?? [];
    entries.push({ mode, objectId, stage });
    parsed.set(path, entries);
  }
  return parsed;
}

export function createCommitter(
  root: string,
  bundleDir: string,
  options: CommitterOptions = {},
): Committer {
  const repoRoot = resolve(root);
  const maxAttempts = options.maxHeadUpdateAttempts ?? 3;

  const run = (
    args: string[],
    runOptions: {
      env?: Record<string, string>;
      input?: string;
      acceptedExitCodes?: number[];
    } = {},
  ): string => {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...runOptions.env },
      stdin:
        runOptions.input === undefined
          ? undefined
          : Buffer.from(runOptions.input),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (
      proc.exitCode !== 0 &&
      !runOptions.acceptedExitCodes?.includes(proc.exitCode)
    ) {
      const detail =
        `${proc.stderr.toString()}${proc.stdout.toString()}`.trim();
      throw new Error(`git ${args[0]} failed: ${detail}`);
    }
    return proc.stdout.toString();
  };

  const resolveHead = (): string | null =>
    run(["rev-parse", "--verify", "HEAD"], {
      acceptedExitCodes: [128],
    }).trim() || null;

  const selectedEntries = (
    paths: readonly string[],
    env?: Record<string, string>,
  ): SelectedEntries => {
    const parsed = parseIndexEntries(
      run(["ls-files", "--stage", "-z", "--", ...paths], { env }),
    );
    return new Map(paths.map((path) => [path, parsed.get(path) ?? []]));
  };

  const headEntries = (
    head: string | null,
    paths: readonly string[],
  ): SelectedEntries => {
    if (!head) return new Map(paths.map((path) => [path, []]));
    const parsed = parseIndexEntries(
      run([
        "ls-tree",
        "-r",
        "-z",
        "--format=%(objectmode) %(objectname) 0%x09%(path)",
        head,
        "--",
        ...paths,
      ]),
    );
    return new Map(paths.map((path) => [path, parsed.get(path) ?? []]));
  };

  const replaceSelectedEntries = (
    paths: readonly string[],
    entries: ReadonlyMap<string, readonly IndexEntry[]>,
    env?: Record<string, string>,
  ): void => {
    const objectIdLength =
      [...entries.values()].flat()[0]?.objectId.length ??
      run(["hash-object", "--stdin"], { input: "" }).trim().length;
    const zero = "0".repeat(objectIdLength);
    const records: string[] = [];
    for (const path of paths) {
      records.push(`0 ${zero}\t${path}\0`);
      for (const entry of entries.get(path) ?? []) {
        records.push(
          `${entry.mode} ${entry.objectId} ${entry.stage}\t${path}\0`,
        );
      }
    }
    run(["update-index", "-z", "--index-info"], {
      env,
      input: records.join(""),
    });
  };

  const populateTemporaryIndex = (
    env: Record<string, string>,
    baseHead: string | null,
    paths: readonly string[],
    entries: ReadonlyMap<string, readonly IndexEntry[]>,
  ): void => {
    run(baseHead ? ["read-tree", baseHead] : ["read-tree", "--empty"], {
      env,
    });
    replaceSelectedEntries(paths, entries, env);
  };

  const assertNoRepositoryOperation = (): void => {
    const markers = [
      ["MERGE_HEAD", "merge"],
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ] as const;
    for (const [marker, label] of markers) {
      const configured = run(["rev-parse", "--git-path", marker]).trim();
      const path = isAbsolute(configured)
        ? configured
        : join(repoRoot, configured);
      if (existsSync(path)) {
        throw new Error(
          `Cannot auto-commit selected files while a Git ${label} is in progress`,
        );
      }
    }
  };

  const runHook = (
    name: string,
    args: readonly string[],
    env: Record<string, string>,
    ignoreFailure = false,
  ): void => {
    try {
      run(
        [
          "hook",
          "run",
          "--ignore-missing",
          name,
          ...(args.length > 0 ? ["--", ...args] : []),
        ],
        { env: { ...env, GIT_EDITOR: ":" } },
      );
    } catch (error) {
      if (!ignoreFailure) throw error;
    }
  };

  return async ({ paths, message }) => {
    const repoPaths = [...new Set(paths)]
      .map((path) => relative(repoRoot, resolve(repoRoot, bundleDir, path)))
      .sort();
    if (
      repoPaths.length === 0 ||
      repoPaths.some(
        (path) => path === "" || path === ".." || path.startsWith(`..${sep}`),
      )
    ) {
      throw new Error("Serve commit paths must stay inside the repository");
    }

    assertNoRepositoryOperation();
    const initialHead = resolveHead();
    const initialHeadEntries = headEntries(initialHead, repoPaths);
    const initialLiveEntries = selectedEntries(repoPaths);
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "docket-serve-commit-"),
    );
    const temporaryIndex = join(temporaryDirectory, "index");
    const messagePath = join(temporaryDirectory, "message");
    const temporaryEnv = { GIT_INDEX_FILE: temporaryIndex };

    try {
      run(initialHead ? ["read-tree", initialHead] : ["read-tree", "--empty"], {
        env: temporaryEnv,
      });
      run(["add", "-A", "--", ...repoPaths], { env: temporaryEnv });
      runHook("pre-commit", [], temporaryEnv);
      const commitEntries = selectedEntries(repoPaths, temporaryEnv);

      writeFileSync(
        messagePath,
        message.endsWith("\n") ? message : `${message}\n`,
      );
      runHook("prepare-commit-msg", [messagePath, "message"], temporaryEnv);
      runHook("commit-msg", [messagePath], temporaryEnv);
      if (!readFileSync(messagePath, "utf8").trim()) {
        throw new Error("Commit message became empty after hooks");
      }

      const signCommit =
        run(["config", "--bool", "--get", "commit.gpgSign"], {
          acceptedExitCodes: [1],
        }).trim() === "true";
      let lastHeadError: Error | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        assertNoRepositoryOperation();
        const baseHead = resolveHead();
        if (
          baseHead !== initialHead &&
          !selectedEntriesEqual(
            initialHeadEntries,
            headEntries(baseHead, repoPaths),
            repoPaths,
          )
        ) {
          throw new Error(
            "Git HEAD changed one of the selected paths before the Serve commit could be finalized",
          );
        }

        populateTemporaryIndex(
          temporaryEnv,
          baseHead,
          repoPaths,
          commitEntries,
        );
        const treeId = run(["write-tree"], { env: temporaryEnv }).trim();
        const baseTree = baseHead
          ? run(["rev-parse", `${baseHead}^{tree}`]).trim()
          : null;
        if (baseTree === treeId) {
          throw new Error("No changes to commit for the selected paths");
        }

        const commitArgs = ["commit-tree"];
        if (signCommit) commitArgs.push("-S");
        commitArgs.push(treeId);
        if (baseHead) commitArgs.push("-p", baseHead);
        commitArgs.push("-F", messagePath);
        const commitId = run(commitArgs, { env: temporaryEnv }).trim();

        await options.beforeHeadUpdate?.(attempt, baseHead);
        try {
          run([
            "update-ref",
            "-m",
            `commit: ${readFileSync(messagePath, "utf8").split("\n", 1)[0]}`,
            "HEAD",
            commitId,
            baseHead ?? "",
          ]);
        } catch (error) {
          lastHeadError =
            error instanceof Error ? error : new Error(String(error));
          if (resolveHead() === baseHead) throw lastHeadError;
          continue;
        }

        const currentLiveEntries = selectedEntries(repoPaths);
        if (
          selectedEntriesEqual(
            initialLiveEntries,
            currentLiveEntries,
            repoPaths,
          )
        ) {
          try {
            replaceSelectedEntries(repoPaths, commitEntries);
          } catch {
            // HEAD already points at the durable commit. A concurrent index
            // owner wins; leaving the selected entry visible is safer than
            // reporting the successful commit as failed or overwriting them.
          }
        }
        runHook("post-commit", [], {}, true);
        return;
      }
      throw new Error(
        `Git HEAD kept changing while committing selected paths: ${lastHeadError?.message ?? "compare-and-swap failed"}`,
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  };
}
