import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBundle } from "./bundle";
import { GitEvidenceIndex, scanGitEvidence } from "./cache";
import { parseConfig } from "./config";
import { LocalFileStore } from "./filestore";
import { GitProcessPool } from "./git-process";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Docket Test",
  GIT_AUTHOR_EMAIL: "docket@example.test",
  GIT_COMMITTER_NAME: "Docket Test",
  GIT_COMMITTER_EMAIL: "docket@example.test",
};

let temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
  temporaryRoots = [];
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture(): Promise<{
  parent: string;
  root: string;
  bundle: Awaited<ReturnType<typeof loadBundle>>;
}> {
  const parent = await mkdtemp(join(tmpdir(), "docket-git-evidence-"));
  temporaryRoots.push(parent);
  const root = join(parent, "main");
  await mkdir(join(root, "docket", "work", "tasks"), { recursive: true });
  await writeFile(join(root, "docket.yaml"), "project: DKT\nbundle: docket/\n");
  for (const id of ["DKT-1", "DKT-2"]) {
    await writeFile(
      join(root, "docket", "work", "tasks", `${id}-task.md`),
      `---\ntype: Task\ntitle: ${id}\nid: ${id}\nstatus: todo\n---\n`,
    );
  }
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  const config = parseConfig("project: DKT\nbundle: docket/\n");
  return {
    parent,
    root,
    bundle: await loadBundle(new LocalFileStore(join(root, "docket")), config),
  };
}

function addWorktree(
  root: string,
  parent: string,
  name: string,
  detached = false,
): string {
  const path = join(parent, name);
  if (detached) git(root, "worktree", "add", "-q", "--detach", path, "HEAD");
  else git(root, "worktree", "add", "-q", "-b", name, path, "HEAD");
  return path;
}

function taskCommit(
  worktree: string,
  filename: string,
  taskId: string,
  subject: string,
): string {
  writeFileSync(join(worktree, filename), `${subject}\n`);
  git(worktree, "add", filename);
  git(worktree, "commit", "-qm", `${subject}\n\nTask: ${taskId}`);
  return git(worktree, "rev-parse", "HEAD");
}

