import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
function setup(status = "todo", bundle = "docket", project?: string) {
  const parent = mkdtempSync(join(tmpdir(), "docket-observation-"));
  roots.push(parent);
  const root = join(parent, "main");
  mkdirSync(root);
  write(root, status, `${project ?? "DKT"}-1`, taskPath, bundle);
  if (project)
    writeFileSync(
      join(root, "docket.yaml"),
      `project: ${project}\nbundle: ${bundle}\n`,
    );
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
      parseConfig(
        existsSync(join(root, "docket.yaml"))
          ? readFileSync(join(root, "docket.yaml"), "utf8")
          : `bundle: ${bundle}`,
      ),
    );
    return (await owner.snapshot(b.byId)).git.taskProgress;
  };
  return { parent, root, worker, scan };
}

for (const prefix of ["RS", "FLOW_APP"]) {
  test(`${prefix} saved, untracked and committed task metadata uses source and baseline schemas`, async () => {
    const { root, worker, scan } = setup("todo", "knowledge", prefix);
    git(worker, "checkout", "--detach");
    write(worker, "in-progress", `${prefix}-1`, taskPath, "knowledge");
    write(worker, "todo", `${prefix}-2`, "work/tasks/new.md", "knowledge");
    const before = git(root, "status", "--porcelain");
    const saved = await scan();
    expect(saved?.complete).toBe(true);
    expect(saved?.tasks.map((t) => t.id)).toEqual([
      `${prefix}-1`,
      `${prefix}-2`,
    ]);
    expect(saved?.tasks[0]?.observations[0]).toMatchObject({
      task: { id: `${prefix}-1`, status: "in-progress" },
      base: { id: `${prefix}-1`, status: "todo" },
      configuration: {
        source: { project: prefix, origin: "saved" },
        baseline: { project: prefix, origin: "committed" },
        compatible: true,
      },
      uncommitted: true,
      integrated: false,
    });
    expect(git(root, "status", "--porcelain")).toBe(before);
    git(worker, "add", ".");
    git(worker, "commit", "-qm", "custom prefix progress");
    git(root, "branch", "custom-tip", git(worker, "rev-parse", "HEAD"));
    git(root, "worktree", "remove", worker);
    const committed = await scan();
    expect(committed?.complete).toBe(true);
    expect(committed?.tasks[0]?.observations[0]).toMatchObject({
      worktree: null,
      uncommitted: false,
      configuration: { source: { origin: "committed", project: prefix } },
    });
    git(root, "merge", "--ff-only", "custom-tip");
    expect((await scan())?.tasks).toHaveLength(0);
  });
}

test("changed project configurations are interpreted independently and incompatible identities stay visible", async () => {
  const { worker, scan } = setup("todo", "docket", "RS");
  writeFileSync(join(worker, "docket.yaml"), "project: ALT\nbundle: docket\n");
  write(worker, "in-progress", "ALT-1");
  const result = await scan();
  expect(result?.complete).toBe(true);
  expect(result?.tasks[0]).toMatchObject({
    id: "ALT-1",
    state: "conflict",
    observations: [
      {
        base: { id: "RS-1" },
        configuration: {
          source: { project: "ALT" },
          baseline: { project: "RS" },
          compatible: false,
        },
      },
    ],
  });
});

test("repeated reads refresh configuration instead of accepting cached incompatible metadata", async () => {
  const { worker, scan } = setup("todo", "docket", "RS");
  write(worker, "in-progress", "RS-1");
  expect((await scan())?.complete).toBe(true);
  writeFileSync(join(worker, "docket.yaml"), "project: ALT\nbundle: docket\n");
  const invalid = await scan();
  expect(invalid?.complete).toBe(false);
  expect(invalid?.diagnostics.join(" ")).toContain("Invalid task metadata");
  writeFileSync(join(worker, "docket.yaml"), "project: RS\nbundle: docket\n");
  expect((await scan())?.tasks[0]?.id).toBe("RS-1");
  write(worker, "in-progress", "DKT-1");
  expect((await scan())?.complete).toBe(false);
  writeFileSync(
    join(worker, "docket", taskPath),
    "---\ntype: 'Task'\nid: DKT-1\nstatus: in-progress\n---\n",
  );
  expect((await scan())?.complete).toBe(false);
});

