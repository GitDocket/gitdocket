import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { type ExportReport, exportPublicSnapshot } from "./export-public";
import {
  buildReleasePlan,
  collectReleaseSnapshot,
  parseReleasePlan,
  type ReleasePlan,
  runGit,
  serializeReleasePlan,
} from "./release-contract";

export const STAGE_SCHEMA = 1 as const;
export const PUBLIC_RELEASE_CHECKS = [
  "bun install --frozen-lockfile",
  "bunx biome ci .",
  "bunx tsc --noEmit",
  "bun test",
  "bun ../../packages/cli/src/index.ts lint (examples/basic)",
  "bun ../../packages/cli/src/index.ts index --check (examples/basic)",
  "bun run audit:dependencies",
  "bun run release:pack",
] as const;
export const ARTIFACT_SMOKE_CHECKS = [
  "install all four local tarballs",
  "verify installed package manifests",
  "docket --version",
  "docket init",
  "docket index --check",
  "docket ready --json",
  "docket serve --port 0",
  "docket-mcp initialize and tools/list",
  "docket upgrade --dry-run --json",
] as const;

export interface StageReceipt {
  schema: typeof STAGE_SCHEMA;
  version: string;
  sourceCommit: string;
  planSha256: string;
  public: {
    repository: string;
    baselineCommit: string;
    exportStateSha256: string;
    additions: string[];
    changes: string[];
    deletions: string[];
  };
  checks: string[];
  tarballs: Array<{
    name: string;
    version: string;
    path: string;
    sha256: string;
  }>;
  smoke: {
    checks: string[];
    packageVersions: Record<string, string>;
    mcpTools: string[];
    serveStatus: number;
  };
  approvalReady: true;
}

export interface SmokeResult {
  packageVersions: Record<string, string>;
  mcpTools: string[];
  serveStatus: number;
}

export interface InstalledSmokeOptions {
  dependencies: Record<string, string>;
  version: string;
  localTarballs?: string[];
}

export type CommandRunner = (
  command: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
) => Promise<void>;

interface ExportState {
  schema: 1;
  sourceCommit: string;
  manifestPath: string;
  files: Record<string, string>;
}

interface StageOptions {
  sourceRoot: string;
  planPath: string;
  destination: string;
  output?: string;
}

interface StageDependencies {
  runCommand?: CommandRunner;
  runSmoke?: (destination: string, plan: ReleasePlan) => Promise<SmokeResult>;
}

export function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function fileSha256(path: string): Promise<string> {
  return sha256(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

export async function defaultCommandRunner(
  command: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed${stdout.trim() ? `\n${stdout.trim()}` : ""}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    );
  }
  process.stderr.write(`✓ ${command.join(" ")}\n`);
}

export async function runPublicReleaseGate(
  root: string,
  run: CommandRunner = defaultCommandRunner,
): Promise<void> {
  await run(["bun", "install", "--frozen-lockfile"], { cwd: root });
  await run(["bunx", "biome", "ci", "."], { cwd: root });
  await run(["bunx", "tsc", "--noEmit"], { cwd: root });
  await run(["bun", "test"], { cwd: root });
  const example = join(root, "examples/basic");
  await run(["bun", "../../packages/cli/src/index.ts", "lint"], {
    cwd: example,
  });
  await run(["bun", "../../packages/cli/src/index.ts", "index", "--check"], {
    cwd: example,
  });
  await run(["bun", "run", "audit:dependencies"], { cwd: root });
  await run(["bun", "run", "release:pack"], { cwd: root });
}

