// Cross-harness acceptance: generated Codex, Claude, and portable adapters
// expose the same prompt-routing contract. Native pickup bindings may differ.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_INTENTS,
  DOCKET_INTENTS,
  DOCKET_WORKFLOWS,
  PROMPT_ROUTING_FIXTURES,
  renderDocketSection,
} from "@docket/core";
import {
  AGENT_ADAPTERS,
  type AgentAdapter,
  renderTargetSkillStub,
} from "./agent-adapters";
import { runInit } from "./init";

const SECTION = renderDocketSection("DKT", "docket/");

function renderedSurface(adapter?: AgentAdapter): string {
  const skills = adapter
    ? DOCKET_WORKFLOWS.map((workflow) =>
        renderTargetSkillStub(adapter, workflow, "docket/"),
      ).join("\n")
    : "";
  return `${SECTION}\n${skills}`;
}

function expectFixturePath(surface: string, fixtureId: string): void {
  const fixture = PROMPT_ROUTING_FIXTURES.find(
    (candidate) => candidate.id === fixtureId,
  );
  if (!fixture) throw new Error(`missing fixture ${fixtureId}`);

  const expectEntrypoint = (
    entrypoint: (typeof fixture)["expectedEntrypoint"],
  ): void => {
    if (entrypoint.kind === "direct") {
      expect(surface).toContain("**Direct and tracked work**");
      return;
    }
    if (entrypoint.kind === "workflow") {
      expect(surface).toContain(`docket/workflows/${entrypoint.value}.md`);
      return;
    }
    if (entrypoint.value === "docket overview --json") {
      expect(surface).toContain("`docket overview --json`");
      return;
    }
    if (entrypoint.value.startsWith("docket search ")) {
      expect(surface).toContain("`ready`, `overview`, `search`");
      return;
    }

    const operation = entrypoint.value.match(/^docket task (\w+)/)?.[1];
    expect(operation).toBeDefined();
    expect(surface).toContain(`|${operation}`);
  };

  expectEntrypoint(fixture.expectedEntrypoint);
  for (const intent of fixture.composedIntents ?? []) {
    expectEntrypoint(AGENT_INTENTS[intent].defaultEntrypoint);
  }
  for (const evidence of fixture.surfaceEvidence ?? []) {
    expect(surface).toContain(evidence);
  }
}

function withoutNativeBinding(text: string): string {
  return text.replace(
    /\n## Native (current-session rename|epic-supervision lifecycle) binding\n\n[\s\S]*$/,
    "\n## Native $1 binding\n\n<host binding>\n",
  );
}

describe("cross-harness prompt routing", () => {
  const surfaces = {
    portable: renderedSurface(),
    claude: renderedSurface(AGENT_ADAPTERS.claude),
    codex: renderedSurface(AGENT_ADAPTERS.codex),
  };

  test.each(Object.entries(surfaces))(
    "%s exposes every fixture's selected path, evidence, and bounded orientation",
    (_name, surface) => {
      for (const fixture of PROMPT_ROUTING_FIXTURES) {
        expectFixturePath(surface, fixture.id);
      }
      expect(surface).toContain(DOCKET_INTENTS["backlog-hygiene"].discovery);
      expect(surface).toContain("start with its structured result");
      expect(surface).toContain("do not start a task");
      expect(surface).toContain("do not start a task, regenerate the index");
      expect(surface).toContain("search unrelated implementation");
      expect(surface).toContain("propose fixes before applying any mutation");
    },
  );

  test.each(Object.entries(surfaces))(
    "%s exposes the direct-work and explicit-pickup authority boundary",
    (_name, surface) => {
      expect(surface).toContain(DOCKET_INTENTS.pickup.discovery);
      expect(surface).toContain("**Direct and tracked work**");
      expect(surface).toContain("concrete direct request proceeds");
      expect(surface).toContain("generic implementation language");
      expect(surface).toContain("supplies a Docket ID");
      expect(surface).toContain("unambiguous reference");
      expect(surface).toContain("reference remains ambiguous");
      expect(surface).toContain("never fall back");
      expect(surface).toContain(
        "permitted only for explicit next-Docket-task or backlog selection",
      );
    },
  );

  test("Claude and Codex stubs differ only at declared lifecycle bindings", () => {
    for (const workflow of DOCKET_WORKFLOWS) {
      const claude = renderTargetSkillStub(
        AGENT_ADAPTERS.claude,
        workflow,
        "docket/",
      );
      const codex = renderTargetSkillStub(
        AGENT_ADAPTERS.codex,
        workflow,
        "docket/",
      );
      if (
        workflow.slug === "docket-pickup" ||
        workflow.slug === "docket-epic"
      ) {
        expect(withoutNativeBinding(claude)).toBe(withoutNativeBinding(codex));
      }
      if (workflow.slug === "docket-pickup") {
        expect(claude).toContain(DOCKET_INTENTS.pickup.discovery);
        expect(codex).toContain(DOCKET_INTENTS.pickup.discovery);
        expect(claude).toContain("rename unsupported");
        expect(codex).toContain("codex_app__set_thread_title");
      } else if (workflow.slug === "docket-epic") {
        expect(claude).toContain("no verified native worker lifecycle binding");
        expect(claude).toContain("current-session rename unsupported");
        expect(codex).toContain("`Epic <ID> — <title>`");
        expect(codex).toContain("codex_app__set_thread_title");
        expect(codex).toContain("omit `threadId`");
        expect(codex).toContain("after every successful child pickup");
        expect(codex).toContain("before the completion or blocker receipt");
        expect(codex).toContain(
          "never apply the manager title to an isolated child",
        );
        expect(codex).toContain("one app task in an isolated Git worktree");
        expect(codex).toContain("wait cursor");
        expect(codex).toContain("canonical serial fallback");
      } else {
        expect(claude).toBe(codex);
      }
    }
  });

  test("a synthetic install writes portable, Claude, and Codex generator output", async () => {
    const root = await mkdtemp(join(tmpdir(), "docket-public-adapters-"));
    try {
      await runInit(root, {
        project: "DKT",
        bundle: "docket/",
        agents: ["claude", "codex"],
      });
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
        SECTION.trim(),
      );
      expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain(
        SECTION.trim(),
      );

      for (const workflow of DOCKET_WORKFLOWS) {
        for (const target of ["claude", "codex"] as const) {
          const adapter = AGENT_ADAPTERS[target];
          expect(
            await readFile(
              join(root, adapter.skillsRoot, workflow.slug, "SKILL.md"),
              "utf8",
            ),
          ).toBe(renderTargetSkillStub(adapter, workflow, "docket/"));
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
