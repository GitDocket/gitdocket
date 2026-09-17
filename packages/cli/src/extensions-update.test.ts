import { afterEach, expect, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ExtensionManifest,
  mutateExtension,
  readExtensions,
} from "@gitdocket/core";
import { runUpgrade } from "./upgrade";

const CLI = join(import.meta.dir, "index.ts");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function write(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), {
      withFileTypes: true,
    })) {
      const relative = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relative);
      else result[relative] = await readFile(join(root, relative), "utf8");
    }
  }
  await walk("");
  return result;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "docket-extension-update-cli-"));
  roots.push(root);
  const project = join(root, "project");
  const source = join(root, "source");
  await write(project, "docket.yaml", "project: EXT\nbundle: knowledge/\n");
  await write(project, "AGENTS.md", "Handwritten project requirement.\n");
  await write(project, ".docket/active-task", "EXT-99\n");
  await write(
    project,
    "knowledge/reference/project-guidance.md",
    "---\ntype: Reference\ntitle: Project guidance\ndescription: Authored guidance\n---\nPreserve project ownership.\n",
  );
  await mkdir(join(project, ".agents/skills"), { recursive: true });
  await cp(
    join(import.meta.dir, "../../../examples/extensions/minimal"),
    source,
    { recursive: true },
  );
  const manifest = JSON.parse(
    await readFile(join(source, "extension.json"), "utf8"),
  ) as ExtensionManifest;
  const workflow = await readFile(join(source, "workflows/review.md"), "utf8");
  const bundle = join(project, "knowledge");
  const installedWorkflow = "knowledge/extensions/tiny/workflows/review.md";
  const registry = "knowledge/extensions/registry.json";
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, CLI, "extension", ...args],
      { cwd: project },
    );
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      json: () => JSON.parse(result.stdout.toString()),
    };
  };
  async function candidate(
    version = "1.1.0",
    body = workflow,
    patch: Partial<ExtensionManifest> = {},
  ) {
    const path = join(root, `candidate-${Math.random().toString(36).slice(2)}`);
    await write(
      path,
      "extension.json",
      JSON.stringify({ ...manifest, version, ...patch }),
    );
    await write(path, "workflows/review.md", body);
    return path;
  }
  expect(cli("install", source, "--enable", "--json").code).toBe(0);
  return {
    project,
    bundle,
    source,
    manifest,
    workflow,
    installedWorkflow,
    registry,
    cli,
    candidate,
  };
}

test("real CLI update/validate/reconcile preserves ownership and refreshes discovery using reviewed exact content", async () => {
  const f = await fixture();
  expect(
    f.cli(
      "configure",
      "tiny",
      "--set",
      '{"reviewer":"project owner"}',
      "--json",
    ).code,
  ).toBe(0);
  await write(
    f.project,
    f.installedWorkflow,
    `${f.workflow}\nProject review requirement.\n`,
  );
  const before = await snapshot(f.project);
  const missingFlag = f.cli("reconcile", "tiny", "--json");
  expect(missingFlag.code).toBe(1);
  expect(missingFlag.stderr).toContain("--acknowledge-local");
  const unreviewed = f.cli("validate", "tiny", "--json");
  expect(unreviewed.code).toBe(0);
  expect([
    unreviewed.json().mechanical,
    unreviewed.json().protocol,
    unreviewed.json().behavioral,
  ]).toEqual(["pass", "not-run", "not-run"]);
  expect(unreviewed.json().packages[0].reviewRequiredPaths).toEqual([
    "workflows/review.md",
  ]);
  const v2 = await f.candidate();
  expect(f.cli("validate", "tiny", "--candidate", v2, "--json").code).toBe(0);
  const dry = f.cli("update", "tiny", v2, "--dry-run", "--json");
  expect(dry.code).toBe(0);
  expect(dry.json().inventory.packages[0].availability).toBe("review-required");
  expect(await snapshot(f.project)).toEqual(before);
  expect(f.cli("update", "tiny", v2, "--json").code).toBe(0);
  expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe(
    "Handwritten project requirement.\n",
  );
  expect(
    await Bun.file(
      join(f.project, ".agents/skills/docket-ext-tiny-review/SKILL.md"),
    ).exists(),
  ).toBe(false);
  const beforeReview = await snapshot(f.project);
  expect(
    f
      .cli("reconcile", "tiny", "--acknowledge-local", "--dry-run", "--json")
      .json().inventory.packages[0].availability,
  ).toBe("available");
  expect(await snapshot(f.project)).toEqual(beforeReview);
  expect(f.cli("reconcile", "tiny", "--acknowledge-local", "--json").code).toBe(
    0,
  );
  expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toContain(
    "`tiny:review`",
  );
  expect(
    await Bun.file(
      join(f.project, ".agents/skills/docket-ext-tiny-review/SKILL.md"),
    ).exists(),
  ).toBe(true);
  const reviewed = await snapshot(f.project);
  expect(f.cli("update", "tiny", v2, "--json").json().changed).toBe(false);
  expect(
    f.cli("reconcile", "tiny", "--acknowledge-local", "--json").json().changed,
  ).toBe(false);
  expect(await snapshot(f.project)).toEqual(reviewed);
  expect(
    f.cli("show", "tiny", "--json").json().effectiveConfig.reviewer,
  ).toEqual({ value: "project owner", owner: "project" });
  expect(await readFile(join(f.project, ".docket/active-task"), "utf8")).toBe(
    "EXT-99\n",
  );
}, 20_000);

