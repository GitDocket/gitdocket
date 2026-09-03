import { describe, expect, test } from "bun:test";
import {
  AGENT_INTENT_IDS,
  AGENT_INTENTS,
  DOCKET_INTENT_IDS,
  DOCKET_INTENTS,
  type DocketIntentContract,
  type DocketIntentId,
} from "./intents";
import {
  PROMPT_ROUTING_FIXTURES,
  type PromptRoutingFixture,
  validateIntentDiscoveryDescriptions,
  validatePromptRoutingFixtures,
} from "./prompt-routing";

describe("prompt-routing fixture contract", () => {
  test("covers every agent intent, ambiguity, negative constraints, and bounded authority", () => {
    expect(validatePromptRoutingFixtures(PROMPT_ROUTING_FIXTURES)).toEqual([]);

    for (const id of AGENT_INTENT_IDS) {
      expect(
        PROMPT_ROUTING_FIXTURES.some(
          (fixture) => fixture.expectedIntent === id,
        ),
      ).toBe(true);
    }
    expect(
      PROMPT_ROUTING_FIXTURES.some((fixture) =>
        fixture.traits?.includes("ambiguous-wording"),
      ),
    ).toBe(true);
    expect(
      PROMPT_ROUTING_FIXTURES.some((fixture) =>
        fixture.traits?.includes("negative-constraint"),
      ),
    ).toBe(true);

    for (const fixture of PROMPT_ROUTING_FIXTURES) {
      if (fixture.expectedIntent === "direct-work") {
        expect(fixture.allowedCommands).toEqual([]);
        expect(fixture.permittedWritePaths?.length).toBe(1);
      } else {
        expect(fixture.allowedCommands.length).toBeGreaterThan(0);
      }
      expect(fixture.maximumInspectionScope).toBe(
        AGENT_INTENTS[fixture.expectedIntent].inspectionScope,
      );
      expect(typeof fixture.writesPermitted).toBe("boolean");
      expect(fixture.forbiddenActions.length).toBeGreaterThan(0);
    }
  });

  test("freezes direct work at the requested path with no Docket side effects", () => {
    const direct = PROMPT_ROUTING_FIXTURES.filter((fixture) =>
      fixture.traits?.includes("direct-work-regression"),
    );
    expect(direct.map((fixture) => fixture.id)).toEqual([
      "direct-concrete-ux-request",
      "direct-generic-fix",
    ]);
    for (const fixture of direct) {
      expect(fixture.expectedIntent).toBe("direct-work");
      expect(fixture.expectedEntrypoint.kind).toBe("direct");
      expect(fixture.allowedCommands).toEqual([]);
      expect(fixture.writesPermitted).toBe(true);
      expect(fixture.permittedWritePaths).toHaveLength(1);
      expect(fixture.forbiddenActions).toEqual(
        expect.arrayContaining([
          "docket task create",
          "docket task start",
          "task or index mutation",
          "adopt existing .docket/active-task",
          "clear existing .docket/active-task",
        ]),
      );
    }
  });

  test("keeps ambiguous, named, next, and create-then-start pickup distinct", () => {
    const fixtures = Object.fromEntries(
      PROMPT_ROUTING_FIXTURES.map((fixture) => [fixture.id, fixture]),
    );

    expect(fixtures["pickup-ambiguous-tracked-reference"]).toMatchObject({
      expectedIntent: "pickup",
      allowedCommands: ['docket search "login" --json'],
      writesPermitted: false,
    });
    expect(
      fixtures["pickup-ambiguous-tracked-reference"]?.forbiddenActions,
    ).toContain("docket task start");
    expect(fixtures["pickup-named-start"]?.allowedCommands).toEqual([
      "docket task start DKT-12 --json",
    ]);
    expect(
      fixtures["pickup-explicit-next-docket-task"]?.allowedCommands,
    ).toEqual(["docket task start --json"]);
    expect(fixtures["task-create-and-start"]?.composedIntents).toEqual([
      "pickup",
    ]);
    expect(fixtures["task-create-and-start"]?.allowedCommands).toContain(
      "docket task start <created-ID> --json",
    );
    expect(fixtures["task-create-and-start"]?.allowedCommands).not.toContain(
      "docket task start --json",
    );
  });

  test("encodes orientation, grooming, pickup, epic supervision, and named mutations", () => {
    const paths = new Set(
      PROMPT_ROUTING_FIXTURES.map(
        (fixture) =>
          `${fixture.expectedEntrypoint.kind}:${fixture.expectedEntrypoint.value}`,
      ),
    );
    expect(paths).toContain("command:docket overview --json");
    expect(paths).toContain("direct:the user's concrete requested work");
    expect(paths).toContain('command:docket search "login" --json');
    expect(paths).toContain("workflow:docket-groom");
    expect(paths).toContain("workflow:docket-pickup");
    expect(paths).toContain("workflow:docket-epic");
    expect(paths).toContain("workflow:docket-task");
    expect(paths).toContain("workflow:docket-close");
    expect(
      [...paths].some((path) => path.startsWith("command:docket task move")),
    ).toBe(true);
  });

  test("freezes review-only orientation at overview-only and no writes", () => {
    const orientationNoWrite = PROMPT_ROUTING_FIXTURES.find((fixture) =>
      fixture.traits?.includes("orientation-no-write-regression"),
    );
    expect(orientationNoWrite?.prompt).toBe(
      "What's next in Docket? Don't start it, let's just review.",
    );
    expect(orientationNoWrite?.expectedIntent).toBe("orientation");
    expect(orientationNoWrite?.expectedEntrypoint).toEqual({
      kind: "command",
      value: "docket overview --json",
    });
    expect(orientationNoWrite?.allowedCommands).toEqual([
      "docket overview --json",
    ]);
    expect(orientationNoWrite?.writesPermitted).toBe(false);
    expect(orientationNoWrite?.forbiddenActions).toEqual(
      expect.arrayContaining([
        "docket task start",
        "docket index",
        "repository-wide search",
      ]),
    );
  });

  test("fails closed when intent coverage, scope, or mutation data drifts", () => {
    const withoutPickup = PROMPT_ROUTING_FIXTURES.filter(
      (fixture) => fixture.expectedIntent !== "pickup",
    );
    expect(
      validatePromptRoutingFixtures(withoutPickup).some(
        (diagnostic) =>
          diagnostic.code === "missing-intent-coverage" &&
          diagnostic.message.includes("pickup"),
      ),
    ).toBe(true);

    const first = PROMPT_ROUTING_FIXTURES.find(
      (fixture) => fixture.expectedIntent === "orientation",
    );
    if (!first) throw new Error("orientation fixture is missing");
    const drifted = [
      {
        ...first,
        maximumInspectionScope: "Search every repository file.",
        writesPermitted: true,
      },
      ...PROMPT_ROUTING_FIXTURES.filter((fixture) => fixture !== first),
    ] satisfies readonly PromptRoutingFixture[];
    const diagnostics = validatePromptRoutingFixtures(drifted);
    expect(diagnostics.some((d) => d.code === "inspection-scope-drift")).toBe(
      true,
    );
    expect(diagnostics.some((d) => d.code === "write-boundary-drift")).toBe(
      true,
    );
  });
});

describe("intent discovery exclusivity", () => {
  test("keeps canonical discovery descriptions mutually exclusive", () => {
    expect(validateIntentDiscoveryDescriptions()).toEqual([]);
  });

  test("catches description and positive-example overlap", () => {
    const intents = Object.fromEntries(
      DOCKET_INTENT_IDS.map((id) => [id, { ...DOCKET_INTENTS[id] }]),
    ) as unknown as Record<DocketIntentId, DocketIntentContract>;
    intents["backlog-hygiene"] = {
      ...intents["backlog-hygiene"],
      discovery: DOCKET_INTENTS.orientation.discovery,
      positiveExamples: [
        ...intents["backlog-hygiene"].positiveExamples,
        DOCKET_INTENTS.orientation.positiveExamples[0],
      ],
    };

    const diagnostics = validateIntentDiscoveryDescriptions(intents);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "description-overlap" &&
          diagnostic.intent === "backlog-hygiene" &&
          diagnostic.otherIntent === "orientation",
      ),
    ).toBe(true);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "example-overlap" &&
          diagnostic.intent === "backlog-hygiene",
      ),
    ).toBe(true);
  });
});
