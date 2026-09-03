import {
  AGENT_INTENT_IDS,
  AGENT_INTENTS,
  type AgentIntentContract,
  type AgentIntentId,
  DOCKET_INTENT_IDS,
  DOCKET_INTENTS,
  type DocketIntentContract,
  type DocketIntentId,
  type IntentEntrypoint,
} from "./intents";

/**
 * Evaluation fixtures for the harness-owned natural-language routing step.
 *
 * These are expected outcomes, not a substring classifier. Deterministic
 * tests can prove that every generated surface exposes the same contract and
 * budgets; a bounded dogfood replay is still required to observe model choice.
 */

export type PromptRoutingTrait =
  | "ambiguous-wording"
  | "combined-intents"
  | "direct-work-regression"
  | "negative-constraint"
  | "pickup-control"
  | "orientation-no-write-regression"
  | "tracked-reference-resolution";

export interface PromptRoutingFixture {
  id: string;
  prompt: string;
  expectedIntent: AgentIntentId;
  /** Additional independently authorized intents composed by the prompt. */
  composedIntents?: readonly AgentIntentId[];
  expectedEntrypoint: IntentEntrypoint;
  /** The complete Docket command budget before further scope is granted. */
  allowedCommands: readonly string[];
  /** Exact repository write paths authorized by a direct-work prompt. */
  permittedWritePaths?: readonly string[];
  /** Canonical upper bound on evidence the selected path may inspect. */
  maximumInspectionScope: string;
  /** Whether this prompt itself authorizes repository writes. */
  writesPermitted: boolean;
  /** Operations made explicitly unavailable by the prompt or intent. */
  forbiddenActions: readonly string[];
  /** Generated-surface text that must expose this fixture's boundary. */
  surfaceEvidence?: readonly string[];
  traits?: readonly PromptRoutingTrait[];
}

const scope = (id: AgentIntentId): string => AGENT_INTENTS[id].inspectionScope;

const DIRECT_WORK_FORBIDDEN_ACTIONS = [
  "docket task create",
  "docket task start",
  "task or index mutation",
  "adopt existing .docket/active-task",
  "clear existing .docket/active-task",
] as const;

