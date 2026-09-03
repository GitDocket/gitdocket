import { describe, expect, test } from "bun:test";
import {
  AGENT_INTENT_DISAMBIGUATION,
  AGENT_INTENT_IDS,
  AGENT_INTENTS,
  agentIntent,
  DIRECT_WORK_INTENT_ID,
  DOCKET_INTENT_DISAMBIGUATION,
  DOCKET_INTENT_IDS,
  DOCKET_INTENTS,
  docketIntent,
  PICKUP_AUTHORITY_EVIDENCE,
} from "./intents";
import { DOCKET_WORKFLOWS } from "./workflows";

describe("Docket intent contract", () => {
  test("defines the strict common-intent contract", () => {
    expect(AGENT_INTENT_IDS).toEqual([
      "direct-work",
      "orientation",
      "backlog-hygiene",
      "pickup",
      "epic-supervision",
      "task-management",
      "project-maintenance",
    ]);
    expect(Object.keys(AGENT_INTENTS)).toEqual([...AGENT_INTENT_IDS]);
    expect(DOCKET_INTENT_IDS).toEqual([
      "orientation",
      "backlog-hygiene",
      "pickup",
      "epic-supervision",
      "task-management",
      "project-maintenance",
    ]);
    expect(Object.keys(DOCKET_INTENTS)).toEqual([...DOCKET_INTENT_IDS]);

    expect(DOCKET_INTENT_IDS).not.toContain(DIRECT_WORK_INTENT_ID);

    for (const id of AGENT_INTENT_IDS) {
      const intent = agentIntent(id);
      expect(intent.id).toBe(id);
      expect(intent.discovery.length).toBeGreaterThan(20);
      expect(intent.authority.length).toBeGreaterThan(20);
      expect(intent.inspectionScope.length).toBeGreaterThan(20);
      expect(intent.positiveExamples.length).toBeGreaterThan(1);
      expect(intent.exclusions.length).toBeGreaterThan(1);
    }
  });

  test("keeps concrete direct work outside Docket coordination", () => {
    const direct = agentIntent("direct-work");
    expect(direct.defaultEntrypoint).toEqual({
      kind: "direct",
      value: "the user's concrete requested work",
    });
    expect(direct.mode).toBe("pass-through");
    expect(direct.authority).toContain("generic implementation language");
    expect(direct.authority).toContain("does not authorize Docket pickup");

    const boundary = AGENT_INTENT_DISAMBIGUATION.join(" ");
    expect(boundary).toContain("never supply pickup authority");
    expect(boundary).toContain("does not create, start, stop, adopt, clear");
    expect(boundary).toContain(".docket/active-task");
  });

  test("makes ordinary review a bounded read-only overview", () => {
    const orientation = docketIntent("orientation");
    expect(orientation.defaultEntrypoint).toEqual({
      kind: "command",
      value: "docket overview --json",
    });
    expect(orientation.mode).toBe("read-only");
    expect(orientation.positiveExamples).toContain("what's next?");
    expect(orientation.positiveExamples).toContain("let's review");
    expect(orientation.inspectionScope).toContain("structured overview");
  });

  test("keeps hygiene proposal-first and pickup gated by tracked-work evidence", () => {
    const hygiene = docketIntent("backlog-hygiene");
    expect(hygiene.defaultEntrypoint).toEqual({
      kind: "workflow",
      value: "docket-groom",
    });
    expect(hygiene.mode).toBe("proposal-first");
    expect(hygiene.exclusions.join(" ")).toContain("ordinary review");

    const pickup = docketIntent("pickup");
    expect(pickup.defaultEntrypoint).toEqual({
      kind: "workflow",
      value: "docket-pickup",
    });
    expect(pickup.mode).toBe("state-changing");
    for (const evidence of PICKUP_AUTHORITY_EVIDENCE) {
      expect(pickup.authority).toContain(evidence);
    }
    expect(pickup.authority).toContain(
      "Generic action language alone does not authorize pickup",
    );
    expect(pickup.positiveExamples).toContain("pick up the next Docket task");
    expect(pickup.exclusions).toContain(
      "generic implementation requests with no tracked-work evidence",
    );

    const epic = docketIntent("epic-supervision");
    expect(epic.defaultEntrypoint).toEqual({
      kind: "workflow",
      value: "docket-epic",
    });
    expect(epic.mode).toBe("state-changing");
    expect(epic.authority).toContain("named epic");
  });

  test("treats negative constraints as permission narrowing, not routing", () => {
    expect(DOCKET_INTENT_DISAMBIGUATION.join(" ")).toContain("do not start");
    expect(DOCKET_INTENT_DISAMBIGUATION.join(" ")).toContain(
      "narrows permitted actions",
    );
  });

  test("fails closed for ambiguous tracked references and composes creation with pickup", () => {
    const boundary = AGENT_INTENT_DISAMBIGUATION.join(" ");
    expect(boundary).toContain("resolve or clarify");
    expect(boundary).toContain("never degrade to bare pickup");
    expect(boundary).toContain("top-ready selection");
    expect(boundary).toContain("creating a task does not start it");
    expect(boundary).toContain("track this and start it");
  });

  test("assigns every shipped workflow to a declared intent", () => {
    for (const workflow of DOCKET_WORKFLOWS) {
      expect(DOCKET_INTENT_IDS).toContain(workflow.intent);
      expect(workflow.intent).not.toBe(DIRECT_WORK_INTENT_ID);
    }
    expect(
      DOCKET_WORKFLOWS.find((workflow) => workflow.slug === "docket-groom")
        ?.intent,
    ).toBe("backlog-hygiene");
    expect(
      DOCKET_WORKFLOWS.find((workflow) => workflow.slug === "docket-pickup")
        ?.intent,
    ).toBe("pickup");
    expect(
      DOCKET_WORKFLOWS.find((workflow) => workflow.slug === "docket-epic")
        ?.intent,
    ).toBe("epic-supervision");
  });
});
