// End-to-end pickup contract: the CLI owns task selection/state and returns
// one canonical title intent for a native adapter to consume.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");
let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "docket-pickup-"));
  const init = Bun.spawnSync(
    ["bun", CLI, "init", "--project", "FIX", "--json"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  expect(init.exitCode).toBe(0);
});

afterEach(() => rm(repo, { recursive: true, force: true }));

function sh(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("docket task start pickup contract", () => {
  test("returns the same canonical title for a new pickup and resume", async () => {
    const created = sh([
      "bun",
      CLI,
      "task",
      "create",
      "--title",
      "Make pickup reliable",
      "--priority",
      "p1",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const id = JSON.parse(created.stdout).id as string;

    const first = sh(["bun", CLI, "task", "start", id, "--json"]);
    expect(first.code).toBe(0);
    const started = JSON.parse(first.stdout);
    expect(started.started).toEqual({ from: "todo", to: "in-progress" });
    expect(started.suggestedSessionTitle).toBe(`${id} — Make pickup reliable`);
    expect(started.task.fm.id).toBe(id);
    expect(await readFile(join(repo, ".docket", "active-task"), "utf8")).toBe(
      `${id}\n`,
    );

    const resumed = sh(["bun", CLI, "task", "start", id, "--json"]);
    expect(resumed.code).toBe(0);
    const again = JSON.parse(resumed.stdout);
    expect(again.started).toBeNull();
    expect(again.suggestedSessionTitle).toBe(`${id} — Make pickup reliable`);
  });

  test("bare pickup keeps ready selection and human packet output unchanged", () => {
    sh([
      "bun",
      CLI,
      "task",
      "create",
      "--title",
      "Later task",
      "--priority",
      "p2",
    ]);
    const top = sh([
      "bun",
      CLI,
      "task",
      "create",
      "--title",
      "Top task",
      "--priority",
      "p1",
      "--json",
    ]);
    const id = JSON.parse(top.stdout).id as string;

    const human = sh(["bun", CLI, "task", "start"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`picked ${id} — top of the ready list`);
    expect(human.stdout).toContain(
      `${id}: todo → in-progress (active task set)`,
    );
    expect(human.stdout).toContain(`\n${id} — Top task\n`);
    expect(human.stdout).not.toContain("suggestedSessionTitle");
  });
});
