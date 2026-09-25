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
    expect(typeof started.telemetryWorkflow).toBe("string");
    expect(started.telemetryWorkflow.length).toBeGreaterThan(8);
    expect(await readFile(join(repo, ".docket", "active-task"), "utf8")).toBe(
      `${id}\n`,
    );
    expect(
      await readFile(join(repo, ".docket", "workflow-token"), "utf8"),
    ).toBe(`${started.telemetryWorkflow}\n`);

    const resumed = sh(["bun", CLI, "task", "start", id, "--json"]);
    expect(resumed.code).toBe(0);
    const again = JSON.parse(resumed.stdout);
    expect(again.started).toBeNull();
    expect(again.suggestedSessionTitle).toBe(`${id} — Make pickup reliable`);
    expect(again.telemetryWorkflow).toBe(started.telemetryWorkflow);

    const stopped = sh(["bun", CLI, "task", "stop"]);
    expect(stopped.code).toBe(0);
    expect(
      await readFile(join(repo, ".docket", "workflow-token"), "utf8").catch(
        () => "",
      ),
    ).toBe("");
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

  test("refuses a different ID without changing its status, marker, or workflow token", async () => {
    const firstId = JSON.parse(
      sh(["bun", CLI, "task", "create", "--title", "First writer", "--json"])
        .stdout,
    ).id as string;
    const secondId = JSON.parse(
      sh(["bun", CLI, "task", "create", "--title", "Second writer", "--json"])
        .stdout,
    ).id as string;
    expect(sh(["git", "init", "-q"]).code).toBe(0);
    expect(sh(["git", "config", "user.name", "Pickup Test"]).code).toBe(0);
    expect(
      sh(["git", "config", "user.email", "pickup@example.test"]).code,
    ).toBe(0);
    expect(sh(["git", "add", "."]).code).toBe(0);
    expect(sh(["git", "commit", "-qm", "Add tracked tasks"]).code).toBe(0);

    const first = sh(["bun", CLI, "task", "start", firstId, "--json"]);
    expect(first.code).toBe(0);
    const token = await readFile(
      join(repo, ".docket", "workflow-token"),
      "utf8",
    );
    const marker = await readFile(join(repo, ".docket", "active-task"), "utf8");
    const refused = sh(["bun", CLI, "task", "start", secondId, "--json"]);
    expect(refused.code).toBe(1);
    const error = JSON.parse(refused.stdout).error;
    expect(error.code).toBe("active-task-conflict");
    expect(error.activeTaskId).toBe(firstId);
    expect(error.requestedTaskId).toBe(secondId);
    expect(error.handoff).toEqual({
      command: "docket task stop",
      requiresExplicitAuthorization: true,
      nextCommand: `docket task start ${secondId} --json`,
    });
    expect(error.isolation.command).toContain("git -C");
    expect(error.isolation.command).toContain("worktree add -b");
    expect(error.isolation.branch).toContain(secondId);
    expect(error.isolation.requiresConfirmationByDefault).toBe(true);
    expect(error.isolation.agentPrompt).toContain(
      `May I create a linked Git worktree at <path> on branch <branch> from commit <commit>, then start ${secondId} there?`,
    );
    expect(error.isolation.agentPrompt).toContain(
      "Do not run docket task stop",
    );
    expect(await readFile(join(repo, ".docket", "active-task"), "utf8")).toBe(
      marker,
    );
    expect(
      await readFile(join(repo, ".docket", "workflow-token"), "utf8"),
    ).toBe(token);

    const human = sh(["bun", CLI, "task", "start", secondId]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain(`cannot start ${secondId} here`);
    expect(human.stdout).toContain("Git recipe: git -C");
    expect(human.stdout).toContain("Agent prompt:");
    const items = sh(["bun", CLI, "task", "list", "--all", "--json"]);
    expect(
      JSON.parse(items.stdout).find(
        (item: { id: string }) => item.id === secondId,
      ).status,
    ).toBe("todo");

    expect(sh(["bun", CLI, "task", "stop"]).code).toBe(0);
    expect(sh(["bun", CLI, "task", "start", secondId, "--json"]).code).toBe(0);
  });

  test("does not present an executable worktree command when the task is absent from a starting commit", () => {
    const firstId = JSON.parse(
      sh(["bun", CLI, "task", "create", "--title", "First", "--json"]).stdout,
    ).id as string;
    const secondId = JSON.parse(
      sh(["bun", CLI, "task", "create", "--title", "Second", "--json"]).stdout,
    ).id as string;
    expect(sh(["bun", CLI, "task", "start", firstId, "--json"]).code).toBe(0);
    const refused = sh(["bun", CLI, "task", "start", secondId, "--json"]);
    expect(refused.code).toBe(1);
    const isolation = JSON.parse(refused.stdout).error.isolation;
    expect(isolation.command).toBeNull();
    expect(isolation.commandTemplate).toContain("git worktree add");
    expect(isolation.issues).toContain(
      "HEAD is not a usable starting commit; choose a committed starting point.",
    );
  });
});
