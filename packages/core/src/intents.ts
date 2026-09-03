/**
 * Canonical agent authority and intent contract.
 *
 * These examples are product/evaluation fixtures, not substring-matching
 * rules. Agent surfaces may derive discovery text from this registry or
 * validate their own text against it, but routing remains harness-owned.
 */

export const DOCKET_INTENT_IDS = [
  "orientation",
  "backlog-hygiene",
  "pickup",
  "epic-supervision",
  "task-management",
  "project-maintenance",
] as const;

export type DocketIntentId = (typeof DOCKET_INTENT_IDS)[number];

export const DIRECT_WORK_INTENT_ID = "direct-work" as const;

export const AGENT_INTENT_IDS = [
  DIRECT_WORK_INTENT_ID,
  ...DOCKET_INTENT_IDS,
] as const;

export type AgentIntentId = (typeof AGENT_INTENT_IDS)[number];

export type IntentMode =
  | "pass-through"
  | "read-only"
  | "proposal-first"
  | "state-changing"
  | "operation-scoped";

export type IntentEntrypoint =
  | { kind: "direct"; value: string }
  | { kind: "command"; value: string }
  | { kind: "workflow"; value: string }
  | { kind: "named-operation"; value: string };

export interface AgentIntentContract {
  id: AgentIntentId;
  title: string;
  /** Mutually exclusive discovery summary for generated agent surfaces. */
  discovery: string;
  defaultEntrypoint: IntentEntrypoint;
  mode: IntentMode;
  authority: string;
  inspectionScope: string;
  positiveExamples: readonly string[];
  exclusions: readonly string[];
}

export type DocketIntentContract = AgentIntentContract & {
  id: DocketIntentId;
};

export const PICKUP_AUTHORITY_EVIDENCE = [
  "a Docket ID",
  "an unambiguous reference to an existing tracked item",
  "an explicit request for Docket or backlog selection",
] as const;

export const DIRECT_WORK_INTENT = {
  id: DIRECT_WORK_INTENT_ID,
  title: "Carry out direct user work",
  discovery:
    "Direct user work — execute a concrete product or repository request in the user's stated scope without Docket coordination.",
  defaultEntrypoint: {
    kind: "direct",
    value: "the user's concrete requested work",
  },
  mode: "pass-through",
  authority:
    "The concrete request authorizes only its stated product or repository scope; generic implementation language such as work, task, fix, or implement does not authorize Docket pickup or any tracker mutation.",
  inspectionScope:
    "Inspect and change only the product or repository surfaces needed for the user's concrete request, subject to the ordinary safety and approval policy of the harness.",
  positiveExamples: [
    "fix the mobile navigation overflow",
    "implement validation for this form",
    "update this documentation example",
  ],
  exclusions: [
    "a Docket ID or an unambiguous reference to an existing tracked item",
    "an explicit request for Docket or backlog selection",
    "a named Docket operation such as create, move, or close",
  ],
} as const satisfies AgentIntentContract;

