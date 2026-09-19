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
} from "@gitdocket/core";
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
    if (entrypoint.kind === "named-operation") {
      expect(surface).toContain(
        "task list|create|start|stop|move|edit|close|log",
      );
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
    cursor: renderedSurface(AGENT_ADAPTERS.cursor),
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

  test("native stubs differ only at declared lifecycle bindings", () => {
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
      const cursor = renderTargetSkillStub(
        AGENT_ADAPTERS.cursor,
        workflow,
        "docket/",
      );
      if (
        workflow.slug === "docket-pickup" ||
        workflow.slug === "docket-epic"
      ) {
        expect(withoutNativeBinding(claude)).toBe(withoutNativeBinding(codex));
        expect(withoutNativeBinding(claude)).toBe(withoutNativeBinding(cursor));
      }
      if (workflow.slug === "docket-pickup") {
        expect(claude).toContain(DOCKET_INTENTS.pickup.discovery);
        expect(codex).toContain(DOCKET_INTENTS.pickup.discovery);
        expect(cursor).toContain(DOCKET_INTENTS.pickup.discovery);
        expect(claude).toContain("rename unsupported");
        expect(codex).toContain("retained epic-manager identity");
        expect(codex).toContain("same-epic or unrelated task pickup");
        expect(codex).toContain("do not call `codex_app__set_thread_title`");
        expect(codex).toContain("explicitly asks to repurpose this chat");
        expect(codex).toContain("codex_app__set_thread_title");
        expect(cursor).toContain("retained epic-manager identity");
        expect(cursor).toContain("same-epic or unrelated task pickup");
        expect(cursor).toContain("do not call `rename_chat`");
        expect(cursor).toContain("explicitly asks to repurpose this chat");
        expect(cursor).toContain("rename_chat");
        expect(cursor).toContain("{ title: suggestedSessionTitle }");
        expect(cursor).toContain("successful pickup title intent");
        expect(cursor).not.toContain("codex_app__");
        expect(claude).not.toContain("rename_chat");
        expect(codex).not.toContain("rename_chat");
      } else if (workflow.slug === "docket-epic") {
        expect(claude).toContain("no verified native worker lifecycle binding");
        expect(claude).toContain("current-session rename unsupported");
        expect(codex).toContain("`Epic <ID> — <title>`");
        expect(codex).toContain("codex_app__set_thread_title");
        expect(codex).toContain("omit `threadId`");
        expect(codex).toContain("after every successful child pickup");
        expect(codex).toContain("before the completion or blocker receipt");
        expect(codex).toContain("retained identity");
        expect(codex).toContain("Keep the identity after completion");
        expect(codex).toContain("later task pickup alone may not");
        expect(codex).toContain(
          "never apply the manager title to an isolated child",
        );
        expect(codex).toContain("one app task in an isolated Git worktree");
        expect(codex).toContain("wait cursor");
        expect(codex).toContain("canonical serial fallback");
        expect(cursor).toContain("`Epic <ID> — <title>`");
        expect(cursor).toContain("rename_chat");
        expect(cursor).toContain("{ title: managerTitle }");
        expect(cursor).toContain("after every successful child pickup");
        expect(cursor).toContain("before the completion or blocker receipt");
        expect(cursor).toContain(
          "never apply the manager title to an isolated child",
        );
        expect(cursor).toContain("no verified native worker lifecycle binding");
        expect(cursor).toContain("serially in the calling session");
        expect(cursor).toContain("successful epic-manager title intent");
        expect(cursor).not.toContain("codex_app__");
        expect(cursor).not.toContain(
          "one app task in an isolated Git worktree",
        );
        expect(claude).not.toContain("rename_chat");
        expect(codex).not.toContain("rename_chat");
      } else {
        expect(claude).toBe(codex);
        expect(claude).toBe(cursor);
      }
    }
  });

  test("canonical workflows and Claude/Codex adapters stay free of Cursor tool names", () => {
    for (const workflow of DOCKET_WORKFLOWS) {
      expect(workflow.body).not.toContain("rename_chat");
      expect(workflow.body).not.toContain(".cursor/skills");
    }
    expect(AGENT_ADAPTERS.claude.pickupBinding ?? "").not.toContain(
      "rename_chat",
    );
    expect(AGENT_ADAPTERS.claude.epicBinding ?? "").not.toContain(
      "rename_chat",
    );
    expect(AGENT_ADAPTERS.codex.pickupBinding).not.toContain("rename_chat");
    expect(AGENT_ADAPTERS.codex.epicBinding).not.toContain("rename_chat");
  });

  test("a synthetic install writes portable, Claude, Codex, and Cursor generator output", async () => {
    const root = await mkdtemp(join(tmpdir(), "docket-public-adapters-"));
    try {
      await runInit(root, {
        project: "DKT",
        bundle: "docket/",
        agents: ["claude", "codex", "cursor"],
      });
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
        SECTION.trim(),
      );
      expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain(
        SECTION.trim(),
      );

      for (const workflow of DOCKET_WORKFLOWS) {
        for (const target of ["claude", "codex", "cursor"] as const) {
          const adapter = AGENT_ADAPTERS[target];
          expect(
            await readFile(
              join(root, adapter.skillsRoot, workflow.slug, "SKILL.md"),
              "utf8",
            ),
          ).toBe(renderTargetSkillStub(adapter, workflow, "docket/"));
        }
      }
      expect(
        await readFile(
          join(root, ".cursor", "skills", "docket-pickup", "SKILL.md"),
          "utf8",
        ),
      ).toContain("rename_chat");
      expect(
        await readFile(
          join(root, ".cursor", "skills", "docket-epic", "SKILL.md"),
          "utf8",
        ),
      ).toContain("{ title: managerTitle }");
      expect(
        await readFile(
          join(root, ".claude", "skills", "docket-pickup", "SKILL.md"),
          "utf8",
        ),
      ).not.toContain("rename_chat");
      expect(
        await readFile(
          join(root, ".agents", "skills", "docket-epic", "SKILL.md"),
          "utf8",
        ),
      ).not.toContain("rename_chat");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
