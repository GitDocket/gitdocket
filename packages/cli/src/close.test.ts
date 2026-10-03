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

  // docket:verifies DKT-272 — existing commands suffice; readiness observes
  // live files between moves, with a single final index and multi-item commit.
  test("closes accepted children and their epic in one commit while preserving outcomes", async () => {
    const cli = (...args: string[]) => {
      const result = sh(["bun", CLI, ...args]);
      expect(result.code).toBe(0);
      return result.stdout;
    };
    const git = (...args: string[]) => {
      const result = sh(["git", ...args]);
      expect(result.code).toBe(0);
      return result.stdout;
    };
    git("init", "-q");
    git("config", "user.email", "fixture@example.test");
    git("config", "user.name", "Closure fixture");
    const create = (title: string, ...args: string[]) =>
      JSON.parse(
        cli("task", "create", "--title", title, ...args, "--json"),
      ) as { id: string; path: string };
    const epic = create("Accepted epic", "--type", "Epic");
    const first = create("First result", "--epic", `/${epic.path}`);
    const second = create(
      "Second result",
      "--epic",
      `/${epic.path}`,
      "--deps",
      first.id,
    );
    const record = `/${epic.path}#outcome`;
    const editBody = async (item: typeof epic, body: string) => {
      const doc = JSON.parse(cli("document", "read", item.path, "--json"));
      const input = join(repo, ".docket", "closure-patch.json");
      await writeFile(
        input,
        JSON.stringify({ expectedVersion: doc.version, patch: { body } }),
      );
      cli("document", "edit", item.path, "--input", input, "--json");
    };
    await editBody(
      epic,
      `# Acceptance Criteria\n\n- [x] Integrated results accepted.\n\n# Outcome\n\nOwner accepted this fixture's integrated results. First and second checks passed in the implementation evidence. Optional visual check for ${second.id} was explicitly waived by the owner because no UI changed; it remains unobserved.\n`,
    );
    await editBody(
      first,
      `# Acceptance Criteria\n\n- [x] First result implemented.\n\n# Outcome\n\nFirst result shipped; [acceptance and evidence](${record}).\n`,
    );
    await editBody(
      second,
      `# Acceptance Criteria\n\n- [x] Second result implemented.\n- [ ] Optional visual check: explicitly waived; see shared record.\n\n# Outcome\n\nSecond result shipped; [acceptance, evidence and visual waiver](${record}).\n`,
    );
    git("add", ".");
    git("commit", "-qm", "Implementation evidence baseline");
    const baseline = git("rev-parse", "HEAD").trim();
    const indexBefore = await readFile(join(repo, "docket/index.md"), "utf8");
    const ready = () =>
      (JSON.parse(cli("ready", "--json")) as { id: string }[]).map(
        (item) => item.id,
      );
    expect(ready()).not.toContain(second.id);
    const close = (item: typeof epic) =>
      JSON.parse(
        cli(
          "task",
          "close",
          item.id,
          "--note",
          `Outcome and acceptance: ${record}`,
          "--json",
        ),
      );
    expect(close(first).to).toBe("done");
    expect(ready()).toContain(second.id);
    // A mid-pass invalid transition fails without rolling back the first move.
    cli("task", "move", second.id, "blocked", "--json");
    expect(sh(["bun", CLI, "task", "close", second.id, "--json"]).code).toBe(1);
    const states = () =>
      JSON.parse(cli("task", "list", "--epic", epic.id, "--all", "--json")) as {
        id: string;
        status: string;
      }[];
    expect(states()).toContainEqual(
      expect.objectContaining({ id: first.id, status: "done" }),
    );
    expect(states()).toContainEqual(
      expect.objectContaining({ id: second.id, status: "blocked" }),
    );
    cli("task", "move", second.id, "in-progress", "--json");
    expect(close(second).to).toBe("done");
    expect(states().every((item) => item.status === "done")).toBe(true);
    expect(close(epic).to).toBe("done");
    expect(git("rev-parse", "HEAD").trim()).toBe(baseline);
    expect(await readFile(join(repo, "docket/index.md"), "utf8")).toBe(
      indexBefore,
    );
    cli("index");
    const diagnostics = JSON.parse(cli("lint", "--json")) as {
      severity: string;
    }[];
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    git("add", "docket");
    const trailers = [epic, first, second]
      .map((item) => `Task: ${item.id}`)
      .join("\n");
    git("commit", "-qm", `Consolidated closure\n\n${trailers}`);
    expect(git("rev-list", "--count", `${baseline}..HEAD`).trim()).toBe("1");
    for (const item of [epic, first, second]) {
      expect(git("log", "--format=%B", "-1")).toContain(`Task: ${item.id}`);
      expect(await readFile(join(repo, "docket", item.path), "utf8")).toContain(
        "status: done",
      );
    }
    const secondSource = await readFile(
      join(repo, "docket", second.path),
      "utf8",
    );
    expect(secondSource).toContain("- [ ] Optional visual check");
    expect(secondSource).toContain(record);
    expect(await readFile(join(repo, "docket", epic.path), "utf8")).toContain(
      "it remains unobserved",
    );
  }, 30_000);

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