export const PROMPT_ROUTING_FIXTURES: readonly PromptRoutingFixture[] = [
  {
    id: "direct-concrete-ux-request",
    prompt:
      "Work on this UX concern: in ui/mobile-settings-card.css only, change the mobile card gap from 8px to 12px. Do not change anything else.",
    expectedIntent: "direct-work",
    expectedEntrypoint: {
      kind: "direct",
      value: "the user's concrete requested work",
    },
    allowedCommands: [],
    permittedWritePaths: ["ui/mobile-settings-card.css"],
    maximumInspectionScope: scope("direct-work"),
    writesPermitted: true,
    forbiddenActions: [
      ...DIRECT_WORK_FORBIDDEN_ACTIONS,
      "edit outside ui/mobile-settings-card.css",
    ],
    surfaceEvidence: [
      "concrete direct request proceeds",
      "generic implementation language is not pickup authority",
    ],
    traits: ["direct-work-regression", "negative-constraint"],
  },
  {
    id: "direct-generic-fix",
    prompt:
      "Fix the label typo in src/format-label.ts only, changing 'Setings' to 'Settings'.",
    expectedIntent: "direct-work",
    expectedEntrypoint: {
      kind: "direct",
      value: "the user's concrete requested work",
    },
    allowedCommands: [],
    permittedWritePaths: ["src/format-label.ts"],
    maximumInspectionScope: scope("direct-work"),
    writesPermitted: true,
    forbiddenActions: [
      ...DIRECT_WORK_FORBIDDEN_ACTIONS,
      "edit outside src/format-label.ts",
    ],
    surfaceEvidence: [
      "concrete direct request proceeds",
      "generic implementation language is not pickup authority",
    ],
    traits: ["direct-work-regression"],
  },
  {
    id: "pickup-ambiguous-tracked-reference",
    prompt: "Continue the login task in Docket.",
    expectedIntent: "pickup",
    expectedEntrypoint: {
      kind: "command",
      value: 'docket search "login" --json',
    },
    allowedCommands: ['docket search "login" --json'],
    maximumInspectionScope: scope("pickup"),
    writesPermitted: false,
    forbiddenActions: [
      "docket task start",
      "docket index",
      "adopt or clear .docket/active-task",
      "substitute the top ready task",
    ],
    surfaceEvidence: [
      "reference remains ambiguous",
      "never fall back to an unrelated top-ready item",
    ],
    traits: [
      "ambiguous-wording",
      "pickup-control",
      "tracked-reference-resolution",
    ],
  },
  {
    id: "orientation-whats-next",
    prompt: "What's next in Docket?",
    expectedIntent: "orientation",
    expectedEntrypoint: {
      kind: "command",
      value: "docket overview --json",
    },
    allowedCommands: ["docket overview --json"],
    maximumInspectionScope: scope("orientation"),
    writesPermitted: false,
    forbiddenActions: [
      "docket task start",
      "docket index",
      "docket-groom",
      "repository-wide search",
    ],
  },
  {
    id: "orientation-ordinary-review",
    prompt: "Let's review where the project stands before deciding what to do.",
    expectedIntent: "orientation",
    expectedEntrypoint: {
      kind: "command",
      value: "docket overview --json",
    },
    allowedCommands: ["docket overview --json"],
    maximumInspectionScope: scope("orientation"),
    writesPermitted: false,
    forbiddenActions: ["docket task start", "docket index", "docket-groom"],
    traits: ["ambiguous-wording"],
  },
  {
    id: "orientation-whats-next-review-only",
    prompt: "What's next in Docket? Don't start it, let's just review.",
    expectedIntent: "orientation",
    expectedEntrypoint: {
      kind: "command",
      value: "docket overview --json",
    },
    allowedCommands: ["docket overview --json"],
    maximumInspectionScope: scope("orientation"),
    writesPermitted: false,
    forbiddenActions: [
      "docket task start",
      "docket index",
      "docket-groom",
      "repository-wide search",
    ],
    traits: [
      "ambiguous-wording",
      "negative-constraint",
      "orientation-no-write-regression",
    ],
  },
  {
    id: "groom-explicit-hygiene",
    prompt: "Groom the backlog and report stale or inconsistent tasks.",
    expectedIntent: "backlog-hygiene",
    expectedEntrypoint: { kind: "workflow", value: "docket-groom" },
    allowedCommands: ["docket ready --json", "docket task list --json"],
    maximumInspectionScope: scope("backlog-hygiene"),
    writesPermitted: false,
    forbiddenActions: [
      "apply proposed fixes before confirmation",
      "inspect unrelated product implementation",
    ],
  },
  {
    id: "groom-review-audit-no-fixes",
    prompt: "Review task hygiene for stale tickets, but don't apply any fixes.",
    expectedIntent: "backlog-hygiene",
    expectedEntrypoint: { kind: "workflow", value: "docket-groom" },
    allowedCommands: ["docket ready --json", "docket task list --json"],
    maximumInspectionScope: scope("backlog-hygiene"),
    writesPermitted: false,
    forbiddenActions: ["docket task move", "docket task close", "docket index"],
    traits: ["ambiguous-wording", "negative-constraint"],
  },
  {
    id: "pickup-named-start",
    prompt: "Start DKT-12.",
    expectedIntent: "pickup",
    expectedEntrypoint: { kind: "workflow", value: "docket-pickup" },
    allowedCommands: ["docket task start DKT-12 --json"],
    maximumInspectionScope: scope("pickup"),
    writesPermitted: true,
    forbiddenActions: ["docket task close", "docket-groom"],
    surfaceEvidence: ["supplies a Docket ID"],
    traits: ["pickup-control"],
  },
  {
    id: "pickup-explicit-next-docket-task",
    prompt: "Pick up the next Docket task.",
    expectedIntent: "pickup",
    expectedEntrypoint: { kind: "workflow", value: "docket-pickup" },
    allowedCommands: ["docket task start --json"],
    maximumInspectionScope: scope("pickup"),
    writesPermitted: true,
    forbiddenActions: [
      "docket task create",
      "docket index",
      "start any task other than the engine-selected top ready task",
    ],
    surfaceEvidence: [
      "permitted only for explicit next-Docket-task or backlog selection",
    ],
    traits: ["pickup-control"],
  },
  {
    id: "pickup-named-continuation",
    prompt: "Continue work on DKT-12, but don't close it.",
    expectedIntent: "pickup",
    expectedEntrypoint: { kind: "workflow", value: "docket-pickup" },
    allowedCommands: ["docket task start DKT-12 --json"],
    maximumInspectionScope: scope("pickup"),
    writesPermitted: true,
    forbiddenActions: ["docket task close", "docket index", "docket-groom"],
    traits: ["negative-constraint"],
  },
  {
    id: "epic-supervision-named-run",
    prompt: "Run epic DKT-42 and come back when the whole epic is done.",
    expectedIntent: "epic-supervision",
    expectedEntrypoint: { kind: "workflow", value: "docket-epic" },
    allowedCommands: [
      "docket task list --epic DKT-42 --all --json",
      "docket ready --json",
      "docket task start <child-ID> --json",
      "docket task close <child-ID> --json",
      "docket index",
    ],
    maximumInspectionScope: scope("epic-supervision"),
    writesPermitted: true,
    forbiddenActions: [
      "mutate unrelated tasks",
      "share one checkout between concurrent workers",
      "treat child completion as epic completion",
      "create a competing orchestration database",
    ],
  },
  {
    id: "task-move-named",
    prompt: "Move DKT-12 to blocked and note that the API decision is pending.",
    expectedIntent: "task-management",
    expectedEntrypoint: {
      kind: "command",
      value:
        'docket task move DKT-12 blocked --note "the API decision is pending" --json',
    },
    allowedCommands: [
      'docket task move DKT-12 blocked --note "the API decision is pending" --json',
    ],
    maximumInspectionScope: scope("task-management"),
    writesPermitted: true,
    forbiddenActions: ["docket task start", "docket-groom"],
  },
  {
    id: "task-close-named",
    prompt: "Close DKT-12 after checking its acceptance criteria.",
    expectedIntent: "task-management",
    expectedEntrypoint: { kind: "workflow", value: "docket-close" },
    allowedCommands: ["docket task close DKT-12 --json", "docket index"],
    maximumInspectionScope: scope("task-management"),
    writesPermitted: true,
    forbiddenActions: ["docket task start", "docket-groom"],
  },
  {
    id: "task-create-named",
    prompt: "Create a p1 task named Harden exports, but don't start it.",
    expectedIntent: "task-management",
    expectedEntrypoint: { kind: "workflow", value: "docket-task" },
    allowedCommands: [
      'docket task create --title "Harden exports" --priority p1 --json',
      "docket index",
    ],
    maximumInspectionScope: scope("task-management"),
    writesPermitted: true,
    forbiddenActions: ["docket task start", "docket-groom"],
    traits: ["negative-constraint"],
  },
  {
    id: "task-create-and-start",
    prompt: "Track a p1 task named Harden exports and start it.",
    expectedIntent: "task-management",
    composedIntents: ["pickup"],
    expectedEntrypoint: { kind: "workflow", value: "docket-task" },
    allowedCommands: [
      'docket task create --title "Harden exports" --priority p1 --json',
      "docket index",
      "docket task start <created-ID> --json",
    ],
    maximumInspectionScope: scope("task-management"),
    writesPermitted: true,
    forbiddenActions: [
      "bare docket task start --json",
      "start a task other than the newly created ID",
      "docket-groom",
    ],
    surfaceEvidence: ["supplies a Docket ID"],
    traits: ["combined-intents", "pickup-control"],
  },
  {
    id: "maintenance-standup",
    prompt: "Prepare the weekly standup report without changing anything.",
    expectedIntent: "project-maintenance",
    expectedEntrypoint: { kind: "workflow", value: "docket-standup" },
    allowedCommands: ["docket task list --json", "docket ready --json"],
    maximumInspectionScope: scope("project-maintenance"),
    writesPermitted: false,
    forbiddenActions: ["task mutation", "docket index", "docket-groom"],
    traits: ["negative-constraint"],
  },
];

