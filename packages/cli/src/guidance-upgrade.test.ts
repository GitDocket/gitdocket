import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKET_VERSION } from "@gitdocket/core";
import { runInit } from "./init";
import { runUpgrade } from "./upgrade";

test("repeated init and upgrades preserve authored guidance, shared sources and handwritten instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-guidance-preserve-"));
  try {
    const authored = {
      "docket.yaml": "project: DEMO\nbundle: docs/\n",
      "docs/reference/project-guidance.md":
        "---\ntype: Reference\n---\nRequirement: use GraphQL for backend APIs.\nWhen deployment is requested: [deploy](/playbooks/deploy.md).\n",
      "docs/playbooks/deploy.md":
        "---\ntype: Playbook\n---\nLocal deployment prerequisites, steps, checks and recovery.\n",
      "AGENTS.md": "# Project instructions\n\nPreserve my test standards.\n",
      "CLAUDE.md":
        "# Local Claude instructions\n\nPreserve my review procedure.\n",
    };
    for (const [path, source] of Object.entries(authored)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), source);
    }
    for (let pass = 0; pass < 2; pass++) {
      await runInit(root, { agents: ["codex", "claude"] });
      await runUpgrade(root, {});
      for (const [path, source] of Object.entries(authored)) {
        const actual = await readFile(join(root, path), "utf8");
        if (path === "AGENTS.md" || path === "CLAUDE.md") {
          expect(actual.startsWith(source)).toBe(true);
          expect(actual).toContain("docs/reference/project-guidance.md");
          expect(actual).not.toContain(
            "Requirement: use GraphQL for backend APIs.",
          );
        } else expect(actual).toBe(source);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow upgrade preserves customization and reports competing edits without touching project standards", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-guidance-conflict-"));
  try {
    await mkdir(join(root, "docs/reference"), { recursive: true });
    await mkdir(join(root, "docs/workflows"), { recursive: true });
    await writeFile(
      join(root, "docket.yaml"),
      "project: DEMO\nbundle: docs/\n",
    );
    const guidance =
      "---\ntype: Reference\n---\nRequirement: use GraphQL, even if current code uses REST.\n";
    await writeFile(join(root, "docs/reference/project-guidance.md"), guidance);
    const path = "docs/workflows/docket-guidance.md";
    const original =
      "---\ntype: Workflow\norigin: docket-guidance@0.0.1\n---\n\nLocal guidance procedure.\n";
    await writeFile(join(root, path), original);
    const history = [
      {
        version: DOCKET_VERSION,
        bodies: { "docket-guidance": "Upstream guidance procedure." },
      },
      {
        version: "0.0.1",
        bodies: { "docket-guidance": "Original guidance procedure." },
      },
    ];
    const dryRun = await runUpgrade(root, { dryRun: true }, { history });
    expect(dryRun.conflicts).toContain(path);
    expect(await readFile(join(root, path), "utf8")).toBe(original);
    const report = await runUpgrade(root, {}, { history });
    expect(report.conflicts).toContain(path);
    const conflict = await readFile(join(root, path), "utf8");
    expect(conflict).toContain("Local guidance procedure.");
    expect(conflict).toContain("Upstream guidance procedure.");
    expect(conflict).toContain("<<<<<<<");
    expect(
      await readFile(join(root, "docs/reference/project-guidance.md"), "utf8"),
    ).toBe(guidance);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrade installs the new guidance workflow and discovered adapter binding with provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-guidance-upgrade-"));
  try {
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, ".agents/skills"), { recursive: true });
    await writeFile(
      join(root, "docket.yaml"),
      "project: DEMO\nbundle: docs/\n",
    );
    const path = "docs/workflows/docket-guidance.md";
    const preview = await runUpgrade(root, { dryRun: true });
    expect(preview.items.find((item) => item.path === path)?.action).toBe(
      "regenerated",
    );
    expect(await Bun.file(join(root, path)).exists()).toBe(false);
    await runUpgrade(root, {});
    const installed = await readFile(join(root, path), "utf8");
    expect(installed).toContain(`origin: docket-guidance@${DOCKET_VERSION}`);
    expect(
      await readFile(
        join(root, ".agents/skills/docket-guidance/SKILL.md"),
        "utf8",
      ),
    ).toContain("docs/workflows/docket-guidance.md");
    await runUpgrade(root, {});
    expect(await readFile(join(root, path), "utf8")).toBe(installed);
    expect(
      await Bun.file(join(root, "docs/reference/project-guidance.md")).exists(),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
