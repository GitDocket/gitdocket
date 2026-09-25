import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Bundle } from "./bundle";
import type {
  ActivityRow,
  GitActivityObservation,
  GitCheckpoint,
  GitEvidence,
  GitEvidenceOptions,
  GitWorktreeEvidence,
} from "./cache";
import { GitProcessPool } from "./git-process";
import {
  resolveTaskProgress,
  TaskObservationReader,
} from "./task-observations";

interface History {
  rows: ActivityRow[];
  complete: boolean;
  commits: number;
  retainedBytes: number;
}

export interface GitSnapshot {
  git: GitEvidence;
  /** Full canonical activity within the explicit history budget, never the UI preview. */
  activity: ActivityRow[];
}

export interface GitIndexOptions extends GitEvidenceOptions {
  bundlePath?: string;
  /** Mutable refs, checkout status and markers are reobserved on demand after this TTL. */
  ttlMs?: number;
  historyLimit?: number;
  tipHistoryLimit?: number;
  timeoutMs?: number;
  maxBytes?: number;
  concurrency?: number;
  onCommand?: (args: string[]) => void;
}

const format = (trailer: string) =>
  `--format=%H%x00%cI%x00%s%x00%(trailers:key=${trailer},valueonly)`;

function parseHistory(
  output: string,
  limit: number,
  rowLimit = 200000,
): History {
  // git log -z terminates each four-field record with NUL. Commit messages
  // may contain other control characters, including the old US/RS separators.
  const fields = output.split("\0");
  const recordCount = Math.floor(fields.length / 4);
  const rows: ActivityRow[] = [];
  let retainedBytes = 0;
  let complete = recordCount <= limit;
  scan: for (let i = 0; i < Math.min(recordCount, limit); i++) {
    const [sha, date, subject, trailers = ""] = fields.slice(i * 4, i * 4 + 4);
    if (!sha || !date) continue;
    for (const taskId of trailers
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (rows.length >= rowLimit) {
        complete = false;
        break scan;
      }
      rows.push({ taskId, sha, date, subject: (subject ?? "").trim() });
      retainedBytes +=
        128 +
        2 * (taskId.length + sha.length + date.length + (subject?.length ?? 0));
    }
  }
  return {
    rows,
    complete,
    retainedBytes,
    commits: Math.min(recordCount, limit),
  };
}

function worktreeInventory(output: string): GitWorktreeEvidence[] {
  return output
    .split("\0\0")
    .filter(Boolean)
    .flatMap((record) => {
      const fields = record.split("\0");
      const field = (name: string) =>
        fields
          .find((value) => value.startsWith(`${name} `))
          ?.slice(name.length + 1);
      const path = field("worktree");
      const head = field("HEAD");
      return path && head
        ? [
            {
              path,
              head,
              ref: field("branch") ?? null,
              activeTaskId: null,
              dirty: null,
              mergedIntoCurrentHead: null,
              current: false,
              available: false,
            },
          ]
        : [];
    });
}

/**
 * Disposable per-repository evidence owner. Immutable raw trailers are cached by
 * pinned SHA and shallow boundary; aliases are resolved against each caller's
 * current bundle. No polling timer, disk cache, network, or canonical state writes.
 */
export class GitEvidenceIndex {
  private readonly pool: GitProcessPool;
  private readonly taskReader = new TaskObservationReader();
  private cached?: { value: GitSnapshot; at: number };
  private pending?: Promise<GitSnapshot>;
  private pendingEpoch = -1;
  private headHistory?: { key: string; value: History };
  private tips = new Map<string, History>();
  private mergedTips = new Set<string>();
  private counts = new Map<string, number>();
  private boundary?: string;
  private shallow = false;
  private deadline = Number.POSITIVE_INFINITY;
  private epoch = 0;
  private closed = false;
  private readonly options: Required<
    Pick<
      GitIndexOptions,
      | "ttlMs"
      | "historyLimit"
      | "tipHistoryLimit"
      | "commitLimit"
      | "refLimit"
      | "worktreeLimit"
    >
  > &
    GitIndexOptions;