test("missing configuration declares defaults and malformed configuration never substitutes defaults", async () => {
  const { worker, scan } = setup();
  write(worker, "in-progress");
  expect(
    (await scan())?.tasks[0]?.observations[0]?.configuration,
  ).toMatchObject({
    source: { project: "DKT", origin: "defaults-missing" },
    baseline: { origin: "defaults-missing" },
  });
  for (const invalid of [
    "project: [RS]",
    "project: '",
    "bundle: ../escape",
    "[]",
  ]) {
    writeFileSync(join(worker, "docket.yaml"), invalid);
    const result = await scan();
    expect(result?.complete).toBe(false);
    expect(result?.observations).toHaveLength(0);
  }
});

test("a moved bundle uses its source path and the original configured baseline path", async () => {
  const { worker, scan } = setup("todo", "docket", "RS");
  rmSync(join(worker, "docket"), { recursive: true });
  writeFileSync(
    join(worker, "docket.yaml"),
    "project: RS\nbundle: knowledge\n",
  );
  write(worker, "in-progress", "RS-1", taskPath, "knowledge");
  const result = await scan();
  expect(result?.complete).toBe(true);
  expect(result?.tasks[0]?.observations[0]).toMatchObject({
    base: { id: "RS-1", status: "todo" },
    task: { id: "RS-1", status: "in-progress" },
    configuration: {
      source: { bundle: "knowledge" },
      baseline: { bundle: "docket" },
      compatible: false,
    },
  });
});

test("configuration changes during observation discard previously admitted rows", async () => {
  const { root, worker } = setup("todo", "docket", "RS");
  write(worker, "in-progress", "RS-1");
  let changed = false;
  const owner = new GitEvidenceIndex(root, "Task", {
    ttlMs: 0,
    onCommand: (args) => {
      if (
        !changed &&
        args[0] === "show" &&
        args[1]?.endsWith(":docket/work/tasks/item.md")
      ) {
        changed = true;
        writeFileSync(
          join(worker, "docket.yaml"),
          "project: ALT\nbundle: docket\n",
        );
      }
    },
  });
  owners.push(owner);
  const bundle = await loadBundle(
    new LocalFileStore(join(root, "docket")),
    parseConfig("project: RS\nbundle: docket\n"),
  );
  const result = (await owner.snapshot(bundle.byId)).git.taskProgress;
  expect(changed).toBe(true);
  expect(result?.complete).toBe(false);
  expect(result?.observations).toHaveLength(0);
  expect(result?.diagnostics.join(" ")).toContain("configuration changed");
});
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

test("body-only same-task divergence conflicts, independent task work does not, and committed closeout stays separate from dirty saved reopening", async () => {
  const { root, worker, scan } = setup("todo", "docket", "RS");
  const source = readFileSync(join(root, "docket", taskPath), "utf8");
  writeFileSync(
    join(worker, "docket", taskPath),
    `${source}\nBranch authored acceptance.\n`,
  );
  let progress = await scan();
  expect(progress?.tasks[0]?.state).toBe("observed");
  expect(progress?.tasks[0]?.observations[0]?.task.version).toMatch(
    /^[a-f0-9]{64}$/,
  );
  writeFileSync(
    join(root, "docket", taskPath),
    `${source}\nLocal independent acceptance.\n`,
  );
  progress = await scan();
  expect(progress?.tasks[0]?.state).toBe("conflict");
  writeFileSync(join(root, "docket", taskPath), source);
  write(worker, "in-progress", "RS-2", "work/tasks/another.md");
  progress = await scan();
  expect(progress?.tasks.find((t) => t.id === "RS-2")?.state).toBe("observed");
  expect(progress?.tasks.find((t) => t.id === "RS-1")?.state).toBe("observed");
  write(worker, "done", "RS-1");
  git(worker, "add", ".");
  git(worker, "commit", "-qm", "Committed closeout\n\nTask: RS-1");
  writeFileSync(join(worker, "docket", taskPath), source);
  progress = await scan();
  expect(
    progress?.tasks.find((t) => t.id === "RS-1")?.observations[0],
  ).toMatchObject({
    task: { status: "todo" },
    committed: {
      task: { status: "done" },
      integrated: false,
      compatible: true,
    },
    uncommitted: true,
  });
  const local = await loadBundle(
    new LocalFileStore(join(root, "docket")),
    parseConfig("project: RS"),
  );
  expect(local.byId("RS-1")?.fm.status).toBe("todo");
});