test("real CLI mechanical failures retain complete receipts, installed bytes and handwritten native conflicts", async () => {
  const f = await fixture();
  await write(
    f.project,
    f.installedWorkflow,
    `${f.workflow}\nLocal divergence.\n`,
  );
  const v2 = await f.candidate(
    "1.1.0",
    `${f.workflow}\nUpstream divergence.\n`,
  );
  const before = await snapshot(f.project);
  for (const args of [
    ["validate", "tiny", "--candidate", v2],
    ["update", "tiny", v2, "--dry-run"],
    ["update", "tiny", v2],
  ]) {
    const failed = f.cli(...args, "--json");
    expect(failed.code).toBe(1);
    expect(failed.json().ok).toBe(false);
    expect(
      failed
        .json()
        .diagnostics.some(
          (entry: { code: string }) => entry.code === "update-conflict",
        ),
    ).toBe(true);
    if (args[0] === "validate")
      expect([
        failed.json().mechanical,
        failed.json().protocol,
        failed.json().behavioral,
      ]).toEqual(["fail", "not-run", "not-run"]);
    expect(await snapshot(f.project)).toEqual(before);
  }
  const native = ".agents/skills/docket-ext-tiny-review/SKILL.md";
  await write(f.project, native, "Handwritten native procedure.\n");
  const acknowledged = f.cli(
    "reconcile",
    "tiny",
    "--acknowledge-local",
    "--json",
  );
  expect(acknowledged.code).toBe(1);
  expect(acknowledged.json().lifecycleOk).toBe(true);
  expect(acknowledged.json().inventory.packages[0].availability).toBe(
    "available",
  );
  expect(await readFile(join(f.project, native), "utf8")).toBe(
    "Handwritten native procedure.\n",
  );
}, 20_000);

test("actual engine upgrade orchestration in either package order preserves authoritative bytes and withholds incompatible pointers", async () => {
  for (const engineFirst of [true, false]) {
    const f = await fixture();
    expect(
      f.cli(
        "configure",
        "tiny",
        "--set",
        '{"reviewer":"project owner"}',
        "--json",
      ).code,
    ).toBe(0);
    const bridge = await f.candidate("1.1.0", f.workflow, {
      engine: { min: "0.4.0", maxExclusive: "2.0.0" },
    });
    const original = await snapshot(f.bundle);
    if (engineFirst) {
      const dry = await runUpgrade(
        f.project,
        { dryRun: true },
        { available: "1.0.0" },
      );
      expect(dry.extensionDiscovery?.ok).toBe(false);
      expect(await snapshot(f.bundle)).toEqual(original);
      const upgraded = await runUpgrade(f.project, {}, { available: "1.0.0" });
      expect(
        upgraded.extensionDiscovery?.diagnostics.some(
          (entry) => entry.code === "incompatible-engine",
        ),
      ).toBe(true);
      expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe(
        "Handwritten project requirement.\n",
      );
      expect(await snapshot(f.bundle)).toEqual(original);
    }
    expect(
      (
        await mutateExtension(
          f.bundle,
          { kind: "update", id: "tiny", source: bridge },
          { engineVersion: engineFirst ? "1.0.0" : "0.4.0" },
        )
      ).ok,
    ).toBe(true);
    const updated = await snapshot(f.bundle);
    const engine = await runUpgrade(f.project, {}, { available: "1.0.0" });
    expect(engine.extensionDiscovery?.ok).toBe(true);
    expect(await snapshot(f.bundle)).toEqual(updated);
    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toContain(
      "`tiny:review`",
    );
    expect(
      (await readExtensions(f.bundle, { engineVersion: "1.0.0" })).packages[0]
        ?.effectiveConfig.reviewer,
    ).toEqual({ value: "project owner", owner: "project" });
    const repeat = await runUpgrade(f.project, {}, { available: "1.0.0" });
    expect(repeat.extensionDiscovery?.changed).toBe(false);
    expect(await snapshot(f.bundle)).toEqual(updated);
  }
}, 20_000);
