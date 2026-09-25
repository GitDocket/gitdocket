import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseConfig } from "./config";
import { LocalFileStore } from "./filestore";
import { GitWorktreeIdCoordinator } from "./id-allocation";
import { createWorkItem } from "./ops";

const CLI = join(import.meta.dir, "../../cli/src/index.ts");
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
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString().trim();
}

async function repository(
  project = "TST",
  bundle = "docket/",
): Promise<{ root: string; config: ReturnType<typeof parseConfig> }> {
  const parent = await mkdtemp(join(tmpdir(), "docket-id-allocation-"));
  temporaryRoots.push(parent);
  const root = join(parent, "main");
  await mkdir(join(root, bundle, "work", "tasks"), { recursive: true });
  await writeFile(
    join(root, "docket.yaml"),
    `project: ${project}\nbundle: ${bundle}\n`,
  );
  await writeFile(
    join(root, bundle, "work", "tasks", `${project}-1-baseline.md`),
    `---\ntype: Task\ntitle: Baseline\nid: ${project}-1\nstatus: todo\n---\n`,
  );
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  return {
    root,
    config: parseConfig(`project: ${project}\nbundle: ${bundle}\n`),
  };
}

function addWorktree(root: string, name: string, detached = false): string {
  const path = join(resolve(root, ".."), name);
  if (detached) git(root, "worktree", "add", "-q", "--detach", path, "HEAD");
  else git(root, "worktree", "add", "-q", "-b", name, path, "HEAD");
  return path;
}