export type PromptRoutingDiagnosticCode =
  | "duplicate-fixture"
  | "missing-intent-coverage"
  | "missing-trait-coverage"
  | "entrypoint-drift"
  | "inspection-scope-drift"
  | "write-boundary-drift"
  | "empty-command-budget"
  | "direct-work-regression"
  | "ambiguous-pickup-regression"
  | "pickup-control-regression"
  | "combined-intent-regression"
  | "orientation-no-write-regression";

export interface PromptRoutingDiagnostic {
  code: PromptRoutingDiagnosticCode;
  fixture?: string;
  message: string;
}

const sameEntrypoint = (a: IntentEntrypoint, b: IntentEntrypoint): boolean =>
  a.kind === b.kind && a.value === b.value;

/** Release guard for fixture completeness and canonical scope/mutation data. */
export function validatePromptRoutingFixtures(
  fixtures: readonly PromptRoutingFixture[],
  intents: Readonly<Record<AgentIntentId, AgentIntentContract>> = AGENT_INTENTS,
): PromptRoutingDiagnostic[] {
  const diagnostics: PromptRoutingDiagnostic[] = [];
  const seen = new Set<string>();

  for (const fixture of fixtures) {
    if (seen.has(fixture.id)) {
      diagnostics.push({
        code: "duplicate-fixture",
        fixture: fixture.id,
        message: "fixture id is duplicated",
      });
    }
    seen.add(fixture.id);

    const intent = intents[fixture.expectedIntent];
    if (fixture.maximumInspectionScope !== intent.inspectionScope) {
      diagnostics.push({
        code: "inspection-scope-drift",
        fixture: fixture.id,
        message: `maximum inspection scope differs from ${intent.id}`,
      });
    }
    if (
      fixture.allowedCommands.length === 0 &&
      fixture.expectedIntent !== "direct-work"
    ) {
      diagnostics.push({
        code: "empty-command-budget",
        fixture: fixture.id,
        message: "fixture has no bounded command budget",
      });
    }
    if (intent.mode === "read-only" && fixture.writesPermitted) {
      diagnostics.push({
        code: "write-boundary-drift",
        fixture: fixture.id,
        message: "a read-only intent cannot permit repository writes",
      });
    }
    if (
      intent.defaultEntrypoint.kind !== "named-operation" &&
      !fixture.traits?.includes("tracked-reference-resolution") &&
      !sameEntrypoint(fixture.expectedEntrypoint, intent.defaultEntrypoint)
    ) {
      diagnostics.push({
        code: "entrypoint-drift",
        fixture: fixture.id,
        message: `entrypoint differs from ${intent.id}`,
      });
    }
  }

  for (const id of AGENT_INTENT_IDS) {
    if (!fixtures.some((fixture) => fixture.expectedIntent === id)) {
      diagnostics.push({
        code: "missing-intent-coverage",
        message: `no prompt fixture covers ${id}`,
      });
    }
  }

  const directFixtures = fixtures.filter((fixture) =>
    fixture.traits?.includes("direct-work-regression"),
  );
  const directFixturesValid =
    directFixtures.length >= 2 &&
    directFixtures.every(
      (fixture) =>
        fixture.expectedIntent === "direct-work" &&
        sameEntrypoint(fixture.expectedEntrypoint, {
          kind: "direct",
          value: "the user's concrete requested work",
        }) &&
        fixture.allowedCommands.length === 0 &&
        fixture.permittedWritePaths?.length === 1 &&
        fixture.writesPermitted &&
        DIRECT_WORK_FORBIDDEN_ACTIONS.every((action) =>
          fixture.forbiddenActions.includes(action),
        ),
    );
  if (!directFixturesValid) {
    diagnostics.push({
      code: "direct-work-regression",
      message:
        "direct-work fixtures must authorize one requested path, zero Docket commands, and no tracker or active-marker mutation",
    });
  }

  const ambiguousPickup = fixtures.find(
    (fixture) => fixture.id === "pickup-ambiguous-tracked-reference",
  );
  if (
    ambiguousPickup?.expectedIntent !== "pickup" ||
    ambiguousPickup.expectedEntrypoint.kind !== "command" ||
    ambiguousPickup.allowedCommands.length !== 1 ||
    ambiguousPickup.allowedCommands[0] !== 'docket search "login" --json' ||
    ambiguousPickup.writesPermitted ||
    !ambiguousPickup.forbiddenActions.includes("docket task start") ||
    !ambiguousPickup.forbiddenActions.includes("substitute the top ready task")
  ) {
    diagnostics.push({
      code: "ambiguous-pickup-regression",
      fixture: ambiguousPickup?.id,
      message:
        "an ambiguous tracked reference must allow focused resolution only and forbid pickup mutation or top-ready substitution",
    });
  }

  const namedPickup = fixtures.find(
    (fixture) => fixture.id === "pickup-named-start",
  );
  const nextPickup = fixtures.find(
    (fixture) => fixture.id === "pickup-explicit-next-docket-task",
  );
  if (
    namedPickup?.allowedCommands[0] !== "docket task start DKT-12 --json" ||
    nextPickup?.allowedCommands[0] !== "docket task start --json"
  ) {
    diagnostics.push({
      code: "pickup-control-regression",
      message:
        "named pickup must stay named while explicit next-Docket pickup retains the bare engine selection command",
    });
  }

  const createAndStart = fixtures.find(
    (fixture) => fixture.id === "task-create-and-start",
  );
  if (
    createAndStart?.expectedIntent !== "task-management" ||
    !createAndStart.composedIntents?.includes("pickup") ||
    !createAndStart.allowedCommands.includes(
      "docket task start <created-ID> --json",
    ) ||
    createAndStart.allowedCommands.includes("docket task start --json")
  ) {
    diagnostics.push({
      code: "combined-intent-regression",
      fixture: createAndStart?.id,
      message:
        "track-and-start must compose task creation with named pickup of the created ID, never bare pickup",
    });
  }
  for (const trait of ["ambiguous-wording", "negative-constraint"] as const) {
    if (!fixtures.some((fixture) => fixture.traits?.includes(trait))) {
      diagnostics.push({
        code: "missing-trait-coverage",
        message: `no prompt fixture covers ${trait}`,
      });
    }
  }

  const orientationNoWrite = fixtures.find((fixture) =>
    fixture.traits?.includes("orientation-no-write-regression"),
  );
  let orientationNoWriteValid = false;
  if (orientationNoWrite) {
    orientationNoWriteValid =
      orientationNoWrite.expectedIntent === "orientation" &&
      sameEntrypoint(orientationNoWrite.expectedEntrypoint, {
        kind: "command",
        value: "docket overview --json",
      }) &&
      !orientationNoWrite.writesPermitted &&
      orientationNoWrite.allowedCommands.length === 1 &&
      orientationNoWrite.allowedCommands[0] === "docket overview --json" &&
      orientationNoWrite.forbiddenActions.includes("docket task start") &&
      orientationNoWrite.forbiddenActions.includes("docket index") &&
      orientationNoWrite.forbiddenActions.includes("repository-wide search");
  }
  if (!orientationNoWriteValid) {
    diagnostics.push({
      code: "orientation-no-write-regression",
      fixture: orientationNoWrite?.id,
      message:
        "review-only orientation must select overview, forbid writes, and stay out of broad repository search",
    });
  }

  return diagnostics;
}

