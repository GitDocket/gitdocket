import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBundle } from "./bundle";
import { scanGitEvidence } from "./cache";
import { parseConfig } from "./config";
import { LocalFileStore } from "./filestore";

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

describe("scanGitEvidence", () => {
  test("deduplicates pinned local refs while retaining ref and worktree provenance", async () => {
    const { parent, root, bundle } = await fixture();
    const first = addWorktree(root, parent, "feature-a");
    const firstSha = taskCommit(first, "feature-a.txt", "DKT-1", "feature a");
    git(root, "branch", "feature-a-alias", firstSha);

    const second = addWorktree(root, parent, "feature-b");
    const secondSha = taskCommit(second, "feature-b.txt", "DKT-2", "feature b");

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

    const evidence = scanGitEvidence(root, "Task", bundle.byId, {
      afterInventory: () => {
        // The observation is pinned to immutable SHAs before these names and
        // paths disappear, so the scan can finish without rereading either.
        git(root, "update-ref", "-d", "refs/heads/feature-a-alias");
        rmSync(detached, { recursive: true, force: true });
      },
    });

    expect(evidence.status).toBe("available");
    expect(evidence.checkpoint?.revision).toBe(git(root, "rev-parse", "HEAD"));
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
      evidence.unmergedActivity.find((entry) => entry.sha === secondSha)?.refs,
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
    const evidence = scanGitEvidence(root, "Task", bundle.byId, {
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
    const evidence = scanGitEvidence(resolve(parent), "Task", () => undefined);
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
