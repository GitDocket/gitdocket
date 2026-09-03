/**
 * Canonical agent-facing descriptions of engine-owned task semantics.
 *
 * Execution remains in states.ts, bundle.ts, and ops.ts. Shipped workflows
 * and command adapters interpolate these claims instead of restating them,
 * while workflow guard tests exercise the executable behavior behind them.
 */

export const ENGINE_SEMANTICS = {
  readiness:
    "Ready is derived, never written: a task is ready only when its stored status is `todo` and every dependency resolves to `done`; an unknown dependency blocks it.",
  readyOrdering:
    "The ready queue puts ranked tasks first by ascending `rank`; rank ties and the unranked tail use priority (`p0` through `p3`), then ascending task ID as the stable fallback.",
  transitions:
    "Stored status changes go through the engine's canonical transition table; invalid transitions are rejected, `done` and `closed` are terminal, and moving to `closed` requires a disposition note. Only `done` satisfies dependencies or counts as completion.",
  mutationOwnership: {
    pickup:
      "The engine owns task selection, the state-machine-checked status transition, active-task state, title derivation, and the context packet; the pickup workflow owns only their sequence, and a native adapter owns only its bounded rename binding.",
    grooming:
      "The engine owns ready/list derivation and task mutation mechanics; the groom workflow owns audit judgment, proposed changes, and the authorization boundary.",
    close:
      "The engine owns the state-machine-checked terminal move and dated Log mutation; the close workflow owns the choice between completion (`done`) and non-completion (`closed`), Outcome or Disposition judgment, documentation review, and derived index/log reconciliation.",
  },
} as const;

export const READY_QUEUE_DESCRIPTION = `${ENGINE_SEMANTICS.readiness} ${ENGINE_SEMANTICS.readyOrdering}`;
