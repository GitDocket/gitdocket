// createCommitter against a real git repo: the whole point is
// pathspec discipline — an op's commit may only ever contain the op's files,
// whatever else is dirty or staged in the tree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommitter } from "./commit";

let root: string;

const git = (...args: string[]): string => {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString();
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-commit-"));
  await mkdir(join(root, "docs", "work", "tasks"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "docs/work/tasks/DKT-1-do.md"), "status: todo\n");
  await writeFile(join(root, "src/code.ts"), "export const a = 1;\n");
  git("init", "-q");
  git("config", "user.email", "test@docket.local");
  git("config", "user.name", "docket test");
  git("add", "-A");
  git("commit", "-qm", "initial");
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("createCommitter", () => {
  test("commits only the op's files, leaving dirty and staged work alone", async () => {
    // The op touched the task file; the tree also has an unrelated edit and
    // an unrelated staged new file — both must survive untouched.
    await writeFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "status: done\n",
    );
    await writeFile(join(root, "src/code.ts"), "export const a = 2;\n");
    await writeFile(join(root, "src/staged.ts"), "export const b = 1;\n");
    git("add", "src/staged.ts");

    const commit = createCommitter(root, "docs");
    await commit({
      paths: ["work/tasks/DKT-1-do.md"],
      message: "chore(docket): DKT-1 todo → done (serve)\n\nTask: DKT-1\n",
    });

    expect(git("log", "-1", "--format=%s")).toBe(
      "chore(docket): DKT-1 todo → done (serve)\n",
    );
    expect(git("log", "-1", "--format=%(trailers:key=Task)")).toContain(
      "Task: DKT-1",
    );
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe(
      "docs/work/tasks/DKT-1-do.md",
    );
    // The unrelated edit is still dirty, the unrelated add still staged.
    expect(
      git("status", "--porcelain").split("\n").filter(Boolean).sort(),
    ).toEqual([" M src/code.ts", "A  src/staged.ts"]);
  });

  test("handles files git doesn't know yet (a just-created concept)", async () => {
    await writeFile(join(root, "docs/work/tasks/DKT-2-new.md"), "new\n");
    const commit = createCommitter(root, "docs");
    await commit({
      paths: ["work/tasks/DKT-2-new.md"],
      message: "chore(docket): DKT-2 created (serve)\n\nTask: DKT-2\n",
    });
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe(
      "docs/work/tasks/DKT-2-new.md",
    );
  });

  test("surfaces git failures as errors", async () => {
    const commit = createCommitter(root, "docs");
    expect(
      commit({ paths: ["work/tasks/nope.md"], message: "x" }),
    ).rejects.toThrow("git add failed");
  });
});
