import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editDocument,
  LocalFileStore,
  parseConfig,
  readEditableDocument,
} from "@gitdocket/core";
import vector from "../../../examples/extensions/package-digest-vector.json";

const CLI = join(import.meta.dir, "index.ts");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "docket-extension-cli-"));
  roots.push(directory);
  const root = join(directory, "project");
  const source = join(directory, "package");
  await mkdir(join(root, "knowledge/reference"), { recursive: true });
  await mkdir(join(root, ".docket"));
  await writeFile(
    join(root, "docket.yaml"),
    "project: EXT\nbundle: knowledge/\n",
  );
  await writeFile(join(root, ".gitignore"), ".docket/\n");
  await writeFile(
    join(root, "AGENTS.md"),
    "Handwritten project instruction.\n",
  );
  await writeFile(join(root, ".docket/active-task"), "EXT-999\n");
  await writeFile(
    join(root, "knowledge/reference/project-guidance.md"),
    "---\ntype: Reference\ntitle: Project guidance\ndescription: A preserved project requirement\n---\n\nKeep the selected API contract.\n",
  );
  await cp(
    join(import.meta.dir, "../../../examples/extensions/minimal"),
    source,
    { recursive: true },
  );
  const cli = (...args: string[]) => invoke(root, ...args);
  return { root, source, directory, cli };
}

function invoke(root: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, "extension", ...args], {
    cwd: root,
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    json: () => JSON.parse(result.stdout.toString()),
  };
}

test("CLI adopts, configures and retires a pinned package without tracker or handwritten changes", async () => {
  const { root, source, cli } = await fixture();
  expect(cli("list", "--json").json().packages).toEqual([]);
  const inspected = cli("inspect", source, "--json");
  expect(inspected.code).toBe(0);
  expect(inspected.json().digest).toBe(vector.sha256);
  expect(cli("install", source, "--dry-run", "--json").json().changed).toBe(
    true,
  );
  expect(
    await Bun.file(join(root, "knowledge/extensions/registry.json")).exists(),
  ).toBe(false);
  expect(cli("install", source, "--json").code).toBe(0);
  expect(cli("show", "tiny", "--json").json().availability).toBe("disabled");
  expect(cli("enable", "tiny", "--json").code).toBe(0);
  const configured = cli(
    "configure",
    "tiny",
    "--set",
    '{"reviewer":"release owner"}',
    "--json",
  );
  expect(configured.code).toBe(0);
  const view = cli("show", "tiny", "--json").json();
  expect(view.effectiveConfig.reviewer).toEqual({
    value: "release owner",
    owner: "project",
  });
  expect(view.availability).toBe("available");
  const sourceRead = Bun.spawnSync(
    [
      process.execPath,
      CLI,
      "source",
      view.sources["workflows/review.md"].path,
      "--json",
    ],
    { cwd: root },
  );
  expect(sourceRead.exitCode).toBe(0);
  expect(JSON.parse(sourceRead.stdout.toString()).text).toBe(
    vector.files["workflows/review.md"],
  );
  expect(JSON.parse(sourceRead.stdout.toString()).sourceHash).toBe(
    view.sources["workflows/review.md"].hash,
  );
  expect(cli("list", "--json").json().workflows[0].identity).toBe(
    "tiny:review",
  );
  expect(cli("show", "tiny").stdout).toContain("release owner");
  expect(cli("show", "tiny").stdout).toContain(vector.sha256);
  const beforeRepeat = await readFile(
    join(root, "knowledge/extensions/registry.json"),
    "utf8",
  );
  expect(cli("install", source, "--json").json().changed).toBe(false);
  expect(
    await readFile(join(root, "knowledge/extensions/registry.json"), "utf8"),
  ).toBe(beforeRepeat);
  const completed =
    "---\ntype: Reference\ntitle: Completed review\n---\n\n[Workflow](/extensions/tiny/workflows/review.md)\n";
  await writeFile(
    join(root, "knowledge/reference/completed-review.md"),
    completed,
  );
  expect(cli("disable", "tiny", "--json").code).toBe(0);
  expect(cli("list", "--json").json().workflows).toEqual([]);
  expect(cli("remove", "tiny", "--json").code).toBe(0);
  expect(cli("show", "tiny", "--json").json().status).toBe("removed");
  expect(
    await readFile(
      join(root, "knowledge/extensions/tiny/workflows/review.md"),
      "utf8",
    ),
  ).toBe(vector.files["workflows/review.md"]);
  expect(
    await readFile(
      join(root, "knowledge/reference/completed-review.md"),
      "utf8",
    ),
  ).toBe(completed);
  expect(cli("enable", "tiny", "--json").code).toBe(0);
  expect(
    cli("show", "tiny", "--json").json().effectiveConfig.reviewer.owner,
  ).toBe("project");
  expect(cli("configure", "tiny", "--reset", "reviewer", "--json").code).toBe(
    0,
  );
  expect(
    cli("show", "tiny", "--json").json().effectiveConfig.reviewer.owner,
  ).toBe("default");
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toStartWith(
    "Handwritten project instruction.\n",
  );
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
    "`tiny:review`",
  );
  expect(cli("disable", "tiny", "--json").code).toBe(0);
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
    "Handwritten project instruction.\n",
  );
  expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
    "EXT-999\n",
  );
  expect(await Bun.file(join(root, "knowledge/index.md")).exists()).toBe(false);
}, 20_000);

