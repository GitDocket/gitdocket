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
  const agentPrompt = `I want to start Docket task ${requestedTaskId} while ${activeTaskId} is active in ${root}. Preserve that checkout and its task marker. First check applicable host/user instructions, this request, session instructions and scoped project guidance for isolation authority. When they authorize routine reversible isolation within this scope, proceed without asking again; a lower-priority confirmation default adds no new gate. Check project branch guidance and whether the requested task and guidance exist at a usable starting commit; resolve unavailable starting points without silently committing or transferring another writer's uncommitted files. Inspect likely overlapping edits separately: a worktree protects working files but does not resolve content ownership. Establish a current baseline and explicit ownership or reconciliation plan before affected writes; defer unresolved overlap and continue ready, authorized independent work. Lead with the recommended next action and consequence, then supply a concrete worktree path, distinct branch, starting commit, named task and later integration step as supporting details. Only if authority is missing, ambiguous, revoked or materially exceeded, ask one direct question: "May I create a separate working copy and start ${requestedTaskId} there?" Wait for my answer in that case; decline or no answer authorizes no mutation. Explain and link any required approval source once without repeating skill routing in status replies. Once authorized and the plan is usable, report the path and branch, create the worktree with git worktree add, target all shell/file/MCP operations there, and run docket task start ${requestedTaskId} --compact --json there. Do not run docket task stop in the original checkout. Isolation alone does not authorize integration, cleanup or saving a preference.`;

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
      // Compatibility field: confirmation is the fallback only after the
      // agent checks applicable authority; the engine cannot infer it.
      requiresConfirmationByDefault: true,
      agentPrompt,
    },
  };
}
