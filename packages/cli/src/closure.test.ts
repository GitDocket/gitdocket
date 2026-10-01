import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "index.ts");
let root: string;
const run = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, cli, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
};
const json = (...args: string[]) => {
  const p = run(...args, "--json");
  return { ...p, data: JSON.parse(p.stdout) };
};
const git = (...args: string[]) => {
  const p = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      ...args,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(p.exitCode).toBe(0);
  return p.stdout.toString().trim();
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-closure-"));
  await mkdir(join(root, "docket"));
  await writeFile(join(root, "docket.yaml"), "project: FIX\nbundle: docket\n");
  git("init");
  git("config", "core.hooksPath", "/dev/null");
  git("add", ".");
  git("commit", "-m", "Fixture baseline");
});
afterEach(() => rm(root, { recursive: true, force: true }));
async function create(title = "Close reliably", type = "Task") {
  const input = join(root, "input.json");
  await writeFile(
    input,
    JSON.stringify({
      title,
      type,
      body: "# Context\n\nFixture.\n\n# Acceptance Criteria\n\n- [x] Qualified fixture.\n\n# Outcome\n\nFixture evidence.\n",
    }),
  );
  const p = json("task", "create", "--input", input, "--compact");
  expect(p.code).toBe(0);
  await rm(input);
  return p.data;
}
test("complete and closed continuations retain hook state, return guarded cleanup, and permit next pickup", async () => {
  for (const withoutCompletion of [false, true]) {
    const task = await create();
    const started = json("task", "start", task.id);
    expect(started.code).toBe(0);
    const before = git("rev-parse", "HEAD");
    const closed = json(
      "task",
      "close",
      task.id,
      "--compact",
      ...(withoutCompletion
        ? ["--without-completion", "--note", "Explicit fixture disposition"]
        : []),
    );
    expect(closed.code).toBe(0);
    expect(closed.data.to).toBe(withoutCompletion ? "closed" : "done");
    expect(closed.data.closure).toMatchObject({
      activeTaskRetained: true,
      cleanup: {
        state: "matching-active-task",
        surface: "cli",
        after: "closure commit",
      },
    });
    expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
      `${task.id}\n`,
    );
    const args = closed.data.closure.cleanup.args as string[];
    const call = (sha: string) =>
      json(
        ...args
          .slice(0, -1)
          .map((a) => (a === "<closure-commit-sha>" ? sha : a)),
      );
    expect(call(before)).toMatchObject({
      code: 1,
      data: { changed: false, cleanup: { disposition: "commit-not-ready" } },
    });
    git("add", "docket");
    git("commit", "-m", "Closure fixture without trailer");
    expect(call(git("rev-parse", "HEAD")).code).toBe(1);
    git(
      "commit",
      "--allow-empty",
      "-m",
      "Accepted closure",
      "-m",
      `Task: ${task.id}`,
    );
    const commit = git("rev-parse", "HEAD");
    expect(call(commit)).toMatchObject({
      code: 0,
      data: {
        changed: true,
        mutation: "applied",
        cleanup: { disposition: "cleared" },
        statusChanged: false,
      },
    });
    expect(call(commit)).toMatchObject({
      code: 0,
      data: { changed: false, cleanup: { disposition: "already-clear" } },
    });
    const next = await create("Next task");
    expect(json("task", "start", next.id).code).toBe(0);
    expect(call(commit)).toMatchObject({
      code: 1,
      data: { cleanup: { disposition: "marker-mismatch" } },
    });
    expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
      `${next.id}\n`,
    );
    expect(json("task", "stop", next.id).code).toBe(0);
  }
});
test("closing an alias returns cleanup scoped to the canonical active task", async () => {
  const task = await create();
  const path = join(root, "docket", task.path);
  const source = await readFile(path, "utf8");
  await writeFile(
    path,
    source.replace("id: FIX-1", "id: FIX-1\naliases: [FIX-77]"),
  );
  const started = json("task", "start", "FIX-77");
  expect(started.code).toBe(0);
  const closed = json("task", "close", "FIX-77", "--compact");
  expect(closed.code).toBe(0);
  expect(closed.data.id).toBe("FIX-1");
  expect(closed.data.closure.cleanup.state).toBe("matching-active-task");
  expect(closed.data.closure.cleanup.args.slice(0, 3)).toEqual([
    "task",
    "stop",
    "FIX-1",
  ]);
});
test("closure guard refuses changed source, nonterminal source, unrelated commit and missing scope", async () => {
  const task = await create();
  const started = json("task", "start", task.id);
  expect(started.code).toBe(0);
  git("add", "docket");
  git("commit", "-m", "In-progress fixture", "-m", `Task: ${task.id}`);
  expect(
    json("task", "stop", task.id, "--after-commit", git("rev-parse", "HEAD"))
      .code,
  ).toBe(1);
  expect(
    json("task", "stop", "--after-commit", git("rev-parse", "HEAD")).code,
  ).toBe(1);
  expect(json("task", "close", task.id, "--compact").code).toBe(0);
  git("add", "docket");
  git("commit", "-m", "Closed fixture", "-m", `Task: ${task.id}`);
  const commit = git("rev-parse", "HEAD");
  const unmerged = git(
    "commit-tree",
    "HEAD^{tree}",
    "-m",
    "Unmerged closure fixture",
    "-m",
    `Task: ${task.id}`,
  );
  expect(json("task", "stop", task.id, "--after-commit", unmerged).code).toBe(
    1,
  );
  expect(json("task", "stop", task.id, "--after-commit", "").code).toBe(1);
  const path = join(root, "docket", task.path);
  await writeFile(path, `${await readFile(path, "utf8")}\nLater evidence.\n`);
  expect(json("task", "stop", task.id, "--after-commit", commit)).toMatchObject(
    { code: 1, data: { cleanup: { disposition: "commit-not-ready" } } },
  );
  expect(await readFile(join(root, ".docket/workflow-token"), "utf8")).toBe(
    `${started.data.telemetryWorkflow}\n`,
  );
});
test("human closure ordering is truthful and nonmatching closure preserves another task", async () => {
  const active = await create("Active");
  const other = await create("Other");
  expect(json("task", "start", active.id).code).toBe(0);
  const closed = json("task", "close", other.id, "--compact");
  expect(closed.data.closure).toMatchObject({
    activeTaskRetained: false,
    cleanup: { state: "different-active-task" },
  });
  expect(closed.data.closure.cleanup).not.toHaveProperty("args");
  const human = run("task", "close", active.id);
  expect(human.code).toBe(0);
  expect(human.stdout).not.toContain("now write the Outcome");
  expect(human.stdout).toContain("After commit:");
  expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
    `${active.id}\n`,
  );
});
test("concurrent named pickups cannot overwrite each other's marker or token", async () => {
  const first = await create("First");
  const second = await create("Second");
  const call = async (id: string) => {
    const p = Bun.spawn(
      [process.execPath, cli, "task", "start", id, "--json"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
    ]);
    return { code, data: JSON.parse(stdout) };
  };
  const results = await Promise.all([call(first.id), call(second.id)]);
  expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
  const winner = results.find((r) => r.code === 0)?.data;
  expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
    `${winner.task.fm.id}\n`,
  );
  expect(await readFile(join(root, ".docket/workflow-token"), "utf8")).toBe(
    `${winner.telemetryWorkflow}\n`,
  );
});
