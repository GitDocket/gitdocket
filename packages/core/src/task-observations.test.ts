import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { LocalFileStore } from "./filestore";
import { GitEvidenceIndex } from "./git-evidence-index";

const roots: string[] = [];
const owners: GitEvidenceIndex[] = [];
afterEach(() => {
  for (const o of owners.splice(0)) o.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
const taskPath = "work/tasks/item.md";
function write(
  root: string,
  status: string,
  id = "DKT-1",
  path = taskPath,
  bundle = "docket",
) {
  const p = join(root, bundle, path);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(
    p,
    `---\ntype: Task\nid: ${id}\ntitle: Example\nstatus: ${status}\n---\n`,
  );
}
function setup(status = "todo", bundle = "docket") {
  const parent = mkdtempSync(join(tmpdir(), "docket-observation-"));
  roots.push(parent);
  const root = join(parent, "main");
  mkdirSync(root);
  write(root, status, "DKT-1", taskPath, bundle);
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const worker = join(parent, "worker");
  git(root, "worktree", "add", "-qb", "feature", worker);
  const owner = new GitEvidenceIndex(root, "Task", {
    ttlMs: 0,
    bundlePath: bundle,
  });
  owners.push(owner);
  const scan = async () => {
    const b = await loadBundle(
      new LocalFileStore(join(root, bundle)),
      parseConfig(`bundle: ${bundle}`),
    );
    return (await owner.snapshot(b.byId)).git.taskProgress;
  };
  return { parent, root, worker, scan };
}
test("saved uncommitted worktree state is observed without modifying canonical state", async () => {
  const { root, worker, scan } = setup();
  write(worker, "in-progress");
  mkdirSync(join(worker, ".docket"));
  writeFileSync(join(worker, ".docket/active-task"), "DKT-1");
  const before = git(root, "status", "--porcelain");
  const result = await scan();
  expect(result?.complete).toBe(true);
  expect(result?.tasks[0]).toMatchObject({
    id: "DKT-1",
    localStatus: "todo",
    pickedUpElsewhere: true,
    state: "observed",
  });
  expect(result?.tasks[0]?.observations[0]).toMatchObject({
    uncommitted: true,
    integrated: false,
    task: { status: "in-progress" },
  });
  expect(git(root, "status", "--porcelain")).toBe(before);
});
test("committed branch fallback survives worktree removal and alias refs deduplicate", async () => {
  const { root, worker, scan } = setup();
  write(worker, "done");
  git(worker, "add", ".");
  git(worker, "commit", "-qm", "done");
  git(root, "branch", "alias", "feature");
  git(root, "worktree", "remove", worker);
  const result = await scan();
  expect(result?.tasks).toHaveLength(1);
  expect(result?.tasks[0]?.observations).toHaveLength(1);
  expect(result?.tasks[0]?.observations[0]).toMatchObject({
    worktree: null,
    integrated: false,
    refs: ["refs/heads/alias", "refs/heads/feature"],
  });
  git(root, "merge", "--ff-only", "feature");
  expect((await scan())?.tasks).toHaveLength(0);
});
test("stale inherited closed state does not mask an intentional reopening", async () => {
  const { root, worker, scan } = setup("closed");
  write(root, "todo");
  git(root, "add", ".");
  git(root, "commit", "-qm", "reopen");
  writeFileSync(join(worker, "other"), "change");
  git(worker, "add", ".");
  git(worker, "commit", "-qm", "unrelated");
  expect((await scan())?.tasks).toHaveLength(0);
});
test("independent divergent status changes are explicit conflicts", async () => {
  const { root, worker, scan } = setup();
  write(root, "blocked");
  write(worker, "done");
  const result = await scan();
  expect(result?.tasks[0]?.state).toBe("conflict");
  expect(result?.tasks[0]?.localStatus).toBe("blocked");
});
test("foreign-only tasks, detached checkouts and custom bundle paths are supported", async () => {
  const { root, worker, scan } = setup("todo", "knowledge");
  git(worker, "checkout", "--detach");
  write(worker, "in-progress", "DKT-2", "custom/new.md", "knowledge");
  const result = await scan();
  expect(result?.tasks[0]).toMatchObject({ id: "DKT-2", localStatus: null });
  expect(result?.tasks[0]?.observations[0]?.refs).toContain(
    "refs/heads/feature",
  );
  expect(git(root, "status", "--porcelain")).toBe("");
});
test("invalid and removed files produce partial evidence rather than an empty success", async () => {
  const { worker, scan } = setup();
  writeFileSync(
    join(worker, "docket", taskPath),
    "---\ntype: Task\nstatus: impossible\n---\n",
  );
  expect((await scan())?.complete).toBe(false);
  rmSync(join(worker, "docket", taskPath));
  expect((await scan())?.complete).toBe(false);
});
test("multiple pickups and different foreign statuses remain explicit", async () => {
  const { root, worker, parent, scan } = setup();
  const other = join(parent, "second");
  git(root, "worktree", "add", "-qb", "second", other);
  for (const w of [worker, other]) {
    write(w, "in-progress");
    mkdirSync(join(w, ".docket"));
    writeFileSync(join(w, ".docket/active-task"), "DKT-1");
  }
  expect((await scan())?.tasks[0]?.state).toBe("conflict");
});

test("a current and foreign pickup of the same ID is a conflict", async () => {
  const { root, worker, scan } = setup();
  for (const w of [root, worker]) {
    mkdirSync(join(w, ".docket"));
    writeFileSync(join(w, ".docket/active-task"), "DKT-1");
  }
  expect((await scan())?.tasks[0]?.state).toBe("conflict");
});

test("an unreadable task keeps its pickup visible with unavailable state", async () => {
  const { worker, scan } = setup();
  mkdirSync(join(worker, ".docket"));
  writeFileSync(join(worker, ".docket/active-task"), "DKT-1");
  rmSync(join(worker, "docket", taskPath));
  const result = await scan();
  expect(result?.complete).toBe(false);
  expect(result?.tasks[0]).toMatchObject({
    id: "DKT-1",
    pickedUpElsewhere: true,
    state: "unavailable",
  });
});

test("squash integration is conservatively uncertain even when local status matches", async () => {
  const { root, worker, scan } = setup();
  write(worker, "done");
  writeFileSync(join(worker, "feature.txt"), "implementation");
  git(worker, "add", ".");
  git(worker, "commit", "-qm", "feature");
  git(root, "merge", "--squash", "feature");
  git(root, "commit", "-qm", "squashed");
  const result = await scan();
  expect(result?.tasks[0]?.localStatus).toBe("done");
  expect(result?.tasks[0]?.observations[0]?.integrated).toBe(false);
});

test("duplicate IDs at different paths remain conflicts instead of replacing local identity", async () => {
  const { worker, scan } = setup();
  write(worker, "in-progress", "DKT-1", "work/tasks/duplicate.md");
  expect((await scan())?.tasks[0]?.state).toBe("conflict");
});

test("candidate limits are explicit and never admit unlimited untracked tasks", async () => {
  const { worker, scan } = setup();
  for (let i = 2; i < 516; i++)
    write(worker, "todo", `DKT-${i}`, `work/tasks/new-${i}.md`);
  const result = await scan();
  expect(result?.complete).toBe(false);
  expect(result?.observations.length).toBeLessThanOrEqual(512);
  expect(result?.diagnostics.join(" ")).toContain("budget");
}, 20000);

test("moving a source HEAD during inventory does not misattribute saved state", async () => {
  const { root, worker } = setup();
  write(worker, "in-progress");
  const bundle = await loadBundle(
    new LocalFileStore(join(root, "docket")),
    parseConfig(),
  );
  let moved = false;
  const owner = new GitEvidenceIndex(root, "Task", {
    afterInventory: () => {
      if (!moved) {
        moved = true;
        git(worker, "add", ".");
        git(worker, "commit", "-qm", "concurrent move");
      }
    },
  });
  owners.push(owner);
  const result = (await owner.snapshot(bundle.byId)).git.taskProgress;
  expect(result?.complete).toBe(false);
  expect(result?.diagnostics.join(" ")).toContain("HEAD changed");
});
