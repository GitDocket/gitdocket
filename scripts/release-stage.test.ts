import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportPublicSnapshot } from "./export-public";
import {
  buildReleasePlan,
  collectReleaseSnapshot,
  serializeReleasePlan,
} from "./release-contract";
import {
  ARTIFACT_SMOKE_CHECKS,
  defaultCommandRunner,
  PUBLIC_RELEASE_CHECKS,
  parseStageReceipt,
  type StageReceipt,
  stageRelease,
  verifyStageArtifacts,
} from "./release-stage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "gitdocket-stage-test-"));
  roots.push(path);
  return path;
}

async function put(root: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}

async function git(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ["git", "-C", root, ...args],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "GitDocket stage test",
      GIT_AUTHOR_EMAIL: "stage-test@example.invalid",
      GIT_COMMITTER_NAME: "GitDocket stage test",
      GIT_COMMITTER_EMAIL: "stage-test@example.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim());
  return stdout.trim();
}

async function sourceFixture(version = "0.2.0"): Promise<string> {
  const source = await root();
  await git(source, "init", "-q");
  const files: Record<string, string> = {
    "README.md": `GitDocket ${version}\n`,
    "docs/getting-started.md": `GitDocket reports ${version}.\n`,
    [`docs/releases/v${version}.md`]: `# GitDocket ${version}\n\nReviewed release notes for the stage integration fixture.\n`,
    "packages/core/src/version.ts": `export const DOCKET_VERSION = "${version}";\n`,
    "packages/core/src/shipped-history.json": `${JSON.stringify([{ version, bodies: {} }])}\n`,
    "scripts/release-contract.test.ts": "export {};\n",
    "scripts/release-contract.ts": "export {};\n",
    "scripts/release-pack.ts": "export {};\n",
    "scripts/release-publish.ts": "export {};\n",
    "scripts/release-publication.test.ts": "export {};\n",
    "scripts/release-publication.ts": "export {};\n",
    "scripts/release-rehearse.test.ts": "export {};\n",
    "scripts/release-rehearse.ts": "export {};\n",
    "scripts/release-stage.test.ts": "export {};\n",
    "scripts/release-stage.ts": "export {};\n",
    "scripts/release.ts": "export {};\n",
  };
  const packageDependencies: Record<string, Record<string, string>> = {
    core: {},
    web: { "@gitdocket/core": "workspace:*" },
    cli: {
      "@gitdocket/core": "workspace:*",
      "@gitdocket/web": "workspace:*",
    },
    mcp: { "@gitdocket/core": "workspace:*" },
  };
  for (const [id, dependencies] of Object.entries(packageDependencies)) {
    files[`packages/${id}/package.json`] = `${JSON.stringify(
      { name: `@gitdocket/${id}`, version, dependencies },
      null,
      2,
    )}\n`;
  }
  files["bun.lock"] = `${Object.keys(packageDependencies)
    .map(
      (id) =>
        `"packages/${id}": { "name": "@gitdocket/${id}", "version": "${version}" }`,
    )
    .join("\n")}\n`;
  const paths = [...Object.keys(files), "release/public-export.json"].sort();
  files["release/public-export.json"] = `${JSON.stringify(
    { schema: 1, paths },
    null,
    2,
  )}\n`;
  for (const [path, body] of Object.entries(files)) {
    await put(source, path, body);
  }
  await git(source, "add", "-A");
  await git(source, "commit", "-qm", "source fixture");
  return source;
}

async function planFixture(source: string, version = "0.2.0") {
  const intent = {
    version,
    channel: "latest",
    notesPath: `docs/releases/v${version}.md`,
  };
  const plan = buildReleasePlan(
    await collectReleaseSnapshot(source, intent),
    intent,
  );
  const planPath = join(await root(), "plan.json");
  await writeFile(planPath, serializeReleasePlan(plan));
  return { plan, planPath };
}

const sourceCommit = "a".repeat(40);
const hash = (body: string): string =>
  new Bun.CryptoHasher("sha256").update(body).digest("hex");

async function receiptFixture(): Promise<{
  root: string;
  receipt: StageReceipt;
}> {
  const publicRoot = await root();
  const publicFile = "public\n";
  await put(publicRoot, "README.md", publicFile);
  const stateBody = `${JSON.stringify(
    {
      schema: 1,
      sourceCommit,
      manifestPath: "release/public-export.json",
      files: { "README.md": hash(publicFile) },
    },
    null,
    2,
  )}\n`;
  await put(publicRoot, ".gitdocket-source.json", stateBody);
  const packages = ["core", "web", "cli", "mcp"].map((id) => ({
    id,
    name: `@gitdocket/${id}`,
    path: `release/tarballs/gitdocket-${id}-0.2.0.tgz`,
    body: `tarball-${id}`,
  }));
  for (const item of packages) await put(publicRoot, item.path, item.body);
  return {
    root: publicRoot,
    receipt: {
      schema: 1,
      version: "0.2.0",
      sourceCommit,
      planSha256: "b".repeat(64),
      public: {
        repository: "GitDocket/gitdocket",
        baselineCommit: "c".repeat(40),
        exportStateSha256: hash(stateBody),
        additions: ["README.md"],
        changes: [],
        deletions: [],
      },
      checks: [...PUBLIC_RELEASE_CHECKS],
      tarballs: packages.map((item) => ({
        name: item.name,
        version: "0.2.0",
        path: item.path,
        sha256: hash(item.body),
      })),
      smoke: {
        checks: [...ARTIFACT_SMOKE_CHECKS],
        packageVersions: Object.fromEntries(
          packages.map((item) => [item.name, "0.2.0"]),
        ),
        mcpTools: Array.from({ length: 9 }, (_, index) => `tool-${index}`),
        serveStatus: 200,
      },
      approvalReady: true,
    },
  };
}

