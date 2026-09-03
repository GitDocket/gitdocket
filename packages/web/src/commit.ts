// The serve --commit committer: one pathspec-limited commit
// per UI write. Scoped `git add` + `git commit --only` so unrelated dirty or
// staged work in the tree can never ride along.

import { join } from "node:path";

export interface CommitOp {
  /** Bundle-relative paths the op touched. */
  paths: string[];
  /** Full commit message, trailer included. */
  message: string;
}

export type Committer = (op: CommitOp) => Promise<void>;

export function createCommitter(root: string, bundleDir: string): Committer {
  const run = (args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: root });
    if (proc.exitCode !== 0) {
      const detail =
        `${proc.stderr.toString()}${proc.stdout.toString()}`.trim();
      throw new Error(`git ${args[0]} failed: ${detail}`);
    }
  };
  return async ({ paths, message }) => {
    const files = paths.map((p) => join(bundleDir, p));
    run(["add", "--", ...files]);
    run(["commit", "--only", "-m", message, "--", ...files]);
  };
}
