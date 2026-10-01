import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKET_WORKFLOWS, renderAgentSkillStub } from "@gitdocket/core";
import { analyzeDocketTrace } from "@gitdocket/core/telemetry-report";
import { canRetireCloseSkill } from "./agent-adapters";
import { runInit } from "./init";
import { runUpgrade } from "./upgrade";

const close = DOCKET_WORKFLOWS.find((w) => w.slug === "docket-close");
if (!close) throw new Error("close workflow missing");
const roots = [".claude", ".agents", ".cursor"];
const stub = renderAgentSkillStub(close, "docs/");

test("retirement recognizes historical pointers but preserves any extra/custom instructions", () => {
  expect(canRetireCloseSkill(stub, "docs/")).toBe(true);
  const old = stub
    .replace(/init@\d+\.\d+\.\d+/, "init@0.3.1")
    .replace(
      close.description,
      "Conclude a task as completed or explicitly closed without completion — narrative, doc reconciliation, index/log updates.",
    );
  expect(canRetireCloseSkill(old, "docs/")).toBe(true);
  expect(
    canRetireCloseSkill(`${old}\nUse a custom approval process.\n`, "docs/"),
  ).toBe(false);
  expect(
    canRetireCloseSkill(
      stub.replace(close.description, "Custom closure policy"),
      "docs/",
    ),
  ).toBe(false);
  expect(canRetireCloseSkill("My authored close skill", "docs/")).toBe(false);
  expect(canRetireCloseSkill(stub, "other/")).toBe(false);
});

test("init and upgrade retire known stubs on every host, keep custom content and never regenerate closure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-close-retirement-"));
  const at = (...parts: string[]) => join(dir, ...parts);
  const seed = async (text: string) => {
    for (const root of roots) {
      await mkdir(at(root, "skills/docket-close"), { recursive: true });
      await writeFile(at(root, "skills/docket-close/SKILL.md"), text);
    }
  };
  try {
    await runInit(dir, {
      project: "RET",
      bundle: "docs/",
      agents: ["claude", "codex", "cursor"],
    });
    for (const root of roots)
      expect(
        await Bun.file(at(root, "skills/docket-close/SKILL.md")).exists(),
      ).toBe(false);
    await seed(stub.replace(/init@\d+\.\d+\.\d+/, "init@0.3.1"));
    const dry = await runUpgrade(dir, { dryRun: true });
    expect(dry.items.filter((i) => i.action === "removed")).toHaveLength(3);
    for (const root of roots)
      expect(
        await readFile(at(root, "skills/docket-close/SKILL.md"), "utf8"),
      ).toContain("init@0.3.1");
    const report = await runUpgrade(dir, {});
    expect(report.items.filter((i) => i.action === "removed")).toHaveLength(3);
    await runUpgrade(dir, {});
    await runInit(dir, { agents: ["claude", "codex", "cursor"] });
    for (const root of roots)
      expect(
        await Bun.file(at(root, "skills/docket-close/SKILL.md")).exists(),
      ).toBe(false);
    await seed(`${stub}\nCustom closure instruction.\n`);
    const custom = await runUpgrade(dir, {});
    expect(
      custom.reviewRequired.filter((p) => p.endsWith("docket-close/SKILL.md")),
    ).toHaveLength(3);
    const reinit = await runInit(dir, {
      agents: ["claude", "codex", "cursor"],
    });
    expect(
      reinit.steps.filter((s) => s.reason?.includes("custom or unrecognized")),
    ).toHaveLength(3);
    for (const root of roots)
      expect(
        await readFile(at(root, "skills/docket-close/SKILL.md"), "utf8"),
      ).toContain("Custom closure instruction.");
    expect(await readFile(at("AGENTS.md"), "utf8")).toContain(
      "Read the close workflow when closure begins",
    );
    expect(
      await readFile(at("docs/workflows/docket-close.md"), "utf8"),
    ).toContain("child items in the same closure pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded call replay records the removed routing read without treating instructions as behavioral proof", () => {
  const replay = (commands: string[]) =>
    analyzeDocketTrace(
      JSON.stringify({
        schemaVersion: 1,
        turns: [
          {
            items: commands.map((command) => ({
              type: "commandExecution",
              command,
              cwd: "/fixture",
              exitCode: 0,
            })),
          },
        ],
      }),
    );
  const before = replay([
    "cat docs/../docket/workflows/docket-close.md",
    "cat .agents/skills/docket-close/SKILL.md",
    "cat docket/workflows/docket-close.md",
  ]);
  const after = replay(["cat docket/workflows/docket-close.md"]);
  expect(before.coverage.docketMatches).toBe(3);
  expect(before.candidates).toHaveLength(1);
  expect(after.coverage.docketMatches).toBe(1);
  expect(after.candidates).toHaveLength(0);
  expect(after.coverage.sourceVersions).toBe("unavailable");
});
