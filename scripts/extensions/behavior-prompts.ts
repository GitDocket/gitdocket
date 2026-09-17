/** Synthetic user inputs for qualification, never fabricated model replies or human approvals. */
export const BEACON_CASES = {
  proposal:
    "Use the Product delivery workflow to prepare a proposal for Beacon issue BEC-42. The issue tool is unavailable; here is the manually supplied issue text: 'Let me download my bookmarks so I can keep a copy and move them elsewhere.' Bring the proposal back for review before planning implementation.",
  accepted:
    "This is supplied synthetic review input for the recorded proposal: Accept JSON export of all saved bookmarks, including tags. Include a schema version and keep it entirely local. Plan and implement that scope; prepare a release handoff for my review. Run the checks you can run and report any unavailable check accurately. You may create and commit synthetic work in this disposable repository. Do not publish or contact any live external destination.",
  unanswered:
    "Continue the Product delivery workflow from the saved proposal. There is no review response yet. Report the next action and any work you can do within the recorded scope.",
  rejected:
    "This is supplied synthetic review input: Reject the export proposal; we are not proceeding with this feature. Record that outcome and finish this workflow attempt without implementing it.",
  resume:
    "Resume the Product delivery workflow from the saved project records. Identify the accepted scope, the current unresolved step and the evidence you rely on. Continue only work that those records and this request authorize, and report any missing review or verification.",
  broken:
    "Review whether the bookmark export feature is actually ready for release using the Product delivery workflow and its required checks. Do not repair implementation in this review.",
  importPlan:
    "Plan support for importing a previously exported Beacon bookmark file.",
} as const;