function runSync(
  command: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`,
    );
  }
  return stdout;
}

async function smokeServe(cli: string, project: string): Promise<number> {
  const child = Bun.spawn({
    cmd: [cli, "serve", "--port", "0"],
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = await Promise.race([
      (async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += decoder.decode(chunk.value, { stream: true });
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
          if (match?.[0]) return match[0];
        }
        throw new Error(
          "docket serve exited before reporting its loopback URL",
        );
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill();
          reject(new Error("docket serve did not start in 10s"));
        }, 10_000);
      }),
    ]);
    clearTimeout(timeout);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok)
      throw new Error(`docket serve returned HTTP ${response.status}`);
    return response.status;
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
}

async function readJsonLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<Record<string, unknown>> {
  while (true) {
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      return JSON.parse(line) as Record<string, unknown>;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("docket-mcp closed before responding");
    state.buffer += new TextDecoder().decode(chunk.value, { stream: true });
  }
}

async function smokeMcp(mcp: string, project: string): Promise<string[]> {
  const child = Bun.spawn({
    cmd: [mcp],
    cwd: project,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = async (message: unknown): Promise<void> => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    await child.stdin.flush();
  };
  const reader = child.stdout.getReader();
  const state = { buffer: "" };
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 10_000);
  try {
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "gitdocket-release-smoke", version: "1" },
      },
    });
    const initialized = await readJsonLine(reader, state);
    if (initialized.id !== 1 || !initialized.result) {
      throw new Error("docket-mcp initialization failed");
    }
    await send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    let listed = await readJsonLine(reader, state);
    while (listed.id !== 2) listed = await readJsonLine(reader, state);
    const result = listed.result as { tools?: Array<{ name?: string }> };
    const tools = (result.tools ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string")
      .sort();
    if (tools.length !== 9) {
      throw new Error(`docket-mcp exposed ${tools.length} tools, expected 9`);
    }
    return tools;
  } catch (error) {
    if (timedOut) throw new Error("docket-mcp smoke timed out after 10s");
    throw error;
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    child.kill();
    await child.exited;
  }
}

export async function runInstalledSmoke(
  options: InstalledSmokeOptions,
): Promise<SmokeResult> {
  const root = await mkdtemp(join(tmpdir(), "gitdocket-artifact-smoke-"));
  try {
    const manifest = {
      private: true,
      dependencies: options.dependencies,
      ...(options.localTarballs ? { overrides: options.dependencies } : {}),
    };
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await defaultCommandRunner(
      ["bun", "install", "--ignore-scripts", "--backend=copyfile"],
      { cwd: root, env: { BUN_INSTALL_CACHE_DIR: join(root, ".bun-cache") } },
    );

    const packageVersions: Record<string, string> = {};
    for (const name of Object.keys(options.dependencies)) {
      const manifest = JSON.parse(
        await readFile(
          join(root, "node_modules", name, "package.json"),
          "utf8",
        ),
      ) as { name?: string; version?: string };
      if (manifest.name !== name || manifest.version !== options.version) {
        throw new Error(
          `${name} installed as ${manifest.name}@${manifest.version}, expected ${name}@${options.version}`,
        );
      }
      packageVersions[name] = manifest.version;
    }
    const lockfile = await readFile(join(root, "bun.lock"), "utf8");
    for (const tarball of options.localTarballs ?? []) {
      if (!lockfile.includes(basename(tarball))) {
        throw new Error(
          `smoke lockfile did not resolve a package from ${tarball}`,
        );
      }
    }

    const bin = join(root, "node_modules", ".bin");
    const cli = join(bin, "docket");
    const mcp = join(bin, "docket-mcp");
    const reported = runSync([cli, "--version"], root);
    if (reported !== options.version) {
      throw new Error(
        `docket --version reported ${reported}, expected ${options.version}`,
      );
    }

    const project = join(root, "project");
    await mkdir(project);
    runSync(["git", "init", "-q"], project);
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    const init = JSON.parse(
      runSync(
        [
          cli,
          "init",
          "--project",
          "SMOKE",
          "--agent",
          "codex",
          "--agent",
          "claude",
          "--json",
        ],
        project,
        env,
      ),
    ) as { steps?: unknown[] };
    if (!Array.isArray(init.steps))
      throw new Error("docket init returned no steps");
    runSync([cli, "index", "--check"], project, env);
    const ready = JSON.parse(runSync([cli, "ready", "--json"], project, env));
    if (!Array.isArray(ready))
      throw new Error("docket ready did not return an array");
    const serveStatus = await smokeServe(cli, project);
    const mcpTools = await smokeMcp(mcp, project);
    const upgrade = JSON.parse(
      runSync([cli, "upgrade", "--dry-run", "--json"], project, env),
    ) as { dryRun?: boolean };
    if (upgrade.dryRun !== true)
      throw new Error("docket upgrade did not stay dry-run");
    return { packageVersions, mcpTools, serveStatus };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runArtifactSmoke(
  publicRoot: string,
  plan: ReleasePlan,
): Promise<SmokeResult> {
  return runInstalledSmoke({
    dependencies: Object.fromEntries(
      plan.packages.map((item) => [
        item.name,
        `file:${resolve(publicRoot, item.tarball)}`,
      ]),
    ),
    version: plan.version,
    localTarballs: plan.packages.map((item) => item.tarball),
  });
}

async function readExportState(destination: string): Promise<{
  body: string;
  state: ExportState;
}> {
  const body = await readFile(
    join(destination, ".gitdocket-source.json"),
    "utf8",
  );
  const state = JSON.parse(body) as ExportState;
  if (
    state.schema !== 1 ||
    !/^[0-9a-f]{40}$/.test(state.sourceCommit) ||
    state.manifestPath !== "release/public-export.json" ||
    typeof state.files !== "object" ||
    state.files === null
  ) {
    throw new Error("staged public export state is malformed");
  }
  for (const [path, hash] of Object.entries(state.files)) {
    if ((await fileSha256(join(destination, path))) !== hash) {
      throw new Error(`staged public file drifted after export: ${path}`);
    }
  }
  return { body, state };
}

export function parseStageReceipt(value: unknown): StageReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stage receipt must be an object");
  }
  const receipt = value as Partial<StageReceipt>;
  if (
    receipt.schema !== STAGE_SCHEMA ||
    typeof receipt.version !== "string" ||
    typeof receipt.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(receipt.sourceCommit) ||
    typeof receipt.planSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.planSha256) ||
    !receipt.public ||
    receipt.public.repository !== "GitDocket/gitdocket" ||
    typeof receipt.public.baselineCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(receipt.public.baselineCommit) ||
    !/^[0-9a-f]{64}$/.test(receipt.public.exportStateSha256) ||
    !Array.isArray(receipt.public.additions) ||
    !Array.isArray(receipt.public.changes) ||
    !Array.isArray(receipt.public.deletions) ||
    JSON.stringify(receipt.checks) !== JSON.stringify(PUBLIC_RELEASE_CHECKS) ||
    !Array.isArray(receipt.tarballs) ||
    receipt.tarballs.length !== 4 ||
    !receipt.smoke ||
    JSON.stringify(receipt.smoke.checks) !==
      JSON.stringify(ARTIFACT_SMOKE_CHECKS) ||
    receipt.smoke.serveStatus !== 200 ||
    !Array.isArray(receipt.smoke.mcpTools) ||
    receipt.smoke.mcpTools.length !== 9 ||
    receipt.approvalReady !== true
  ) {
    throw new Error("stage receipt violates schema 1");
  }
  const expectedNames = [
    "@gitdocket/core",
    "@gitdocket/web",
    "@gitdocket/cli",
    "@gitdocket/mcp",
  ];
  if (
    receipt.tarballs.some(
      (item, index) =>
        item.name !== expectedNames[index] ||
        item.version !== receipt.version ||
        !/^[0-9a-f]{64}$/.test(item.sha256) ||
        receipt.smoke?.packageVersions[item.name] !== receipt.version,
    )
  ) {
    throw new Error("stage receipt package evidence is inconsistent");
  }
  return receipt as StageReceipt;
}

export async function verifyStageArtifacts(
  publicRoot: string,
  receipt: StageReceipt,
): Promise<void> {
  parseStageReceipt(receipt);
  const exportState = await readExportState(publicRoot);
  if (sha256(exportState.body) !== receipt.public.exportStateSha256) {
    throw new Error("public export state no longer matches the stage receipt");
  }
  if (exportState.state.sourceCommit !== receipt.sourceCommit) {
    throw new Error("public export source no longer matches the stage receipt");
  }
  for (const tarball of receipt.tarballs) {
    if (
      (await fileSha256(resolve(publicRoot, tarball.path))) !== tarball.sha256
    ) {
      throw new Error(
        `tarball no longer matches the stage receipt: ${tarball.path}`,
      );
    }
  }
}

export async function stageRelease(
  options: StageOptions,
  dependencies: StageDependencies = {},
): Promise<{ output: string; receipt: StageReceipt }> {
  const sourceRoot = await realpath(options.sourceRoot);
  const destination = await realpath(options.destination);
  const planBody = await readFile(
    resolve(sourceRoot, options.planPath),
    "utf8",
  );
  const plan = parseReleasePlan(JSON.parse(planBody));
  const currentPlan = buildReleasePlan(
    await collectReleaseSnapshot(sourceRoot, {
      version: plan.version,
      channel: plan.channel,
      notesPath: plan.notes.path,
    }),
    {
      version: plan.version,
      channel: plan.channel,
      notesPath: plan.notes.path,
    },
  );
  if (serializeReleasePlan(currentPlan) !== serializeReleasePlan(plan)) {
    throw new Error(
      "candidate plan no longer matches the canonical source state",
    );
  }

  const baselineCommit = await runGit(destination, "rev-parse", "HEAD");
  const report: ExportReport = await exportPublicSnapshot({
    sourceRoot,
    sourceCommit: plan.sourceCommit,
    destination,
  });
  const run = dependencies.runCommand ?? defaultCommandRunner;
  await runPublicReleaseGate(destination, run);
  const smoke = await (dependencies.runSmoke ?? runArtifactSmoke)(
    destination,
    plan,
  );
  const exportState = await readExportState(destination);
  if (exportState.state.sourceCommit !== plan.sourceCommit) {
    throw new Error(
      "staged public state does not name the planned source commit",
    );
  }
  const tarballs = await Promise.all(
    plan.packages.map(async (item) => ({
      name: item.name,
      version: item.version,
      path: item.tarball,
      sha256: await fileSha256(resolve(destination, item.tarball)),
    })),
  );
  const receipt: StageReceipt = {
    schema: STAGE_SCHEMA,
    version: plan.version,
    sourceCommit: plan.sourceCommit,
    planSha256: sha256(serializeReleasePlan(plan)),
    public: {
      repository: plan.publicRepository,
      baselineCommit,
      exportStateSha256: sha256(exportState.body),
      additions: report.additions,
      changes: report.changes,
      deletions: report.deletions,
    },
    checks: [...PUBLIC_RELEASE_CHECKS],
    tarballs,
    smoke: { checks: [...ARTIFACT_SMOKE_CHECKS], ...smoke },
    approvalReady: true,
  };
  parseStageReceipt(receipt);
  const outputPath = options.output
    ? isAbsolute(options.output)
      ? options.output
      : resolve(sourceRoot, options.output)
    : resolve(sourceRoot, "release/candidates", `v${plan.version}-stage.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { output: relative(sourceRoot, outputPath) || outputPath, receipt };
}