  constructor(
    private readonly root: string,
    private readonly trailer: string,
    options: GitIndexOptions = {},
  ) {
    this.options = {
      ttlMs: 2000,
      historyLimit: 200000,
      tipHistoryLimit: 500,
      commitLimit: 50,
      refLimit: 128,
      worktreeLimit: 64,
      ...options,
    };
    for (const key of [
      "historyLimit",
      "tipHistoryLimit",
      "commitLimit",
      "refLimit",
      "worktreeLimit",
    ] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1)
        throw new Error(`${key} must be a positive integer`);
    }
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    )
      throw new Error("concurrency must be a positive integer");
    this.pool = new GitProcessPool(options);
  }

  invalidate(): void {
    this.epoch++;
    this.cached = undefined;
  }

  close(): void {
    this.closed = true;
    this.invalidate();
    this.pool.close();
    this.taskReader.clear();
    this.headHistory = undefined;
    this.tips.clear();
    this.mergedTips.clear();
    this.counts.clear();
  }

  async snapshot(byId: Bundle["byId"]): Promise<GitSnapshot> {
    if (this.closed) throw new Error("Git evidence index is closed");
    let raw =
      this.cached && Date.now() - this.cached.at < this.options.ttlMs
        ? this.cached.value
        : undefined;
    while (!raw) {
      if (!this.pending) {
        const epoch = this.epoch;
        this.pendingEpoch = epoch;
        this.pending = this.capture(byId)
          .then((value) => {
            if (
              !this.closed &&
              epoch === this.epoch &&
              value.git.status === "available"
            )
              this.cached = { value, at: Date.now() };
            return value;
          })
          .finally(() => {
            this.pending = undefined;
          });
      }
      const epoch = this.pendingEpoch;
      raw = await this.pending;
      if (this.closed) throw new Error("Git evidence index is closed");
      if (epoch !== this.epoch) raw = undefined;
    }
    if (this.closed) throw new Error("Git evidence index is closed");
    // Map each distinct ID once, and reuse unchanged rows. Never pin aliases to Git SHA.
    const ids = new Map<string, string>();
    const normalize = (id: string) => {
      let result = ids.get(id);
      if (result === undefined) {
        result = byId(id)?.fm.id ?? id;
        ids.set(id, result);
      }
      return result;
    };
    const rows = (values: ActivityRow[]) =>
      values.map((row) => {
        const taskId = normalize(row.taskId);
        return taskId === row.taskId ? row : { ...row, taskId };
      });
    const observations = new Map<string, GitActivityObservation>();
    for (const row of raw.git.unmergedActivity) {
      const taskId = normalize(row.taskId);
      const key = `${row.sha}\x1f${taskId}`;
      const old = observations.get(key);
      observations.set(
        key,
        old
          ? {
              ...old,
              refs: [...new Set([...old.refs, ...row.refs])].sort(),
              worktrees: [
                ...new Set([...old.worktrees, ...row.worktrees]),
              ].sort(),
            }
          : { ...row, taskId },
      );
    }
    const unmergedActivity = [...observations.values()].sort(compareActivity);
    return {
      activity: rows(raw.activity),
      git: {
        ...raw.git,
        ...(raw.git.taskProgress
          ? {
              taskProgress: resolveTaskProgress(
                raw.git.taskProgress,
                byId,
                raw.git.worktrees.find((w) => w.current)?.activeTaskId,
                raw.git.worktrees,
              ),
            }
          : {}),
        activity: rows(raw.git.activity),
        unmergedActivity: unmergedActivity.slice(0, this.options.commitLimit),
        truncated:
          raw.git.truncated ||
          unmergedActivity.length > this.options.commitLimit,
      },
    };
  }

  /** Exact distinct commits, pinned to the checkpoint shown with this result. */
  async countSince(
    sha: string,
    checkpoint: GitCheckpoint | null,
  ): Promise<number | undefined> {
    if (
      this.closed ||
      this.shallow ||
      !checkpoint ||
      !/^[0-9a-f]{7,64}$/i.test(sha)
    )
      return undefined;
    try {
      const resolved = (
        await this.pool.run(this.root, [
          "rev-parse",
          "--verify",
          `${sha}^{commit}`,
        ])
      ).trim();
      const key = `${checkpoint.revision}:${resolved}`;
      if (this.counts.has(key)) return this.counts.get(key);
      const output = await this.pool.run(this.root, [
        "log",
        "-z",
        `${resolved}..${checkpoint.revision}`,
        `--max-count=${this.options.historyLimit + 1}`,
        format(this.trailer),
      ]);
      const history = parseHistory(output, this.options.historyLimit);
      if (!history.complete) return undefined;
      const count = new Set(history.rows.map((row) => row.sha)).size;
      const oldest = this.counts.keys().next().value;
      if (this.counts.size >= 32 && oldest !== undefined)
        this.counts.delete(oldest);
      if (!this.closed) this.counts.set(key, count);
      return count;
    } catch {
      return undefined;
    }
  }

  private async capture(byId: Bundle["byId"]): Promise<GitSnapshot> {
    this.deadline = Date.now() + 30000;
    const run = (cwd: string, args: string[]) =>
      this.pool.run(cwd, args, this.deadline);
    let checkpoint: GitCheckpoint | null = null;
    try {
      const [revision, time] = (
        await run(this.root, ["show", "-s", "--format=%H%x1f%cI", "HEAD"])
      )
        .trim()
        .split("\x1f");
      if (!revision || !time)
        throw new Error("Git history is unavailable from this checkout");
      checkpoint = { revision, time };
      const commonDir = (
        await run(this.root, ["rev-parse", "--git-common-dir"])
      ).trim();
      const shallow = await readFile(
        resolve(this.root, commonDir, "shallow"),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const boundary = `${resolve(this.root, commonDir)}:${shallow}`;
      if (this.boundary !== boundary) {
        this.tips.clear();
        this.mergedTips.clear();
        this.counts.clear();
        this.boundary = boundary;
      }
      this.shallow = !!shallow;
      const headKey = `${boundary}:${revision}`;
      const historyPromise =
        this.headHistory?.key === headKey
          ? Promise.resolve(this.headHistory.value)
          : run(this.root, [
              "log",
              "-z",
              revision,
              `--max-count=${this.options.historyLimit + 1}`,
              format(this.trailer),
            ]).then((output) => {
              const value = parseHistory(output, this.options.historyLimit);
              if (!this.closed) this.headHistory = { key: headKey, value };
              return value;
            });
      // Bound admitted names before status/history fan-out. This one inventory is
      // byte-bounded too; worktree list has no native count flag.
      const results = await Promise.allSettled([
        historyPromise,
        run(this.root, [
          "for-each-ref",
          `--count=${this.options.refLimit + 1}`,
          "--format=%(refname)%09%(objectname)",
          "refs/heads",
          "refs/remotes",
        ]),
        run(this.root, ["worktree", "list", "--porcelain", "-z"]),
      ] as const);
      const [h, r, w] = results;
      if (h.status === "rejected") throw h.reason;
      const history = h.value;
      const reasons: string[] = [];
      if (r.status === "rejected")
        reasons.push(`Ref inventory unavailable: ${String(r.reason)}`);
      if (w.status === "rejected")
        reasons.push(`Worktree inventory unavailable: ${String(w.reason)}`);
      const allRefs = (r.status === "fulfilled" ? r.value : "")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [ref = "", head = ""] = line.split("\t");
          return { ref, head };
        });
      const allWorktrees = worktreeInventory(
        w.status === "fulfilled" ? w.value : "",
      ).sort((a, b) => a.path.localeCompare(b.path));
      const currentRoot = await realpath(this.root).catch(() =>
        resolve(this.root),
      );
      // Always admit the calling checkout even when other paths fill the budget.
      allWorktrees.sort(
        (a, b) =>
          Number(b.path === currentRoot) - Number(a.path === currentRoot),
      );
      const refs = allRefs.slice(0, this.options.refLimit);
      const worktrees = allWorktrees.slice(0, this.options.worktreeLimit);
      let truncated =
        reasons.length > 0 ||
        allRefs.length > refs.length ||
        allWorktrees.length > worktrees.length ||
        !history.complete ||
        !!shallow;
      if (!history.complete)
        reasons.push(
          `Canonical history exceeds ${this.options.historyLimit} inspected commits or 200000 task rows`,
        );
      if (shallow)
        reasons.push(
          "Shallow checkout: history stops at the local shallow boundary",
        );
      const tips = new Map<
        string,
        { refs: Set<string>; worktrees: Set<string> }
      >();
      const sources = (head: string) => {
        let value = tips.get(head);
        if (!value) {
          value = { refs: new Set(), worktrees: new Set() };
          tips.set(head, value);
        }
        return value;
      };
      for (const { ref, head } of refs) sources(head).refs.add(ref);
      await Promise.all(
        worktrees.map(async (worktree) => {
          const source = sources(worktree.head);
          source.worktrees.add(worktree.path);
          if (worktree.ref) source.refs.add(worktree.ref);
          worktree.current = worktree.path === currentRoot;
          worktree.activeTaskId = await readFile(
            join(worktree.path, ".docket", "active-task"),
            "utf8",
          )
            .then((text) => text.trim() || null)
            .catch(() => null);
          try {
            worktree.dirty =
              (
                await run(worktree.path, [
                  "status",
                  "--porcelain=v1",
                  "--untracked-files=normal",
                ])
              ).trim().length > 0;
            worktree.available = true;
          } catch {
            truncated = true;
            reasons.push(`Checkout status unavailable: ${worktree.path}`);
          }
        }),
      );
      this.options.afterInventory?.();
      // Batch ancestry avoids one process per already-merged ref. Returned object
      // IDs can only prove facts about the pinned tips, never retarget them.
      const merged = new Set([revision]);
      for (const tip of tips.keys())
        if (this.mergedTips.has(`${headKey}:${tip}`)) merged.add(tip);
      try {
        const unknownTips = [...tips.keys()].some(
          (tip) =>
            !merged.has(tip) &&
            !this.tips.has(`${boundary}:${revision}:${tip}`),
        );
        const output = unknownTips
          ? await run(this.root, [
              "for-each-ref",
              `--count=${this.options.refLimit + 1}`,
              `--merged=${revision}`,
              "--format=%(objectname)",
              "refs/heads",
              "refs/remotes",
            ])
          : "";
        for (const sha of output.trim().split("\n")) merged.add(sha);
      } catch {
        /* Pinned per-tip history below is the bounded fallback. */
      }
      const observations = new Map<string, GitActivityObservation>();
      let observationCutoff: ActivityRow | undefined;
      const ancestry = new Map<string, boolean | null>();
      await Promise.all(
        [...tips].map(async ([tip, source]) => {
          if (merged.has(tip)) {
            ancestry.set(tip, true);
            const oldest = this.mergedTips.values().next().value;
            if (this.mergedTips.size >= 512 && oldest !== undefined)
              this.mergedTips.delete(oldest);
            if (!this.closed) this.mergedTips.add(`${headKey}:${tip}`);
            return;
          }
          try {
            const key = `${boundary}:${revision}:${tip}`;
            let evidence = this.tips.get(key);
            if (!evidence) {
              const output = await run(this.root, [
                "log",
                "-z",
                tip,
                "--not",
                revision,
                `--max-count=${this.options.tipHistoryLimit + 1}`,
                format(this.trailer),
              ]);
              evidence = parseHistory(
                output,
                this.options.tipHistoryLimit,
                2000,
              );
              let retainedBytes = [...this.tips.values()].reduce(
                (sum, value) => sum + value.retainedBytes,
                0,
              );
              while (
                this.tips.size &&
                (this.tips.size >= 256 ||
                  retainedBytes + evidence.retainedBytes > 16 * 1024 * 1024)
              ) {
                const oldest = this.tips.keys().next().value;
                if (oldest === undefined) break;
                retainedBytes -= this.tips.get(oldest)?.retainedBytes ?? 0;
                this.tips.delete(oldest);
              }
              if (!this.closed && evidence.retainedBytes <= 16 * 1024 * 1024)
                this.tips.set(key, evidence);
            }
            ancestry.set(
              tip,
              evidence.commits === 0 ? true : shallow ? null : false,
            );
            if (!evidence.complete) truncated = true;
            for (const row of evidence.rows) {
              if (
                observationCutoff &&
                compareActivity(row, observationCutoff) >= 0
              ) {
                truncated = true;
                continue;
              }
              const key = `${row.sha}\x1f${row.taskId}`;
              const old = observations.get(key);
              observations.set(key, {
                ...row,
                mergedIntoCurrentHead: false,
                refs: [
                  ...new Set([...(old?.refs ?? []), ...source.refs]),
                ].sort(),
                worktrees: [
                  ...new Set([...(old?.worktrees ?? []), ...source.worktrees]),
                ].sort(),
              });
            }
            // Keep deterministic newest observations even when many unmerged
            // tips exceed the preview budget. This bounds the retained snapshot
            // independently of the reusable history cache.
            let bytes = 0;
            const ordered = [...observations.entries()].sort(([, a], [, b]) =>
              compareActivity(a, b),
            );
            for (let i = 0; i < ordered.length; i++) {
              const entry = ordered[i];
              if (!entry) continue;
              const [key, row] = entry;
              bytes +=
                128 +
                2 *
                  (row.taskId.length +
                    row.sha.length +
                    row.date.length +
                    row.subject.length +
                    row.refs.join("").length +
                    row.worktrees.join("").length);
              if (i >= 2000 || bytes > 8 * 1024 * 1024) {
                if (
                  !observationCutoff ||
                  compareActivity(row, observationCutoff) < 0
                )
                  observationCutoff = row;
                observations.delete(key);
                truncated = true;
              }
            }
          } catch {
            ancestry.set(tip, null);
            truncated = true;
            reasons.push(`Pinned tip history unavailable: ${tip}`);
          }
        }),
      );
      for (const worktree of worktrees)
        worktree.mergedIntoCurrentHead = ancestry.get(worktree.head) ?? null;
      const taskProgress = await this.taskReader.capture(
        this.root,
        this.options.bundlePath ?? "docket",
        revision,
        worktrees,
        refs,
        byId,
        run,
        this.deadline,
      );
      if (
        r.status === "rejected" ||
        w.status === "rejected" ||
        allRefs.length > refs.length ||
        allWorktrees.length > worktrees.length
      ) {
        taskProgress.complete = false;
        taskProgress.diagnostics.push(
          "Git source inventory is incomplete; task observations cover only admitted sources",
        );
      }
      const unmergedActivity = [...observations.values()].sort(compareActivity);
      truncated ||= history.rows.length > this.options.commitLimit;
      return {
        activity: history.rows,
        git: {
          status: "available",
          taskProgress: { ...taskProgress, tasks: [] },
          checkpoint,
          activity: history.rows.slice(0, this.options.commitLimit),
          unmergedActivity,
          worktrees: worktrees.sort((a, b) => a.path.localeCompare(b.path)),
          truncated,
          historyComplete: history.complete && !shallow,
          ...(reasons.length ? { reason: reasons.sort().join("; ") } : {}),
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        activity: [],
        git: {
          status: "history-unavailable",
          checkpoint,
          activity: [],
          unmergedActivity: [],
          worktrees: [],
          truncated: false,
          historyComplete: false,
          reason: /not a git repository|bad revision|unknown revision/.test(
            reason,
          )
            ? "Git history is unavailable from this checkout"
            : reason,
        },
      };
    }
  }
}

function compareActivity(a: ActivityRow, b: ActivityRow): number {
  return (
    b.date.localeCompare(a.date) ||
    a.sha.localeCompare(b.sha) ||
    a.taskId.localeCompare(b.taskId)
  );
}