for (const mode of ["sync", "async"] as const)
  describe(`${mode} Git evidence`, () => {
    async function scan(...args: Parameters<typeof scanGitEvidence>) {
      if (mode === "sync") return scanGitEvidence(...args);
      const index = new GitEvidenceIndex(args[0], args[1], args[3]);
      try {
        return (await index.snapshot(args[2])).git;
      } finally {
        index.close();
      }
    }
    test("deduplicates pinned local refs while retaining ref and worktree provenance", async () => {
      const { parent, root, bundle } = await fixture();
      const first = addWorktree(root, parent, "feature-a");
      const firstSha = taskCommit(first, "feature-a.txt", "DKT-1", "feature a");
      git(root, "branch", "feature-a-alias", firstSha);

      const second = addWorktree(root, parent, "feature-b");
      const secondSha = taskCommit(
        second,
        "feature-b.txt",
        "DKT-2",
        "feature b",
      );

      const detached = addWorktree(root, parent, "detached", true);
      const detachedPath = realpathSync(detached);
      const detachedSha = taskCommit(
        detached,
        "detached.txt",
        "DKT-1",
        "detached work",
      );
      await mkdir(join(detached, ".docket"), { recursive: true });
      await writeFile(join(detached, ".docket", "active-task"), "DKT-1\n");
      await writeFile(join(detached, "dirty.txt"), "not committed\n");

      const evidence = await scan(root, "Task", bundle.byId, {
        afterInventory: () => {
          // The observation is pinned to immutable SHAs before these names and
          // paths disappear, so the scan can finish without rereading either.
          git(root, "update-ref", "-d", "refs/heads/feature-a-alias");
          rmSync(detached, { recursive: true, force: true });
        },
      });

      expect(evidence.status).toBe("available");
      expect(evidence.checkpoint?.revision).toBe(
        git(root, "rev-parse", "HEAD"),
      );
      expect(evidence.unmergedActivity).toHaveLength(3);
      const firstObservation = evidence.unmergedActivity.find(
        (entry) => entry.sha === firstSha,
      );
      expect(firstObservation).toMatchObject({
        taskId: "DKT-1",
        mergedIntoCurrentHead: false,
      });
      expect(firstObservation?.refs).toEqual([
        "refs/heads/feature-a",
        "refs/heads/feature-a-alias",
      ]);
      expect(firstObservation?.worktrees).toEqual([realpathSync(first)]);
      expect(
        evidence.unmergedActivity.find((entry) => entry.sha === secondSha)
          ?.refs,
      ).toContain("refs/heads/feature-b");
      expect(
        evidence.unmergedActivity.find((entry) => entry.sha === detachedSha)
          ?.worktrees,
      ).toEqual([detachedPath]);

      const detachedEvidence = evidence.worktrees.find(
        (worktree) => worktree.path === detachedPath,
      );
      expect(detachedEvidence).toMatchObject({
        ref: null,
        activeTaskId: "DKT-1",
        dirty: true,
        mergedIntoCurrentHead: false,
        available: true,
      });
      expect(
        evidence.unmergedActivity.some((entry) => entry.mergedIntoCurrentHead),
      ).toBeFalse();
      expect(bundle.byId("DKT-1")?.fm.status).toBe("todo");
    });

    test("bounds the representation and needs no remote", async () => {
      const { parent, root, bundle } = await fixture();
      taskCommit(root, "main-one.txt", "DKT-1", "main one");
      taskCommit(root, "main-two.txt", "DKT-2", "main two");
      const first = addWorktree(root, parent, "one");
      taskCommit(first, "one.txt", "DKT-1", "one");
      const second = addWorktree(root, parent, "two");
      taskCommit(second, "two.txt", "DKT-2", "two");

      expect(git(root, "remote")).toBe("");
      const evidence = await scan(root, "Task", bundle.byId, {
        commitLimit: 1,
      });
      expect(evidence.status).toBe("available");
      expect(evidence.activity).toHaveLength(1);
      expect(evidence.unmergedActivity).toHaveLength(1);
      expect(evidence.truncated).toBeTrue();
    });

    test("returns an explicit history-unavailable state outside Git", async () => {
      const parent = await mkdtemp(join(tmpdir(), "docket-no-git-evidence-"));
      temporaryRoots.push(parent);
      const evidence = await scan(resolve(parent), "Task", () => undefined);
      expect(evidence).toMatchObject({
        status: "history-unavailable",
        checkpoint: null,
        activity: [],
        unmergedActivity: [],
        worktrees: [],
        truncated: false,
      });
    });
  });