test("documentation-only closeout behind a later unrelated doc tip leaves local epic at eight of nine", async () => {
  const { root, worker, scan } = setup("todo", "docket", "RS");
  const { taskDriftReceipt } = await import("./task-drift");
  const open = readFileSync(join(root, "docket", taskPath), "utf8").replace(
    "status: todo",
    "status: todo\nepic: /work/epics/epic.md",
  );
  writeFileSync(join(root, "docket", taskPath), open);
  mkdirSync(join(root, "docket/work/epics"), { recursive: true });
  writeFileSync(
    join(root, "docket/work/epics/epic.md"),
    "---\ntype: Epic\nid: RS-370\ntitle: Synthetic parent\nstatus: in-progress\n---\n",
  );
  for (let n = 2; n <= 9; n++) {
    write(root, "done", `RS-${n}`, `work/tasks/child-${n}.md`);
    const p = join(root, `docket/work/tasks/child-${n}.md`);
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(
        "status: done",
        "status: done\nepic: /work/epics/epic.md",
      ),
    );
  }
  git(root, "add", ".");
  git(
    root,
    "commit",
    "-qm",
    "Integrated child implementation and local records",
  );
  git(worker, "merge", "--ff-only", git(root, "rev-parse", "HEAD"));
  writeFileSync(
    join(worker, "docket", taskPath),
    `${open.replace("status: todo", "status: done")}\n# Outcome\n\nAccepted synthetic count, backups, fidelity and duplicate-safe replay.\n`,
  );
  git(worker, "add", ".");
  git(worker, "commit", "-qm", "Accepted closeout\n\nTask: RS-1");
  mkdirSync(join(worker, "docket/reference"), { recursive: true });
  for (let n = 1; n <= 2; n++) {
    writeFileSync(
      join(worker, `docket/reference/follow-up-${n}.md`),
      "---\ntype: Reference\ntitle: Independent doc follow-up\n---\nSource qualification only.\n",
    );
    git(worker, "add", ".");
    git(worker, "commit", "-qm", "Documentation follow-up\n\nTask: RS-1");
  }
  const progress = await scan();
  expect(taskDriftReceipt("RS-1", progress).warnings[0]?.code).toBe(
    "terminal-closeout-unmerged",
  );
  const local = await loadBundle(
    new LocalFileStore(join(root, "docket")),
    parseConfig("project: RS"),
  );
  const children = local.workItems.filter(
    (t) => t.fm.epic === "/work/epics/epic.md",
  );
  expect(children).toHaveLength(9);
  expect(children.filter((t) => t.fm.status === "done")).toHaveLength(8);
  expect(local.byId("RS-370")?.fm.status).toBe("in-progress");
});

test("foreign source IDs and pickups resolving through a local alias remain visible on the canonical task", async () => {
  const { root, worker, scan } = setup("todo", "docket", "RS");
  writeFileSync(
    join(root, "docket", taskPath),
    readFileSync(join(root, "docket", taskPath), "utf8").replace(
      "id: RS-1",
      "id: RS-5\naliases: [RS-1]",
    ),
  );
  write(worker, "in-progress", "RS-1");
  mkdirSync(join(worker, ".docket"), { recursive: true });
  writeFileSync(join(worker, ".docket/active-task"), "RS-1\n");
  const progress = await scan();
  expect(progress?.tasks.find((t) => t.id === "RS-5")).toMatchObject({
    localStatus: "todo",
    state: "conflict",
    pickedUpElsewhere: true,
    observations: [{ task: { id: "RS-1" } }],
  });
  expect(progress?.tasks.some((t) => t.id === "RS-1")).toBe(false);
});