async function runCreate(
  cwd: string,
  title: string,
  kind = "task",
  extra: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      CLI,
      kind,
      "create",
      "--title",
      title,
      "--json",
      ...extra,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("GitWorktreeIdCoordinator", () => {
  test("batches at most sixteen ID reads and retains the earliest-path failure", async () => {
    const { root } = await repository();
    const directory = join(root, "docket", "work", "tasks");
    for (let i = 0; i < 32; i++)
      await writeFile(
        join(directory, `z-${String(i).padStart(2, "0")}.md`),
        `---\ntype: Task\nid: TST-${i + 2}\n---\n`,
      );
    const original = LocalFileStore.prototype.read;
    let active = 0,
      maximum = 0;
    const reads: string[] = [];
    LocalFileStore.prototype.read = async function (path) {
      reads.push(path);
      maximum = Math.max(maximum, ++active);
      try {
        await Bun.sleep(2);
        if (path.endsWith("b-error.md")) throw new Error("later read failure");
        return await original.call(this, path);
      } finally {
        active--;
      }
    };
    try {
      const coordinator = new GitWorktreeIdCoordinator(root);
      const ids = await coordinator.allocate("TST", async (ids) => [...ids]);
      expect(ids).toHaveLength(33);
      expect(maximum).toBe(16);
      expect(reads).toHaveLength(33);
      await writeFile(
        join(directory, "a-invalid.md"),
        "---\ntype: Task\n---\n",
      );
      await writeFile(
        join(directory, "b-error.md"),
        "---\ntype: Task\nid: TST-100\n---\n",
      );
      reads.length = 0;
      let created = false;
      await expect(
        coordinator.allocate("TST", async () => {
          created = true;
        }),
      ).rejects.toThrow("a-invalid.md has no readable frontmatter id");
      expect(created).toBe(false);
      expect(reads).toHaveLength(16);
      expect(reads.some((path) => path.endsWith("z-13.md"))).toBe(false);
      expect(active).toBe(0);
    } finally {
      LocalFileStore.prototype.read = original;
    }
  });

  test("serializes simultaneous CLI creates across linked worktree processes", async () => {
    const { root } = await repository();
    const first = addWorktree(root, "worker-a");
    const second = addWorktree(root, "worker-b");

    const results = await Promise.all([
      runCreate(first, "First concurrent item"),
      runCreate(second, "Second concurrent item"),
    ]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    const ids = results
      .map((result) => JSON.parse(result.stdout).id as string)
      .sort();
    expect(ids).toEqual(["TST-2", "TST-3"]);
  });

  test("includes uncommitted detached-worktree items and custom bundle settings", async () => {
    const { root, config } = await repository("ACME", "tracker/");
    const detached = addWorktree(root, "detached", true);
    const tasks = join(detached, "tracker", "work", "tasks");
    await writeFile(
      join(tasks, "ACME-7-tracked.md"),
      "---\ntype: Task\ntitle: Tracked\nid: ACME-7\nstatus: todo\n---\n",
    );
    git(detached, "add", ".");
    git(detached, "commit", "-qm", "detached baseline");
    await writeFile(
      join(tasks, "ACME-7-tracked.md"),
      "---\ntype: Task\ntitle: Tracked and modified\nid: ACME-7\nstatus: todo\n---\n",
    );
    await writeFile(
      join(tasks, "ACME-6-staged.md"),
      "---\ntype: Task\ntitle: Staged\nid: ACME-6\nstatus: todo\n---\n",
    );
    git(detached, "add", "tracker/work/tasks/ACME-6-staged.md");
    await writeFile(
      join(tasks, "ACME-8-local.md"),
      "---\ntype: Task\ntitle: Local\nid: ACME-8\nstatus: todo\n---\n",
    );

    const result = await createWorkItem(
      new LocalFileStore(join(root, config.bundle)),
      config,
      { title: "After detached item" },
      new GitWorktreeIdCoordinator(root),
    );
    expect(result.id).toBe("ACME-9");
  });

  test("reserves readable IDs in malformed sibling concepts and rejects unreadable ones", async () => {
    const { root, config } = await repository();
    const sibling = addWorktree(root, "malformed");
    const siblingTasks = join(sibling, config.bundle, "work", "tasks");
    await writeFile(
      join(siblingTasks, "TST-40-malformed.md"),
      "---\ntype: Task\ntitle: [broken\nid: TST-40\nstatus: todo\n---\n",
    );

    const store = new LocalFileStore(join(root, config.bundle));
    const coordinator = new GitWorktreeIdCoordinator(root);
    expect(
      await createWorkItem(store, config, { title: "Safe next" }, coordinator),
    ).toMatchObject({ id: "TST-41" });

    await writeFile(
      join(siblingTasks, "missing-id.md"),
      "---\ntype: Task\ntitle: Missing id\nstatus: todo\n---\n",
    );
    await expect(
      createWorkItem(store, config, { title: "Must refuse" }, coordinator),
    ).rejects.toThrow("has no readable frontmatter id");
  });

  test("recovers an interrupted lock whose local owner is gone", async () => {
    const { root, config } = await repository();
    const rawCommon = git(root, "rev-parse", "--git-common-dir");
    const common = isAbsolute(rawCommon) ? rawCommon : resolve(root, rawCommon);
    const lock = join(common, "docket", "id-allocation.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, host: hostname() })}\n`,
    );

    const result = await createWorkItem(
      new LocalFileStore(join(root, config.bundle)),
      config,
      { title: "Recovered" },
      new GitWorktreeIdCoordinator(root, {
        lockTimeoutMs: 100,
        retryDelayMs: 1,
      }),
    );
    expect(result.id).toBe("TST-2");
    await expect(readFile(join(lock, "owner.json"), "utf8")).rejects.toThrow();
  });

  test("fails explicitly when a registered linked worktree disappears", async () => {
    const { root, config } = await repository();
    const vanished = addWorktree(root, "vanished");
    await rm(vanished, { recursive: true, force: true });

    await expect(
      createWorkItem(
        new LocalFileStore(join(root, config.bundle)),
        config,
        { title: "Unsafe while inventory is stale" },
        new GitWorktreeIdCoordinator(root),
      ),
    ).rejects.toThrow("linked worktree disappeared");
  });

  test("keeps deterministic max+1 behavior outside Git", async () => {
    const parent = await mkdtemp(join(tmpdir(), "docket-id-filesystem-"));
    temporaryRoots.push(parent);
    const config = parseConfig("project: FS\nbundle: tracker/\n");
    await mkdir(join(parent, "tracker", "work", "tasks"), { recursive: true });
    await writeFile(
      join(parent, "tracker", "work", "tasks", "FS-7-existing.md"),
      "---\ntype: Task\ntitle: Existing\nid: FS-7\nstatus: todo\n---\n",
    );
    const result = await createWorkItem(
      new LocalFileStore(join(parent, config.bundle)),
      config,
      { title: "Filesystem only" },
      new GitWorktreeIdCoordinator(parent),
    );
    expect(result.id).toBe("FS-8");
  });
});

test("Decision CLI processes coordinate historical and quoted aliases across custom detached worktrees", async () => {
  const { root } = await repository("TST", "knowledge/");
  const sibling = addWorktree(root, "decision-sibling", true);
  await mkdir(join(sibling, "knowledge/reference"), { recursive: true });
  await writeFile(
    join(sibling, "knowledge/reference/choice.md"),
    `---
"type": Decision
"id": DEC-3
"aliases":
  - DEC-9
---

Historical accepted choice.
`,
  );
  await writeFile(
    join(sibling, "knowledge/reference/generic.md"),
    `---
type: Reference
broken: [
---
`,
  );
  await mkdir(join(root, ".docket"), { recursive: true });
  await writeFile(join(root, ".docket/active-task"), "TST-1\n");
  const results = await Promise.all([
    runCreate(root, "First choice", "decision"),
    runCreate(sibling, "Second choice", "decision"),
  ]);
  for (const result of results) expect(result.code).toBe(0);
  expect(results.map((r) => JSON.parse(r.stdout).id).sort()).toEqual([
    "DEC-10",
    "DEC-11",
  ]);
  expect((await runCreate(root, "Work")).code).toBe(0);
  expect(JSON.parse((await runCreate(root, "Next work")).stdout).id).toBe(
    "TST-3",
  );
  const before = await readFile(join(root, ".docket/active-task"), "utf8");
  const invalid = await runCreate(root, "Not a work type", "task", [
    "--type",
    "Decision",
  ]);
  expect(invalid.code).not.toBe(0);
  expect(invalid.stderr).toContain("unsupported work type");
  expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
    before,
  );
  const store = new LocalFileStore(join(root, "knowledge"));
  expect((await store.list()).some((p) => p.includes("project-guidance"))).toBe(
    false,
  );
});

test("same-prefix concurrent CLI Decision and Task creation share reservations", async () => {
  const { root } = await repository("DEC");
  const sibling = addWorktree(root, "same-prefix");
  const results = await Promise.all([
    runCreate(root, "Choice", "decision"),
    runCreate(sibling, "Work"),
  ]);
  for (const result of results) expect(result.code).toBe(0);
  expect(results.map((r) => JSON.parse(r.stdout).id).sort()).toEqual([
    "DEC-2",
    "DEC-3",
  ]);
});
