import {
  REENTRY_CONTEXT_V1_FORMAT,
  type StateOfPlayView,
} from "@gitdocket/core";
import type { GitEvidence } from "@gitdocket/core/cache";
import type { OverviewModel } from "@gitdocket/core/overview";

const ageLine = (context: StateOfPlayView): string =>
  `as of ${context.asOf.slice(0, 7)}, ${
    context.taskCommitsAgo === null
      ? "task-linked age unavailable"
      : `${context.taskCommitsAgo} task-linked commits ago`
  }`;

const reviewLabel = (context: StateOfPlayView): string =>
  context.review.status === "needs-review"
    ? " — context needs review"
    : context.review.status === "age-unavailable"
      ? " — evidence age unavailable"
      : "";

const narrativeLines = (context: StateOfPlayView): string[] => {
  if (context.format === "legacy") {
    return [
      "Earlier state of play — context needs review",
      context.body,
      ageLine(context),
      "",
    ];
  }

  if (context.format === REENTRY_CONTEXT_V1_FORMAT) {
    return [
      "Earlier product context — context needs review",
      context.body,
      `${ageLine(context)}; reviewed ${context.reviewedAt}`,
      "",
    ];
  }

  return [
    `Project re-entry${reviewLabel(context)}`,
    "What we've done recently",
    context.recent,
    "",
    "What's up next",
    context.next,
    ...(context.worthKnowing
      ? ["", "Worth knowing", context.worthKnowing]
      : []),
    "",
    `${ageLine(context)}; reviewed ${context.reviewedAt}`,
    "",
  ];
};

/** The human briefing is the authored note; the core model remains available as JSON. */
export function renderOverview(
  _model: OverviewModel,
  narrative?: StateOfPlayView,
  git?: GitEvidence,
): string {
  const briefing = narrative
    ? narrativeLines(narrative).join("\n").trimEnd()
    : "Project re-entry\nNo usable project re-entry note is available.";
  if (!git) return briefing;
  if (git.status === "history-unavailable") {
    return `${briefing}\n\nGit evidence unavailable — ${git.reason ?? "history could not be inspected"}.`;
  }

  const worktrees = git.worktrees.filter(
    (worktree) =>
      !worktree.current &&
      (!worktree.available ||
        worktree.dirty ||
        worktree.activeTaskId ||
        worktree.mergedIntoCurrentHead === false),
  );
  if (git.unmergedActivity.length === 0 && worktrees.length === 0)
    return briefing;

  const lines = ["", "Unmerged Git evidence"];
  for (const entry of git.unmergedActivity.slice(0, 5)) {
    const source = [...entry.refs, ...entry.worktrees].join(", ");
    lines.push(
      `- ${entry.taskId} ${entry.sha.slice(0, 7)} ${entry.subject}${source ? ` — ${source}` : ""}`,
    );
  }
  for (const worktree of worktrees.slice(0, 5)) {
    const state = !worktree.available
      ? "unavailable"
      : [
          worktree.activeTaskId && `active ${worktree.activeTaskId}`,
          worktree.dirty && "dirty",
          worktree.mergedIntoCurrentHead === false && "unmerged HEAD",
        ]
          .filter(Boolean)
          .join(", ");
    lines.push(`- worktree ${worktree.path} — ${state}`);
  }
  if (
    git.truncated ||
    git.unmergedActivity.length > 5 ||
    worktrees.length > 5
  ) {
    lines.push("- more local Git evidence is available in the JSON/API model");
  }
  return `${briefing}\n${lines.join("\n")}`;
}
