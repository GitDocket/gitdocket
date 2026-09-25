// End-to-end completion versus non-completion disposition at the CLI surface.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");
let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "docket-close-"));
  const init = Bun.spawnSync(
    [process.execPath, CLI, "init", "--project", "FIX", "--json"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  expect(init.exitCode).toBe(0);
});

afterEach(() => rm(repo, { recursive: true, force: true }));

function sh(args: string[]): { code: number; stdout: string; stderr: string } {
  const command =
    args[0] === "bun" ? [process.execPath, ...args.slice(1)] : args;
  const result = Bun.spawnSync(command, {
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

describe("docket task close dispositions", () => {
  test("keeps completion as the default and makes incomplete closure explicit", async () => {
    const first = sh([
      "bun",
      CLI,
      "task",
      "create",
      "--title",
      "Candidate",
      "--json",
    ]);
    const id = JSON.parse(first.stdout).id as string;
    const dependent = sh([
      "bun",
      CLI,
      "task",
      "create",
      "--title",
      "Dependent",
      "--deps",
      id,
      "--json",
    ]);
    const dependentId = JSON.parse(dependent.stdout).id as string;

    const missing = sh([
      "bun",
      CLI,
      "task",
      "close",
      id,
      "--without-completion",
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("requires --note");

    const closed = sh([
      "bun",
      CLI,
      "task",
      "close",
      id,
      "--without-completion",
      "--note",
      "The opportunity was declined.",
      "--json",
    ]);
    expect(closed.code).toBe(0);
    expect(JSON.parse(closed.stdout)).toMatchObject({
      from: "todo",
      to: "closed",
    });

    const source = await readFile(
      join(repo, "docket", "work", "tasks", `${id}-candidate.md`),
      "utf8",
    );
    expect(source).toContain("status: closed");
    expect(source).toContain("The opportunity was declined.");

    const open = JSON.parse(
      sh(["bun", CLI, "task", "list", "--json"]).stdout,
    ) as { id: string }[];
    expect(open.map((item) => item.id)).toEqual([dependentId]);
    const all = JSON.parse(
      sh(["bun", CLI, "task", "list", "--all", "--json"]).stdout,
    ) as { id: string; status: string }[];
    expect(all).toContainEqual(
      expect.objectContaining({ id, status: "closed" }),
    );

    const ready = JSON.parse(sh(["bun", CLI, "ready", "--json"]).stdout) as {
      id: string;
    }[];
    expect(ready.map((item) => item.id)).not.toContain(dependentId);
  }, 15000);

  test("project policy reopens closed tasks and epics through task move with a reason", async () => {
    const configPath = join(repo, "docket.yaml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        "workflow:\n  states:",
        "workflow:\n  reopen_closed: [Task, Epic]\n  states:",
      ),
    );
    for (const type of ["Task", "Epic"]) {
      const created = sh([
        "bun",
        CLI,
        "task",
        "create",
        "--title",
        `${type} candidate`,
        "--type",
        type,
        "--json",
      ]);
      expect(created.code).toBe(0);
      const id = JSON.parse(created.stdout).id as string;
      expect(
        sh([
          "bun",
          CLI,
          "task",
          "close",
          id,
          "--without-completion",
          "--note",
          "Paused.",
        ]).code,
      ).toBe(0);
      const missing = sh(["bun", CLI, "task", "move", id, "todo"]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("requires a reason note");
      const reopened = sh([
        "bun",
        CLI,
        "task",
        "move",
        id,
        "todo",
        "--note",
        "Scope resumed.",
        "--json",
      ]);
      expect(reopened.code).toBe(0);
      expect(JSON.parse(reopened.stdout)).toMatchObject({
        from: "closed",
        to: "todo",
      });
    }
  }, 15000);
});