describe("GitEvidenceIndex", () => {
  test("aggregate observation budgets select deterministically across many task trailers", async () => {
    const { root, parent, bundle } = await fixture();
    for (let branch = 0; branch < 2; branch++) {
      const worktree = addWorktree(root, parent, `many-${branch}`);
      const trailers = Array.from(
        { length: 1500 },
        (_, i) => `Task: DKT-${branch * 1500 + i + 1}`,
      ).join("\n");
      git(
        worktree,
        "commit",
        "--allow-empty",
        "-qm",
        `many rows ${branch}\n\n${trailers}`,
      );
    }
    const serial = new GitEvidenceIndex(root, "Task", {
      concurrency: 1,
      commitLimit: 3000,
    });
    const concurrent = new GitEvidenceIndex(root, "Task", {
      concurrency: 4,
      commitLimit: 3000,
    });
    try {
      const first = await serial.snapshot(bundle.byId);
      const second = await concurrent.snapshot(bundle.byId);
      expect(first.git.unmergedActivity).toHaveLength(2000);
      expect(first.git.truncated).toBeTrue();
      // Observation times describe distinct captures; semantic selection stays deterministic.
      if (first.git.taskProgress && second?.git.taskProgress)
        second.git.taskProgress.observedAt = first.git.taskProgress.observedAt;
      expect(second).toEqual(first);
    } finally {
      serial.close();
      concurrent.close();
    }
  });
  test("process timeouts recover and close drains active and queued reads", async () => {
    const { root } = await fixture();
    const pool = new GitProcessPool({ timeoutMs: 100, concurrency: 1 });
    await expect(
      pool.run(root, ["-c", "alias.pause=!exec sleep 10", "pause"]),
    ).rejects.toThrow("timed out");
    expect((await pool.run(root, ["rev-parse", "HEAD"])).trim()).toBe(
      git(root, "rev-parse", "HEAD"),
    );
    const reads = [
      pool.run(root, ["-c", "alias.pause=!exec sleep 10", "pause"]),
      pool.run(root, ["rev-parse", "HEAD"]),
      pool.run(root, ["rev-parse", "HEAD"]),
    ];
    pool.close();
    const results = await Promise.allSettled(reads);
    expect(results.every((result) => result.status === "rejected")).toBeTrue();
  });
  test("control characters in subjects cannot fabricate task IDs or records", async () => {
    const { root, bundle } = await fixture();
    git(
      root,
      "commit",
      "--allow-empty",
      "-qm",
      "subject\x1fwith\x1eseparators\n\nTask: DKT-1",
    );
    const index = new GitEvidenceIndex(root, "Task");
    try {
      const result = await index.snapshot(bundle.byId);
      expect(result.activity).toHaveLength(1);
      expect(result.activity[0]).toMatchObject({
        taskId: "DKT-1",
        subject: "subject\x1fwith\x1eseparators",
      });
    } finally {
      index.close();
    }
  });
  test("invalidation during capture retries for both existing and later waiters", async () => {
    const { root, bundle } = await fixture();
    let later:
      | Promise<Awaited<ReturnType<GitEvidenceIndex["snapshot"]>>>
      | undefined;
    let changed = false;
    const index = new GitEvidenceIndex(root, "Task", {
      afterInventory: () => {
        if (changed) return;
        changed = true;
        git(
          root,
          "commit",
          "--allow-empty",
          "-qm",
          "new generation\n\nTask: DKT-1",
        );
        index.invalidate();
        later = index.snapshot(bundle.byId);
      },
    });
    try {
      const first = await index.snapshot(bundle.byId);
      const second = await later;
      expect(first.activity).toHaveLength(1);
      // Observation times describe distinct captures; semantic selection stays deterministic.
      if (first.git.taskProgress && second?.git.taskProgress)
        second.git.taskProgress.observedAt = first.git.taskProgress.observedAt;
      expect(second).toEqual(first);
      expect(first.git.checkpoint?.revision).toBe(
        git(root, "rev-parse", "HEAD"),
      );
    } finally {
      index.close();
    }
  });

  test("supplemental inventory failures preserve successfully read canonical history and retry", async () => {
    const { root, bundle } = await fixture();
    taskCommit(root, "one", "DKT-1", "one");
    let fail = true;
    const index = new GitEvidenceIndex(root, "Task", {
      ttlMs: 0,
      onCommand: (args) => {
        if (fail && args[0] === "worktree")
          throw new Error("inventory probe failure");
      },
    });
    try {
      const result = await index.snapshot(bundle.byId);
      expect(result.activity).toHaveLength(1);
      expect(result.git).toMatchObject({
        status: "available",
        historyComplete: true,
        truncated: true,
      });
      expect(result.git.reason).toContain("Worktree inventory unavailable");
      fail = false;
      const recovered = await index.snapshot(bundle.byId);
      expect(recovered.git.worktrees).toHaveLength(1);
      expect(recovered.git.reason).toBeUndefined();
    } finally {
      index.close();
    }
  });

  test("shares concurrent scans, reuses immutable history and refreshes mutable facts without a bundle event", async () => {
    const { root, bundle } = await fixture();
    taskCommit(root, "one", "OLD-1", "one");
    const commands: string[][] = [];
    const index = new GitEvidenceIndex(root, "Task", {
      ttlMs: 60000,
      onCommand: (args) => commands.push(args),
    });
    try {
      const [first, second] = await Promise.all([
        index.snapshot(bundle.byId),
        index.snapshot(bundle.byId),
      ]);
      expect(first).toEqual(second);
      expect(commands.filter((args) => args[0] === "log")).toHaveLength(1);
      commands.length = 0;
      const aliased = await index.snapshot((id) =>
        id === "OLD-1" ? bundle.byId("DKT-2") : bundle.byId(id),
      );
      expect(aliased.activity[0]?.taskId).toBe("DKT-2");
      expect(commands).toHaveLength(0);
      await mkdir(join(root, ".docket"), { recursive: true });
      await writeFile(join(root, ".docket", "active-task"), "DKT-2\n");
      index.invalidate();
      const refreshed = await index.snapshot(bundle.byId);
      expect(refreshed.git.worktrees[0]).toMatchObject({
        activeTaskId: "DKT-2",
        dirty: true,
        current: true,
      });
      expect(commands.filter((args) => args[0] === "log")).toHaveLength(0);
      taskCommit(root, "two", "DKT-2", "two");
      index.invalidate();
      expect((await index.snapshot(bundle.byId)).activity).toHaveLength(2);
      expect(commands.filter((args) => args[0] === "log")).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  test("keeps full canonical rows separate from the preview and counts distinct commits at a pinned HEAD", async () => {
    const { root, bundle } = await fixture();
    const base = git(root, "rev-parse", "HEAD");
    for (let i = 0; i < 55; i++)
      git(
        root,
        "commit",
        "--allow-empty",
        "-qm",
        `entry ${i}\n\nTask: DKT-1\nTask: DKT-2`,
      );
    const index = new GitEvidenceIndex(root, "Task");
    try {
      const result = await index.snapshot(bundle.byId);
      expect(result.activity).toHaveLength(110);
      expect(result.git.activity).toHaveLength(50);
      expect(result.git.historyComplete).toBeTrue();
      git(root, "commit", "--allow-empty", "-qm", "later\n\nTask: DKT-1");
      expect(await index.countSince(base, result.git.checkpoint)).toBe(55);
      expect(
        await index.countSince("bad watermark", result.git.checkpoint),
      ).toBeUndefined();
    } finally {
      index.close();
    }
  });

  test("caps inventories before status fan-out and counts trailerless commits against history budgets", async () => {
    const { parent, root, bundle } = await fixture();
    for (let i = 0; i < 5; i++) addWorktree(root, parent, `side-${i}`);
    for (let i = 0; i < 4; i++)
      git(root, "commit", "--allow-empty", "-qm", `no trailer ${i}`);
    const commands: string[][] = [];
    const index = new GitEvidenceIndex(root, "Task", {
      worktreeLimit: 2,
      refLimit: 2,
      historyLimit: 2,
      onCommand: (args) => commands.push(args),
    });
    try {
      const { git: result } = await index.snapshot(bundle.byId);
      expect(result.worktrees).toHaveLength(2);
      expect(result.worktrees.some((worktree) => worktree.current)).toBeTrue();
      expect(commands.filter((args) => args[0] === "status")).toHaveLength(2);
      expect(result.historyComplete).toBeFalse();
      expect(result.truncated).toBeTrue();
      expect(result.reason).toContain("exceeds 2 inspected commits");
    } finally {
      index.close();
    }
  });

  test("deepening a shallow repository invalidates history with unchanged HEAD", async () => {
    const { parent, root, bundle } = await fixture();
    for (let i = 0; i < 4; i++)
      git(root, "commit", "--allow-empty", "-qm", `entry ${i}\n\nTask: DKT-1`);
    const clone = join(parent, "shallow");
    git(parent, "clone", "-q", "--depth=1", `file://${root}`, clone);
    const index = new GitEvidenceIndex(clone, "Task", { ttlMs: 0 });
    try {
      const first = await index.snapshot(bundle.byId);
      expect(first.activity).toHaveLength(1);
      expect(first.git.historyComplete).toBeFalse();
      expect(first.git.reason).toContain("Shallow checkout");
      git(clone, "fetch", "-q", "--unshallow");
      const second = await index.snapshot(bundle.byId);
      expect(second.git.checkpoint).toEqual(first.git.checkpoint);
      expect(second.activity).toHaveLength(4);
      expect(second.git.historyComplete).toBeTrue();
    } finally {
      index.close();
    }
  });

  test("byte-budget failures are explicit and close cancels in-flight and future requests", async () => {
    const { root, bundle } = await fixture();
    const small = new GitEvidenceIndex(root, "Task", { maxBytes: 1 });
    const result = await small.snapshot(bundle.byId);
    expect(result.git.status).toBe("history-unavailable");
    expect(result.git.reason).toContain("byte budget");
    small.close();
    const index = new GitEvidenceIndex(root, "Task");
    const pending = index.snapshot(bundle.byId);
    index.close();
    await expect(pending).rejects.toThrow("closed");
    await expect(index.snapshot(bundle.byId)).rejects.toThrow("closed");
  });
});