test("CLI failures stay structured and preserve the installed candidate", async () => {
  const { root, source, cli } = await fixture();
  expect(cli("install", source, "--enable", "--json").code).toBe(0);
  const path = join(root, "knowledge/extensions/registry.json");
  const before = await readFile(path, "utf8");
  for (const value of [
    '{"unknown":"x"}',
    '{"reviewer":false}',
    "[]",
    "null",
    "{",
  ]) {
    const result = cli("configure", "tiny", "--set", value, "--json");
    expect(result.code).toBe(1);
    expect(result.json().ok).toBe(false);
    expect(result.json().diagnostics.length).toBeGreaterThan(0);
    expect(await readFile(path, "utf8")).toBe(before);
  }
  const unknown = cli("show", "missing", "--json");
  expect(unknown.code).toBe(1);
  expect(unknown.json().diagnostics[0].message).toContain("not installed");
  const manifest = {
    ...vector.manifest,
    engine: { min: "9.0.0", maxExclusive: "10.0.0" },
  };
  await writeFile(join(source, "extension.json"), JSON.stringify(manifest));
  const incompatible = cli("inspect", source, "--json");
  expect(incompatible.code).toBe(1);
  expect(incompatible.json().compatibility).toBe("incompatible");
  expect(cli("install", source, "--json").code).toBe(1);
  expect(await readFile(path, "utf8")).toBe(before);
  expect(cli("recover", "--dry-run", "--json").json().changed).toBe(false);
}, 20_000);

test("a committed clone uses content and choices without the package author directory", async () => {
  const { root, source, directory, cli } = await fixture();
  expect(cli("install", source, "--enable", "--json").code).toBe(0);
  expect(
    cli("configure", "tiny", "--set", '{"reviewer":"release owner"}', "--json")
      .code,
  ).toBe(0);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Extension Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root },
    );
    expect(result.exitCode).toBe(0);
  };
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "Retain pinned package and project choices");
  const clone = join(directory, "fresh-clone");
  git("clone", "--quiet", root, clone);
  await rm(source, { recursive: true });
  const shown = invoke(clone, "show", "tiny", "--json");
  expect(shown.code).toBe(0);
  expect(shown.json().availability).toBe("available");
  expect(shown.json().digest).toBe(vector.sha256);
  expect(shown.json().effectiveConfig.reviewer.value).toBe("release owner");
  expect(invoke(clone, "list", "--json").json().workflows[0].identity).toBe(
    "tiny:review",
  );
  expect(await Bun.file(join(clone, ".docket/active-task")).exists()).toBe(
    false,
  );
}, 20_000);

