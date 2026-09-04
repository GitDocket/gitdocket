import {
  REENTRY_CONTEXT_V1_FORMAT,
  type StateOfPlayView,
} from "@gitdocket/core";
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
): string {
  return narrative
    ? narrativeLines(narrative).join("\n").trimEnd()
    : "Project re-entry\nNo usable project re-entry note is available.";
}
