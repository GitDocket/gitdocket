// createCommitter against a real git repo: the whole point is
// pathspec discipline — an op's commit may only ever contain the op's files,
// whatever else is dirty or staged in the tree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createCommitter } from "./commit";

let root: string;

const git = (...args: string[]): string => {
  return gitAt(root, ...args);
};

const gitAt = (cwd: string, ...args: string[]): string => {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString();
};

const message = "chore(docket): DKT-1 todo → done (serve)\n\nTask: DKT-1\n";

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
    git("add", "src/code.ts");
    await writeFile(join(root, "src/code.ts"), "export const a = 3;\n");
    await writeFile(join(root, "src/staged.ts"), "export const b = 1;\n");
    git("add", "src/staged.ts");
    await writeFile(join(root, "src/untracked.ts"), "export const c = 1;\n");
    const indexBefore = git("ls-files", "--stage", "-z");

    const commit = createCommitter(root, "docs");
    await commit({
      paths: ["work/tasks/DKT-1-do.md"],
      message,
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
    // The unrelated partial stage, staged add, working bytes, and untracked
    // file all survive. The only live-index change cleans the committed path.
    const indexAfter = git("ls-files", "--stage", "-z");
    const withoutTask = (value: string) =>
      value
        .split("\0")
        .filter(
          (entry) => entry && !entry.endsWith("docs/work/tasks/DKT-1-do.md"),
        )
        .sort();
    expect(withoutTask(indexAfter)).toEqual(withoutTask(indexBefore));
    expect(await readFile(join(root, "src/code.ts"), "utf8")).toBe(
      "export const a = 3;\n",
    );
    expect(
      git("status", "--porcelain").split("\n").filter(Boolean).sort(),
    ).toEqual(["?? src/untracked.ts", "A  src/staged.ts", "MM src/code.ts"]);
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

  test("retries a compare-and-swap miss on a new unrelated parent", async () => {
    await writeFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "status: done\n",
    );
    const attempts: number[] = [];
    const commit = createCommitter(root, "docs", {
      beforeHeadUpdate: (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) git("commit", "--allow-empty", "-qm", "concurrent");
      },
    });

    await commit({ paths: ["work/tasks/DKT-1-do.md"], message });

    expect(attempts).toEqual([1, 2]);
    expect(git("log", "-2", "--format=%s").trim().split("\n")).toEqual([
      "chore(docket): DKT-1 todo → done (serve)",
      "concurrent",
    ]);
    expect(git("show", "HEAD:docs/work/tasks/DKT-1-do.md")).toBe(
      "status: done\n",
    );
  });

  test("fails after bounded repeated HEAD movement without publishing the op", async () => {
    await writeFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "status: done\n",
    );
    const commit = createCommitter(root, "docs", {
      maxHeadUpdateAttempts: 2,
      beforeHeadUpdate: (attempt) => {
        git("commit", "--allow-empty", "-qm", `concurrent ${attempt}`);
      },
    });

    await expect(
      commit({ paths: ["work/tasks/DKT-1-do.md"], message }),
    ).rejects.toThrow("Git HEAD kept changing");

    expect(git("log", "-2", "--format=%s").trim().split("\n")).toEqual([
      "concurrent 2",
      "concurrent 1",
    ]);
    expect(
      await readFile(join(root, "docs/work/tasks/DKT-1-do.md"), "utf8"),
    ).toBe("status: done\n");
    expect(git("status", "--porcelain")).toContain(
      " M docs/work/tasks/DKT-1-do.md",
    );
  });

  test("refuses to reparent across a concurrent selected-path commit", async () => {
    await writeFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "status: done\n",
    );
    const commit = createCommitter(root, "docs", {
      beforeHeadUpdate: (attempt) => {
        if (attempt !== 1) return;
        git("add", "docs/work/tasks/DKT-1-do.md");
        git("commit", "-qm", "concurrent selected path");
      },
    });

    await expect(
      commit({ paths: ["work/tasks/DKT-1-do.md"], message }),
    ).rejects.toThrow("HEAD changed one of the selected paths");
    expect(git("log", "-1", "--format=%s")).toBe("concurrent selected path\n");
    expect(git("log", "--format=%s")).not.toContain(
      "chore(docket): DKT-1 todo → done (serve)",
    );
  });

  test("does not overwrite concurrent selected or unrelated index changes", async () => {
    await writeFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "status: done\n",
    );
    await writeFile(join(root, "index-only.txt"), "index-only\n");
    const indexOnlyBlob = git("hash-object", "-w", "index-only.txt").trim();
    await rm(join(root, "index-only.txt"));
    await writeFile(join(root, "src/concurrent.ts"), "concurrent\n");

    const commit = createCommitter(root, "docs", {
      beforeHeadUpdate: () => {
        git(
          "update-index",
          "--cacheinfo",
          "100644",
          indexOnlyBlob,
          "docs/work/tasks/DKT-1-do.md",
        );
        git("add", "src/concurrent.ts");
      },
    });
    await commit({ paths: ["work/tasks/DKT-1-do.md"], message });

    expect(
      git("ls-files", "--stage", "--", "docs/work/tasks/DKT-1-do.md"),
    ).toContain(indexOnlyBlob);
    expect(git("diff", "--cached", "--name-only")).toContain(
      "src/concurrent.ts",
    );
    expect(git("show", "HEAD:docs/work/tasks/DKT-1-do.md")).toBe(
      "status: done\n",
    );
  });

  test("runs hooks against the isolated selected tree and keeps hook edits", async () => {
    const hooks = join(root, ".hooks");
    await mkdir(hooks);
    git("config", "core.hooksPath", ".hooks");
    const preCommit = join(hooks, "pre-commit");
    await writeFile(
      preCommit,
      `#!/bin/sh
git diff --cached --name-only > hook-seen.txt
printf 'status: hook-adjusted\\n' > docs/work/tasks/DKT-1-do.md
git add -- docs/work/tasks/DKT-1-do.md
printf 'hook extra\\n' > src/hook-extra.ts
git add -- src/hook-extra.ts
`,
    );
    await chmod(preCommit, 0o755);
    await writeFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "status: done\n",
    );

    await createCommitter(
      root,
      "docs",
    )({
      paths: ["work/tasks/DKT-1-do.md"],
      message,
    });

    expect((await readFile(join(root, "hook-seen.txt"), "utf8")).trim()).toBe(
      "docs/work/tasks/DKT-1-do.md",
    );
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe(
      "docs/work/tasks/DKT-1-do.md",
    );
    expect(git("show", "HEAD:docs/work/tasks/DKT-1-do.md")).toBe(
      "status: hook-adjusted\n",
    );
    expect(git("status", "--porcelain")).toContain("?? src/hook-extra.ts");
  });

  test("hook failure leaves the write and live index intact and removes temporary state", async () => {
    const hooks = join(root, ".hooks");
    await mkdir(hooks);
    git("config", "core.hooksPath", ".hooks");
    const preCommit = join(hooks, "pre-commit");
    await writeFile(preCommit, "#!/bin/sh\nexit 7\n");
    await chmod(preCommit, 0o755);
    await writeFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "status: done\n",
    );
    const headBefore = git("rev-parse", "HEAD");
    const indexBefore = git("ls-files", "--stage", "-z");
    const temporaryBefore = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("docket-serve-commit-"),
    );

    await expect(
      createCommitter(
        root,
        "docs",
      )({
        paths: ["work/tasks/DKT-1-do.md"],
        message,
      }),
    ).rejects.toThrow("git hook failed");

    expect(git("rev-parse", "HEAD")).toBe(headBefore);
    expect(git("ls-files", "--stage", "-z")).toBe(indexBefore);
    expect(
      await readFile(join(root, "docs/work/tasks/DKT-1-do.md"), "utf8"),
    ).toBe("status: done\n");
    expect(
      (await readdir(tmpdir())).filter((entry) =>
        entry.startsWith("docket-serve-commit-"),
      ),
    ).toEqual(temporaryBefore);
  });

  test("refuses merge, rebase, cherry-pick, and revert repository states", async () => {
    const cases = [
      ["MERGE_HEAD", "merge", false],
      ["rebase-merge", "rebase", true],
      ["rebase-apply", "rebase", true],
      ["CHERRY_PICK_HEAD", "cherry-pick", false],
      ["REVERT_HEAD", "revert", false],
    ] as const;
    const headBefore = git("rev-parse", "HEAD");
    await writeFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "status: done\n",
    );

    for (const [marker, label, directory] of cases) {
      const configured = git("rev-parse", "--git-path", marker).trim();
      const path = isAbsolute(configured) ? configured : join(root, configured);
      if (directory) await mkdir(path, { recursive: true });
      else await writeFile(path, headBefore);
      await expect(
        createCommitter(
          root,
          "docs",
        )({
          paths: ["work/tasks/DKT-1-do.md"],
          message,
        }),
      ).rejects.toThrow(`Git ${label} is in progress`);
      await rm(path, { recursive: true, force: true });
    }
    expect(git("rev-parse", "HEAD")).toBe(headBefore);
  });

  test("creates the initial signed commit and handles spaces in paths", async () => {
    const unborn = await mkdtemp(join(tmpdir(), "docket-commit-unborn-"));
    try {
      await mkdir(join(unborn, "docs/work/tasks"), { recursive: true });
      await writeFile(
        join(unborn, "docs/work/tasks/DKT 1 spaced.md"),
        "status: done\n",
      );
      gitAt(unborn, "init", "-q");
      gitAt(unborn, "config", "user.email", "test@docket.local");
      gitAt(unborn, "config", "user.name", "docket test");
      const key = join(unborn, "signing-key");
      const keygen = Bun.spawnSync([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        key,
      ]);
      expect(keygen.exitCode).toBe(0);
      gitAt(unborn, "config", "gpg.format", "ssh");
      gitAt(unborn, "config", "user.signingkey", key);
      gitAt(unborn, "config", "commit.gpgSign", "true");

      await createCommitter(
        unborn,
        "docs",
      )({
        paths: ["work/tasks/DKT 1 spaced.md"],
        message,
      });

      expect(
        gitAt(unborn, "show", "--name-only", "--format=", "HEAD").trim(),
      ).toBe("docs/work/tasks/DKT 1 spaced.md");
      expect(gitAt(unborn, "cat-file", "-p", "HEAD")).toContain(
        "gpgsig -----BEGIN SSH SIGNATURE-----",
      );
      expect(gitAt(unborn, "rev-list", "--count", "HEAD").trim()).toBe("1");
    } finally {
      await rm(unborn, { recursive: true, force: true });
    }
  });
});