export type IntentDiscoveryDiagnosticCode =
  | "description-overlap"
  | "missing-description-signature"
  | "example-overlap";

export interface IntentDiscoveryDiagnostic {
  code: IntentDiscoveryDiagnosticCode;
  intent: DocketIntentId;
  otherIntent?: DocketIntentId;
  message: string;
}

const DISCOVERY_SIGNATURES: Readonly<
  Record<DocketIntentId, readonly string[]>
> = {
  orientation: ["read-only orientation", "what comes next"],
  "backlog-hygiene": ["backlog hygiene audit", "stale or inconsistent"],
  pickup: [
    "start or resume explicitly tracked docket work",
    "active-task state",
  ],
  "epic-supervision": ["run a named epic to completion", "serial fallback"],
  "task-management": ["explicit task operation", "only the work item"],
  "project-maintenance": [
    "explicitly named docket maintenance",
    "using that workflow",
  ],
};

const normalized = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Release guard for mutually exclusive discovery summaries. Signatures are
 * deliberately narrow labels, not prompt-matching rules.
 */
export function validateIntentDiscoveryDescriptions(
  intents: Readonly<
    Record<DocketIntentId, DocketIntentContract>
  > = DOCKET_INTENTS,
): IntentDiscoveryDiagnostic[] {
  const diagnostics: IntentDiscoveryDiagnostic[] = [];

  for (const id of DOCKET_INTENT_IDS) {
    const description = normalized(intents[id].discovery);
    const own = DISCOVERY_SIGNATURES[id];
    if (
      !own.every((signature) => description.includes(normalized(signature)))
    ) {
      diagnostics.push({
        code: "missing-description-signature",
        intent: id,
        message: `discovery summary is missing the exclusive ${id} signature`,
      });
    }
    for (const other of DOCKET_INTENT_IDS) {
      if (other === id) continue;
      for (const signature of DISCOVERY_SIGNATURES[other]) {
        if (!description.includes(normalized(signature))) continue;
        diagnostics.push({
          code: "description-overlap",
          intent: id,
          otherIntent: other,
          message: `discovery summary includes the ${other} signature “${signature}”`,
        });
      }
    }
  }

  const examples = new Map<string, DocketIntentId>();
  for (const id of DOCKET_INTENT_IDS) {
    for (const example of intents[id].positiveExamples) {
      const key = normalized(example);
      const previous = examples.get(key);
      if (previous && previous !== id) {
        diagnostics.push({
          code: "example-overlap",
          intent: id,
          otherIntent: previous,
          message: `positive example “${example}” belongs to both intents`,
        });
      } else {
        examples.set(key, id);
      }
    }
  }

  return diagnostics;
}