export const DOCKET_INTENTS = {
  orientation: {
    id: "orientation",
    title: "Orient and review",
    discovery:
      "Read-only orientation — answer what is happening or what comes next from the shared Docket overview.",
    defaultEntrypoint: { kind: "command", value: "docket overview --json" },
    mode: "read-only",
    authority:
      "No confirmation is needed because the path may not mutate task, bundle, cache, index, or Git state.",
    inspectionScope:
      "Start with the structured overview; follow bundle links only when the requested explanation needs more evidence.",
    positiveExamples: [
      "what's next?",
      "where are we?",
      "let's review",
      "give me a status update",
    ],
    exclusions: [
      "an explicit request to groom or audit backlog hygiene",
      "an explicit request to start or continue implementation",
      "a named task mutation such as create, move, or close",
    ],
  },
  "backlog-hygiene": {
    id: "backlog-hygiene",
    title: "Audit backlog hygiene",
    discovery:
      "Full backlog hygiene audit — inspect stale or inconsistent work state and propose fixes before applying any mutation.",
    defaultEntrypoint: { kind: "workflow", value: "docket-groom" },
    mode: "proposal-first",
    authority:
      "The audit is read-only until the user confirms proposed fixes or has explicitly granted autonomous mechanical cleanup authority.",
    inspectionScope:
      "Inspect the Docket bundle and task-linked Git evidence required by the groom workflow, not unrelated product implementation files.",
    positiveExamples: [
      "groom the backlog",
      "audit our task hygiene",
      "find stale or inconsistent tickets",
    ],
    exclusions: [
      "ordinary review or what-is-next questions",
      "starting the highest-priority ready task",
      "a single named task operation",
    ],
  },
  pickup: {
    id: "pickup",
    title: "Pick up or continue work",
    discovery:
      "Start or resume explicitly tracked Docket work only — use a Docket ID, an unambiguous existing item, or explicit next/backlog selection; direct work bypasses Docket and ambiguous references require resolution before active-task state changes.",
    defaultEntrypoint: { kind: "workflow", value: "docket-pickup" },
    mode: "state-changing",
    authority:
      "Pickup requires positive tracked-work evidence: a Docket ID, an unambiguous reference to an existing tracked item, or an explicit request for Docket or backlog selection. Generic action language alone does not authorize pickup.",
    inspectionScope:
      "Use the engine-returned task, epic, dependencies, linked concepts, and commits before inspecting implementation files needed for the task.",
    positiveExamples: [
      "start DKT-12",
      "pick up the next Docket task",
      "continue work on DKT-12",
    ],
    exclusions: [
      "what-is-next questions without action language",
      "requests that explicitly say not to start or change anything",
      "generic implementation requests with no tracked-work evidence",
      "an unresolved or ambiguous tracked-item reference",
      "creating or closing a task as tracker administration",
    ],
  },
  "epic-supervision": {
    id: "epic-supervision",
    title: "Supervise an epic",
    discovery:
      "Run a named epic to completion — supervise ready child work through isolated workers or the mandatory serial fallback, verify integration, and return one completion or blocker receipt.",
    defaultEntrypoint: { kind: "workflow", value: "docket-epic" },
    mode: "state-changing",
    authority:
      "Explicit run, start, or supervise language applied to a named epic authorizes its ready child work and final epic review, but no unrelated task or speculative scheduler work.",
    inspectionScope:
      "Inspect the named epic, its child dependency graph, likely write overlap, task-linked Git evidence, and verification surfaces required to integrate and review that epic.",
    positiveExamples: [
      "run epic DKT-42 and come back when it is done",
      "start the DKT-42 epic",
      "supervise all ready work under DKT-42",
    ],
    exclusions: [
      "starting one named task",
      "ordinary epic status or review without action language",
      "building an orchestration service or changing unrelated work",
    ],
  },
  "task-management": {
    id: "task-management",
    title: "Manage a named work item",
    discovery:
      "Perform an explicit task operation — create, inspect, edit, move, log, stop, or close only the work item and derived surfaces in scope.",
    defaultEntrypoint: {
      kind: "named-operation",
      value: "the corresponding docket task command or workflow",
    },
    mode: "operation-scoped",
    authority:
      "The named operation supplies authority only for its documented mutations; read operations remain read-only and close follows its reconciliation workflow.",
    inspectionScope:
      "Inspect the named item and the linked concepts or derived surfaces required by that operation; do not broaden into backlog grooming.",
    positiveExamples: [
      "create an epic with these tickets",
      "move DKT-12 to blocked",
      "close DKT-12",
      "show me DKT-12",
    ],
    exclusions: [
      "general status or what-is-next questions",
      "a full backlog hygiene audit",
      "starting implementation unless pickup is also explicit",
    ],
  },
  "project-maintenance": {
    id: "project-maintenance",
    title: "Run named Docket maintenance",
    discovery:
      "Run an explicitly named Docket maintenance procedure such as freshness review or product-context refresh, using that workflow's own mutation contract.",
    defaultEntrypoint: {
      kind: "named-operation",
      value: "the explicitly requested maintenance workflow",
    },
    mode: "operation-scoped",
    authority:
      "Maintenance never acts as a fallback for orientation; the user must request the procedure or its concrete maintenance outcome.",
    inspectionScope:
      "Use only the evidence and repository writes named by the selected maintenance workflow.",
    positiveExamples: [
      "run a freshness review",
      "refresh the product context",
      "prepare the weekly standup report",
    ],
    exclusions: [
      "ordinary status or review requests",
      "backlog hygiene unless grooming is explicit",
      "task implementation or tracker mutation outside the named procedure",
    ],
  },
} as const satisfies Record<DocketIntentId, DocketIntentContract>;

export const AGENT_INTENTS = {
  [DIRECT_WORK_INTENT_ID]: DIRECT_WORK_INTENT,
  ...DOCKET_INTENTS,
} as const satisfies Record<AgentIntentId, AgentIntentContract>;

export const AGENT_INTENT_DISAMBIGUATION = [
  "A concrete product or repository request is direct work unless positive tracked-work evidence is present. Generic words such as work, task, fix, implement, or UX never supply pickup authority.",
  "Pickup is authorized only by a Docket ID, an unambiguous reference to an existing tracked item, or an explicit request for Docket or backlog selection.",
  "If a tracked-item reference cannot be resolved unambiguously, resolve or clarify that reference; never degrade to bare pickup or top-ready selection.",
  "Direct work does not create, start, stop, adopt, clear, or otherwise mutate .docket/active-task or any tracked item. Existing active or ready work does not change the direct request's scope.",
  "Ordinary review, status, and what-is-next language defaults to read-only orientation.",
  "Specific Docket action language beats a generic word such as review: groom or audit selects backlog hygiene; tracked start, pick up, resume, or continue selects pickup; run, start, or supervise a named epic selects epic supervision; a named tracker operation selects task management.",
  "A negative constraint such as do not start narrows permitted actions but never selects a broader workflow by itself.",
  "Combined operations retain separate authority: creating a task does not start it unless pickup is also explicit, while track this and start it authorizes both bounded operations in sequence.",
  "No intent may mutate outside its declared authority, and every Docket workflow is opt-in rather than a fallback for direct work.",
] as const;

/** @deprecated Use AGENT_INTENT_DISAMBIGUATION for the complete boundary. */
export const DOCKET_INTENT_DISAMBIGUATION = AGENT_INTENT_DISAMBIGUATION;

export function agentIntent(id: AgentIntentId): AgentIntentContract {
  return AGENT_INTENTS[id];
}

export function docketIntent(id: DocketIntentId): DocketIntentContract {
  return DOCKET_INTENTS[id];
}
