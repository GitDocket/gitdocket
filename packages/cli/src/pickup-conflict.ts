import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WorkItem } from "@gitdocket/core";

const git = (root: string, args: string[]) =>
  Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** A refusal contains suggestions only; no worktree or branch is created here. */
export function pickupConflict(
  root: string,
  bundle: string,
  activeTaskId: string,
  requested: WorkItem,
) {
  const requestedTaskId = requested.fm.id;
  const branch = `task/${requestedTaskId}-${basename(requested.path, ".md")
    .replace(new RegExp(`^${requestedTaskId}-`), "")
    .slice(0, 40)}`;
  const path = join(
    dirname(root),
    `${basename(root)}-${requestedTaskId.toLowerCase()}`,
  );
  const startingPoint = "HEAD";
  const taskPath = join(bundle, requested.path);
  const issues: string[] = [];

  if (git(root, ["rev-parse", "--verify", "HEAD"]).exitCode !== 0)
    issues.push(
      "HEAD is not a usable starting commit; choose a committed starting point.",
    );
  else if (git(root, ["cat-file", "-e", `HEAD:${taskPath}`]).exitCode !== 0)
    issues.push(
      `The requested task file ${taskPath} is not in HEAD; choose a commit containing it or explicitly carry it into the new checkout.`,
    );
  if (
    git(root, ["status", "--porcelain", "--", taskPath])
      .stdout.toString()
      .trim()
  )
    issues.push(
      `The requested task file ${taskPath} has uncommitted changes; resolve its availability in the new checkout before starting.`,
    );
  if (
    git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
      .exitCode === 0
  )
    issues.push(
      `The suggested branch ${branch} already exists; choose a distinct branch.`,
    );
  if (existsSync(path))
    issues.push(
      `The suggested worktree path ${path} already exists; choose a free path.`,
    );

  const command = `git -C ${quote(root)} worktree add -b ${quote(branch)} ${quote(path)} ${quote(startingPoint)}`;
  const agentPrompt = `I want to start Docket task ${requestedTaskId} while ${activeTaskId} is active in ${root}. Preserve that checkout and its task marker. Check project branch guidance and whether the requested task and guidance exist at the starting commit; resolve uncommitted files or unavailable starting points without moving the other writer's work. Propose a separate linked worktree path, distinct branch, starting commit, and later integration step. Unless an applicable explicit request, session instruction, or user-requested project-guidance preference already authorizes automatic isolation, ask me directly: "May I create a linked Git worktree at <path> on branch <branch> from commit <commit>, then start ${requestedTaskId} there?" Do not use a vague approval request or create it before I answer. If authorized, report the chosen path and branch, create the worktree, target all shell/file/MCP operations there, and run docket task start ${requestedTaskId} --json there. Do not run docket task stop in the original checkout, or integrate or clean up without separate authorization.`;

  return {
    code: "active-task-conflict",
    message: `${activeTaskId} is active in this checkout; cannot start ${requestedTaskId} here.`,
    activeTaskId,
    requestedTaskId,
    handoff: {
      command: "docket task stop",
      requiresExplicitAuthorization: true,
      nextCommand: `docket task start ${requestedTaskId} --json`,
    },
    isolation: {
      path,
      branch,
      startingPoint,
      taskPath,
      command: issues.length === 0 ? command : null,
      commandTemplate:
        "git worktree add -b <distinct-branch> <new-path> <commit-containing-requested-task-and-guidance>",
      issues,
      requiresConfirmationByDefault: true,
      agentPrompt,
    },
  };
}