describe("stage receipt binding", () => {
  test("accepts and verifies an unchanged export state and tarball", async () => {
    const fixture = await receiptFixture();
    expect(parseStageReceipt(fixture.receipt)).toEqual(fixture.receipt);
    await expect(
      verifyStageArtifacts(fixture.root, fixture.receipt),
    ).resolves.toBeUndefined();
  });

  test("rejects malformed receipts and substituted tarballs", async () => {
    const fixture = await receiptFixture();
    expect(() =>
      parseStageReceipt({ ...fixture.receipt, planSha256: "bad" }),
    ).toThrow("schema 1");
    await writeFile(
      join(fixture.root, fixture.receipt.tarballs[0]?.path ?? "missing"),
      "substituted",
    );
    await expect(
      verifyStageArtifacts(fixture.root, fixture.receipt),
    ).rejects.toThrow("tarball no longer matches");
  });

  test("rejects export-file drift after the public gate", async () => {
    const fixture = await receiptFixture();
    await writeFile(join(fixture.root, "README.md"), "changed\n");
    await expect(
      verifyStageArtifacts(fixture.root, fixture.receipt),
    ).rejects.toThrow("staged public file drifted");
  });
});

describe("public gate runner", () => {
  test("forces every internal candidate dependency to the exact local tarballs", async () => {
    const source = await readFile(
      new URL("./release-stage.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "options.localTarballs ? { overrides: options.dependencies } : {}",
    );
  });

  test("surfaces the exact failed smoke or gate command", async () => {
    const cwd = await root();
    await expect(
      defaultCommandRunner(["bun", "-e", "process.exit(7)"], { cwd }),
    ).rejects.toThrow("bun -e process.exit(7) failed");
  });

  test("stages a complete local candidate with mocked external checks", async () => {
    const source = await sourceFixture();
    const destination = await root();
    await git(destination, "init", "-q");
    await git(destination, "commit", "--allow-empty", "-qm", "public baseline");
    const { plan, planPath } = await planFixture(source);
    const outputPath = join(await root(), "stage.json");
    const commands: string[] = [];

    const result = await stageRelease(
      { sourceRoot: source, planPath, destination, output: outputPath },
      {
        runCommand: async (command, options) => {
          commands.push(command.join(" "));
          if (command.join(" ") === "bun run release:pack") {
            for (const item of plan.packages) {
              await put(options.cwd, item.tarball, `packed ${item.name}\n`);
            }
          }
        },
        runSmoke: async () => ({
          packageVersions: Object.fromEntries(
            plan.packages.map((item) => [item.name, item.version]),
          ),
          mcpTools: Array.from({ length: 9 }, (_, index) => `tool-${index}`),
          serveStatus: 200,
        }),
      },
    );

    expect(result.receipt.approvalReady).toBeTrue();
    expect(result.receipt.sourceCommit).toBe(plan.sourceCommit);
    expect(result.receipt.public.additions).toContain("README.md");
    expect(result.receipt.tarballs).toHaveLength(4);
    expect(commands).toEqual([
      "bun install --frozen-lockfile",
      "bunx biome ci .",
      "bunx tsc --noEmit",
      "bun test",
      "bun ../../packages/cli/src/index.ts lint",
      "bun ../../packages/cli/src/index.ts index --check",
      "bun run audit:dependencies",
      "bun run release:pack",
    ]);
    expect(
      parseStageReceipt(JSON.parse(await Bun.file(outputPath).text()))
        .planSha256,
    ).toBe(result.receipt.planSha256);
  });

  test("rejects dirty, unexplained, and prior-state-mismatched public checkouts", async () => {
    const source = await sourceFixture();
    const { planPath } = await planFixture(source);
    const noOp = async () => {};

    const dirty = await root();
    await git(dirty, "init", "-q");
    await git(dirty, "commit", "--allow-empty", "-qm", "public baseline");
    await writeFile(join(dirty, "dirty.txt"), "dirty\n");
    await expect(
      stageRelease(
        { sourceRoot: source, planPath, destination: dirty },
        { runCommand: noOp },
      ),
    ).rejects.toThrow("destination Git checkout must be clean");

    const unexplained = await root();
    await git(unexplained, "init", "-q");
    await writeFile(join(unexplained, "unexplained.txt"), "committed\n");
    await git(unexplained, "add", "-A");
    await git(unexplained, "commit", "-qm", "unexplained public history");
    await expect(
      stageRelease(
        { sourceRoot: source, planPath, destination: unexplained },
        { runCommand: noOp },
      ),
    ).rejects.toThrow("destination is unexplained");

    const mismatched = await root();
    await git(mismatched, "init", "-q");
    await exportPublicSnapshot({
      sourceRoot: source,
      sourceCommit: await git(source, "rev-parse", "HEAD"),
      destination: mismatched,
    });
    await git(mismatched, "add", "-A");
    await git(mismatched, "commit", "-qm", "staged public snapshot");
    await writeFile(join(mismatched, "README.md"), "mismatch\n");
    await git(mismatched, "add", "README.md");
    await git(mismatched, "commit", "-qm", "mismatch exported state");
    await expect(
      stageRelease(
        { sourceRoot: source, planPath, destination: mismatched },
        { runCommand: noOp },
      ),
    ).rejects.toThrow("differs from its prior export state");
  });
});