test("tool bindings remain project data and source edits stay visible through removal", async () => {
  const { root, source, cli } = await fixture();
  await mkdir(join(source, "recipes"));
  await writeFile(
    join(source, "recipes/issues.md"),
    "---\ntype: Reference\ntitle: Read issue evidence\ndescription: Use an available read capability\n---\n\nRead the chosen issue with source identity and revision. Follow [project guidance](/reference/project-guidance.md).\n",
  );
  await writeFile(
    join(source, "extension.json"),
    JSON.stringify({
      ...vector.manifest,
      files: [...vector.manifest.files, "recipes/issues.md"],
      capabilities: [
        {
          id: "issue-read",
          access: "read",
          description: "Read issue evidence",
          recipe: "recipes/issues.md",
        },
      ],
    }),
  );
  expect(cli("install", source, "--enable", "--json").code).toBe(0);
  expect(
    cli(
      "configure",
      "tiny",
      "--bindings",
      '{"issue-read":"fixture.issue_get"}',
      "--json",
    ).code,
  ).toBe(0);
  expect(cli("show", "tiny", "--json").json().bindings).toEqual({
    "issue-read": "fixture.issue_get",
  });
  const registry = join(root, "knowledge/extensions/registry.json");
  const before = await readFile(registry, "utf8");
  expect(
    cli(
      "configure",
      "tiny",
      "--bindings",
      '{"unknown":"fixture.issue_get"}',
      "--json",
    ).code,
  ).toBe(1);
  expect(await readFile(registry, "utf8")).toBe(before);
  expect(
    cli("configure", "tiny", "--unbind", "issue-read", "--json").code,
  ).toBe(0);
  expect(cli("show", "tiny", "--json").json().bindings).toEqual({});
  const workflow = join(root, "knowledge/extensions/tiny/workflows/review.md");
  const store = new LocalFileStore(join(root, "knowledge"));
  const config = parseConfig(await readFile(join(root, "docket.yaml"), "utf8"));
  const documentPath = "extensions/tiny/workflows/review.md";
  const draft = await readEditableDocument(store, config, documentPath);
  const saved = await editDocument(store, config, documentPath, {
    expectedVersion: draft.version,
    patch: {
      body: `${draft.body}\nProject adaptation: include accessibility findings.\n`,
    },
  });
  expect(saved.taskId).toBeNull();
  const adapted = await readFile(workflow, "utf8");
  const view = cli("show", "tiny", "--json").json();
  expect(view.availability).toBe("review-required");
  expect(view.reviewRequiredPaths).toContain("workflows/review.md");
  expect(cli("list", "--json").json().workflows).toEqual([]);
  expect(cli("remove", "tiny", "--json").code).toBe(0);
  expect(await readFile(workflow, "utf8")).toBe(adapted);
  expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
    "EXT-999\n",
  );
}, 20_000);

test("dry-run and actual lifecycle writes reject the same corrupt provenance without changes", async () => {
  const { root, source, cli } = await fixture();
  expect(cli("install", source, "--enable", "--json").code).toBe(0);
  const path = join(root, "knowledge/extensions/registry.json");
  const registry = JSON.parse(await readFile(path, "utf8"));
  registry.packages.tiny.digest = "0".repeat(64);
  const corrupt = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(path, corrupt);
  for (const args of [
    ["disable", "tiny"],
    ["remove", "tiny"],
    ["configure", "tiny", "--set", '{"reviewer":"release owner"}'],
  ]) {
    for (const mode of [["--dry-run"], []]) {
      const result = cli(...args, ...mode, "--json");
      expect(result.code).toBe(1);
      expect(result.json().ok).toBe(false);
      expect(result.json().changed).toBe(false);
      expect(await readFile(path, "utf8")).toBe(corrupt);
      expect(
        await Bun.file(
          join(root, "knowledge/extensions/.transaction.json"),
        ).exists(),
      ).toBe(false);
    }
  }
}, 20_000);
