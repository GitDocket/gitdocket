import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { exportPublicSnapshot } from "./export-public";
import {
  verifyLinuxQualification,
  verifyMacosQualification,
  verifyQualificationMatrix,
} from "./macos-qualification";
import { parseReleasePlan } from "./release-contract";
import { linuxDocker } from "./release-linux";
import {
  capture,
  jsonFile,
  readOptions,
  required,
  saveReceipt,
} from "./release-operator";
import {
  assertPackageGraph,
  classifyRegistry,
  PACKAGE_IDS,
  type PublicationCandidate,
  packageCandidate,
  type RegistryBoundary,
} from "./release-publication";
import { NpmRegistryBoundary } from "./release-publish";
import {
  parseStageReceipt,
  sha256,
  verifyStageArtifacts,
} from "./release-stage";
import {
  type StandaloneManifest,
  verifyStandaloneSet,
} from "./standalone-release";
import { checkLevelForTarget } from "./standalone-smoke";

export type ComputeRunner = (
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
) => Promise<void>;
export const compute: ComputeRunner = async (args, cwd, env) => {
  console.error(`[release-compute] START ${args.join(" ")}`);
  const child = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error(`compute failed: ${args.join(" ")}`);
  console.error(`[release-compute] COMPLETE ${args[0]} ${args[1]}`);
};

type MacTools = { bun: string; node: string; npm: string; brew: string };
export interface QualificationConfig {
  source: string;
  plan: string;
  linuxArtifacts: string;
  mode: "build" | "verify";
  linuxDocker?: boolean;
  fullMatrix?: boolean;
  mac?: { arm64: MacTools; x64: MacTools };
}
export function validateQualificationConfig(value: QualificationConfig): void {
  assert(
    value && ["build", "verify"].includes(value.mode),
    "qualify mode must be build or verify",
  );
  for (const name of ["source", "plan", "linuxArtifacts"] as const)
    assert(
      typeof value[name] === "string" && isAbsolute(value[name]),
      `qualify ${name} requires an absolute path`,
    );
  assert(
    value.fullMatrix === undefined || typeof value.fullMatrix === "boolean",
    "qualify fullMatrix must be boolean",
  );
  if (value.mode === "build") {
    assert.equal(
      process.platform,
      "darwin",
      "Mac qualification must run on the owner's Mac",
    );
    for (const arch of ["arm64", "x64"] as const) {
      const tools = value.mac?.[arch];
      assert(tools, `missing ${arch} toolchain`);
      for (const key of ["bun", "node", "npm", "brew"] as const)
        assert(
          typeof tools[key] === "string" && isAbsolute(tools[key]),
          `qualify ${arch}.${key} requires an absolute path`,
        );
    }
  }
}

export async function qualifyRelease(
  config: QualificationConfig,
  output: string,
  dependencies: {
    run?: ComputeRunner;
    verify?: typeof verifyStandaloneSet;
    verifyMac?: typeof verifyMacosQualification;
    sourceRoot?: string;
  } = {},
): Promise<void> {
  validateQualificationConfig(config);
  const plan = parseReleasePlan(await jsonFile(config.plan));
  if (
    !(await Bun.file(join(config.source, ".gitdocket-source.json")).exists())
  ) {
    assert(
      dependencies.sourceRoot,
      "qualify requires an existing reviewed export or the canonical source root",
    );
    await mkdir(config.source);
    capture(["git", "init", "-q", config.source]);
    await exportPublicSnapshot({
      sourceRoot: dependencies.sourceRoot,
      sourceCommit: plan.sourceCommit,
      destination: config.source,
    });
  }
  for (const outputPath of [output, `${output}.config.json`]) {
    for (const path of [
      config.plan,
      join(config.source, ".gitdocket-source.json"),
    ])
      assert.notEqual(
        resolve(outputPath),
        resolve(path),
        "qualification output must preserve inputs",
      );
  }
  await saveReceipt(`${output}.config.json`, config);
  const stateBody = await readFile(
    join(config.source, ".gitdocket-source.json"),
    "utf8",
  );
  const state = JSON.parse(stateBody);
  assert.equal(
    state.sourceCommit,
    plan.sourceCommit,
    "qualification source does not match plan",
  );
  const artifacts = join(config.source, "release/standalone");
  const run = dependencies.run ?? compute;
  const steps: string[] = [];
  const record = async (status: string, error?: string) =>
    saveReceipt(output, {
      schema: 1,
      command: "qualify",
      status,
      config,
      sourceCommit: plan.sourceCommit,
      exportSha256: sha256(stateBody),
      planSha256: sha256(await readFile(config.plan)),
      completedSteps: [...steps],
      error,
      externalWrites: false,
      resume: [
        "bun",
        "run",
        "release",
        "--",
        "qualify",
        "--config",
        resolve(`${output}.config.json`),
        "--output",
        resolve(output),
      ],
    });
  await record("RUNNING");
  try {
    // Inspect the Linux identity before any expensive Mac compute or artifact copy.
    const linux = [];
    for (const target of ["linux-arm64", "linux-x64"]) {
      const manifest = await jsonFile<StandaloneManifest>(
        join(config.linuxArtifacts, `${target}.json`),
      );
      assert.equal(manifest.target, target);
      assert.equal(manifest.version, plan.version);
      assert.deepEqual(
        manifest.source,
        {
          kind: "public-export",
          commit: plan.sourceCommit,
          exportSha256: sha256(stateBody),
        },
        "Linux artifacts do not match the planned export",
      );
      assert.equal(
        manifest.archive,
        `gitdocket-${plan.version}-${target}.tar.gz`,
      );
      assert.equal(
        sha256(await readFile(join(config.linuxArtifacts, manifest.archive))),
        manifest.sha256,
        "Linux archive checksum differs",
      );
      linux.push({ target, manifest });
    }
    await mkdir(artifacts, { recursive: true });
    for (const { target, manifest } of linux) {
      for (const name of [
        `${target}.json`,
        manifest.archive,
        `${manifest.archive}.sha256`,
      ]) {
        const source = join(config.linuxArtifacts, name);
        const destination = join(artifacts, name);
        if (resolve(source) !== resolve(destination))
          await copyFile(source, destination);
      }
    }
    if (config.linuxDocker) {
      const dockerBuild = await jsonFile<{
        status: string;
        sourceCommit: string;
        exportSha256: string;
      }>(join(config.linuxArtifacts, "linux-docker-build.json"));
      assert.equal(dockerBuild.status, "READY");
      assert.equal(dockerBuild.sourceCommit, plan.sourceCommit);
      assert.equal(dockerBuild.exportSha256, sha256(stateBody));
      if (resolve(config.linuxArtifacts) !== resolve(artifacts))
        await copyFile(
          join(config.linuxArtifacts, "linux-docker-build.json"),
          join(artifacts, "linux-docker-build.json"),
        );
    }
    steps.push("imported exact-source Linux archives");
    await record("RUNNING");
    if (config.mode === "build") {
      for (const arch of ["arm64", "x64"] as const) {
        const tools = config.mac?.[arch] as MacTools;
        assert.equal(
          capture([tools.bun, "--version"]),
          "1.3.14",
          `pin Bun for ${arch}`,
        );
        assert.match(
          capture([tools.node, "--version"]),
          /^v22\./,
          `Node 22 required for ${arch}`,
        );
        assert.equal(
          capture([tools.node, tools.npm, "--version"]),
          "11.17.0",
          `pin npm for ${arch}`,
        );
        assert.equal(
          capture([tools.bun, "-p", "process.platform + '-' + process.arch"]),
          `darwin-${arch}`,
        );
        assert.equal(capture([tools.node, "-p", "process.arch"]), arch);
        const bin = join(config.source, "release/tools", arch);
        await mkdir(bin, { recursive: true });
        for (const key of ["bun", "node", "npm", "brew"] as const) {
          const path = join(bin, key);
          if (!(await Bun.file(path).exists())) await symlink(tools[key], path);
          else
            assert.equal(
              capture(["readlink", path]),
              tools[key],
              `existing ${arch} tool link differs`,
            );
        }
        const env = { PATH: `${bin}:${process.env.PATH}` };
        await run(
          [tools.bun, "install", "--frozen-lockfile"],
          config.source,
          env,
        );
        await run(
          [
            tools.bun,
            "scripts/standalone-release.ts",
            "build",
            ...(config.fullMatrix ? ["--full-matrix"] : []),
            "--output",
            artifacts,
          ],
          config.source,
          env,
        );
        steps.push(`built darwin-${arch}`);
        await record("RUNNING");
      }
    }
    await (dependencies.verify ?? verifyStandaloneSet)(
      config.source,
      artifacts,
    );
    steps.push("verified all four source-bound archives");
    await record("RUNNING");
    const nativeTools = config.mac?.arm64;
    const bun = nativeTools?.bun ?? process.execPath;
    assert.equal(
      capture([bun, "--version"]),
      "1.3.14",
      "qualification packing requires Bun 1.3.14",
    );
    await run(
      [bun, "scripts/release-pack.ts"],
      config.source,
      nativeTools
        ? {
            PATH: `${join(config.source, "release/tools/arm64")}:${process.env.PATH}`,
          }
        : undefined,
    );
    steps.push("packed coordinated npm tarballs");
    await record("RUNNING");
    if (config.mode === "build") {
      for (const arch of ["arm64", "x64"] as const) {
        const tools = config.mac?.[arch] as MacTools;
        const level = checkLevelForTarget(`darwin-${arch}`, config.fullMatrix);
        const env = {
          PATH: `${join(config.source, "release/tools", arch)}:${process.env.PATH}`,
        };
        await run(
          [
            tools.bun,
            "scripts/npm-qualify.ts",
            "--level",
            level,
            "--output",
            join(artifacts, `npm-darwin-${arch}.json`),
          ],
          config.source,
          env,
        );
        await run(
          [
            tools.bun,
            "scripts/homebrew-qualify.ts",
            "--level",
            level,
            "--source",
            config.source,
            "--artifacts",
            artifacts,
            "--brew",
            tools.brew,
            "--audit",
            "--output",
            join(artifacts, `homebrew-darwin-${arch}.json`),
          ],
          config.source,
          env,
        );
        steps.push(`qualified npm and Homebrew darwin-${arch}`);
        await record("RUNNING");
      }
    }
    await (dependencies.verifyMac ?? verifyMacosQualification)(
      config.source,
      artifacts,
      config.fullMatrix,
    );
    steps.push("verified Mac source, checksum, host and upgrade receipts");
    if (config.linuxDocker) {
      await linuxDocker({
        source: config.source,
        output: artifacts,
        mode: "channels",
        plan: config.plan,
        fullMatrix: config.fullMatrix,
      });
      await verifyLinuxQualification(
        config.source,
        artifacts,
        config.fullMatrix,
      );
      await verifyQualificationMatrix(artifacts, config.fullMatrix);
      steps.push(
        "qualified Linux npm and Homebrew in local Docker, including Node 24 x64",
      );
    }
    await record("READY");
  } catch (error) {
    await record(
      "FAILED",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function createWorkspace(
  root: string,
  options: {
    directory: string;
    ref: string;
    publicRepository: string;
    bun?: string;
    npm?: string;
  },
): Promise<unknown> {
  const directory = resolve(options.directory);
  const bun = options.bun ?? process.execPath;
  const npm = options.npm ?? Bun.which("npm");
  assert(npm, "npm executable is required");
  assert.equal(
    capture([bun, "--version"]),
    "1.3.14",
    "workspace requires Bun 1.3.14; pass --bun or select it in PATH",
  );
  assert.equal(
    capture([npm, "--version"]),
    "11.17.0",
    "workspace requires npm 11.17.0; pass --npm or select it in PATH",
  );
  const commit = capture(
    ["git", "rev-parse", "--verify", `${options.ref}^{commit}`],
    root,
  );
  await mkdir(directory); // Exclusive: never reuse or erase a prior workspace.
  const source = join(directory, "canonical");
  const destination = join(directory, "public");
  const receipt = {
    schema: 1,
    source,
    destination,
    commit,
    tools: { bun, npm },
    externalWrites: false,
  };
  await saveReceipt(join(directory, "workspace.json"), {
    ...receipt,
    state: "CREATING",
  });
  try {
    capture(["git", "worktree", "add", "--detach", source, commit], root);
    capture(
      ["git", "clone", "--", options.publicRepository, destination],
      root,
    );
    await compute([bun, "install", "--frozen-lockfile"], source, {
      PATH: `${resolve(bun, "..")}:${process.env.PATH}`,
    });
    const publicBaseline = capture(["git", "rev-parse", "HEAD"], destination);
    const bin = join(directory, "tools");
    await mkdir(bin);
    await symlink(bun, join(bin, "bun"));
    await symlink(npm, join(bin, "npm"));
    await saveReceipt(join(directory, "workspace.json"), {
      ...receipt,
      publicBaseline,
      state: "READY",
      pathPrefix: bin,
    });
    return { ...receipt, publicBaseline, pathPrefix: bin };
  } catch (error) {
    await saveReceipt(join(directory, "workspace.json"), {
      ...receipt,
      state: "FAILED",
      error: String(error),
      recovery:
        "Keep the worktree and clone for inspection; choose a new workspace directory after resolving the failure.",
    });
    throw error;
  }
}

export function publicReviewDiff(root: string, baseline: string): string {
  const diff = (args: string[]) => {
    const result = Bun.spawnSync(
      ["git", "--no-pager", "diff", "--no-ext-diff", "--binary", ...args],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    assert([0, 1].includes(result.exitCode), result.stderr.toString());
    return result.stdout.toString();
  };
  const tracked = diff([baseline, "--"]);
  const untracked = capture(
    ["git", "ls-files", "--others", "--exclude-standard", "-z"],
    root,
  )
    .split("\0")
    .filter(Boolean);
  return (
    tracked +
    untracked
      .map((path) => diff(["--no-index", "--", "/dev/null", path]))
      .join("")
  );
}

export async function reviewPacket(
  options: { plan: string; stage: string; destination: string; output: string },
  registry: Pick<RegistryBoundary, "inspect"> = new NpmRegistryBoundary(),
): Promise<void> {
  const planBody = await readFile(options.plan, "utf8");
  const stageBody = await readFile(options.stage, "utf8");
  const plan = parseReleasePlan(JSON.parse(planBody));
  const stage = parseStageReceipt(JSON.parse(stageBody));
  assert.equal(
    stage.planSha256,
    sha256(planBody),
    "stage does not bind this plan",
  );
  assert.equal(stage.sourceCommit, plan.sourceCommit);
  assert.equal(stage.version, plan.version);
  await verifyStageArtifacts(options.destination, stage);
  const notes = await readFile(
    join(options.destination, plan.notes.path),
    "utf8",
  );
  assert.equal(
    sha256(notes),
    plan.notes.sha256,
    "release notes differ from the plan",
  );
  const standalone = await verifyStandaloneSet(
    options.destination,
    join(options.destination, "release/standalone"),
  );
  await verifyMacosQualification(
    options.destination,
    join(options.destination, "release/standalone"),
  );
  await verifyLinuxQualification(
    options.destination,
    join(options.destination, "release/standalone"),
  );
  const qualificationMatrix = await verifyQualificationMatrix(
    join(options.destination, "release/standalone"),
  );
  const macChannels = [];
  for (const target of [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ]) {
    for (const channel of ["npm", "homebrew"]) {
      const path = `release/standalone/${channel}-${target}.json`;
      const body = await readFile(join(options.destination, path), "utf8");
      macChannels.push({
        path,
        sha256: sha256(body),
        receipt: JSON.parse(body),
      });
    }
  }
  const linuxDockerEvidence = [];
  for (const name of [
    "linux-docker-build.json",
    "linux-docker-channels.json",
    "npm-linux-x64-node24.json",
  ]) {
    const path = `release/standalone/${name}`;
    const body = await readFile(join(options.destination, path), "utf8");
    linuxDockerEvidence.push({
      path,
      sha256: sha256(body),
      receipt: JSON.parse(body),
    });
  }
  const packages = await Promise.all(
    PACKAGE_IDS.map((id) => packageCandidate(options.destination, id)),
  );
  assertPackageGraph(packages);
  const candidate: PublicationCandidate = {
    version: plan.version,
    sourceTag: plan.sourceTag,
    publicCommit: "",
    stageReceiptSha256: sha256(stageBody),
    repository: "GitDocket/gitdocket",
    registry: "https://registry.npmjs.org/",
    npmVersion: "11.17.0",
    workflowRef: "",
    holdingTag: "staged",
    publicTag: "latest",
    packages,
    standalone,
  };
  const views = await Promise.all(
    packages.map((item) => registry.inspect(item.name, item.version)),
  );
  const registryState = classifyRegistry(candidate, views);
  assert.notEqual(
    registryState.classification,
    "conflicting",
    "registry immutable conflict; reconcile before packet review",
  );
  const diff = publicReviewDiff(
    options.destination,
    stage.public.baselineCommit,
  );
  const payload = {
    publicDiffSha256: sha256(diff),
    schema: 1,
    plan,
    stage,
    stageSha256: sha256(stageBody),
    packages,
    standalone,
    qualificationMatrix,
    macChannels,
    linuxDockerEvidence,
    registry: registryState,
    observedAt: new Date().toISOString(),
    approvalRequired: true,
    externalWrites: false,
    publicHead: capture(["git", "rev-parse", "HEAD"], options.destination),
    publicStatus: capture(
      ["git", "status", "--porcelain", "--untracked-files=all"],
      options.destination,
    ),
  };
  for (const output of [
    options.output,
    `${options.output}.json`,
    `${options.output}.diff`,
  ]) {
    for (const input of [
      options.plan,
      options.stage,
      join(options.destination, plan.notes.path),
    ])
      assert.notEqual(
        resolve(output),
        resolve(input),
        "packet output would overwrite input evidence",
      );
  }
  await saveReceipt(`${options.output}.json`, payload);
  await writeFile(`${options.output}.diff`, diff);
  const lines = [
    `# GitDocket ${plan.version} release review`,
    "",
    `Canonical source: \`${plan.sourceCommit}\`. Public baseline: \`${stage.public.baselineCommit}\`. Public checkout HEAD: \`${payload.publicHead}\` (review its status below; an uncommitted export has no proposed commit yet).`,
    "",
    `Stage receipt SHA-256: \`${sha256(stageBody)}\`. Export SHA-256: \`${stage.public.exportStateSha256}\`.`,
    "",
    "## Review boundary",
    "",
    "Preparation makes no public writes. Review notes, exact exported diff, source identities, tarball/archive hashes, source-bound Mac/npm/Homebrew evidence, and live registry observations. A locally reviewed public commit and receipt-bound annotated tag must be identified before approving their push. The owner separately reviews the protected release environment, Terminal npm login/2FA promotion, tap update and website cutover. Immutable package bytes cannot be rolled back or republished; a failed release may require a new version. Linux public channel installs and website verification remain later checks.",
    "",
    "## Checks",
    "",
    ...stage.checks.map((check) => `- ${check}`),
    "",
    `Full public diff: ${basename(options.output)}.diff; SHA-256 \`${sha256(diff)}\`.`,
    "",
    "## Export changes",
    "",
    ...(["additions", "changes", "deletions"] as const).flatMap((kind) =>
      stage.public[kind].map((path) => `- ${kind}: ${path}`),
    ),
    "",
    "## Package SHA-256",
    "",
    ...stage.tarballs.map(
      (item) => `- ${item.name}@${item.version}: \`${item.sha256}\``,
    ),
    "",
    "## Standalone SHA-256",
    "",
    ...standalone.map((item) => `- ${item.path}: \`${item.sha256}\``),
    "",
    "## Local channel evidence",
    "",
    `Qualification matrix: ${qualificationMatrix}. Deep checks run on Mac and Linux ARM64; x64 and Node 24 run ${qualificationMatrix === "full" ? "deep" : "basic"} checks.`,
    "",
    ...macChannels.map(
      (item) =>
        `- ${item.path}: \`${item.sha256}\`; ${item.receipt.level} checks; host ${item.receipt.qualificationHost.platform}/${item.receipt.qualificationHost.arch}, ${item.receipt.qualificationHost.execution}. Full checked receipt is in the JSON packet.`,
    ),
    "",
    "## Registry observation",
    "",
    `Observed ${payload.observedAt}; immutable set ${registryState.classification}, staged ${registryState.holding}, latest ${registryState.public}. Full observed metadata and source evidence: ${basename(options.output)}.json.`,
    "",
    "## Public checkout status",
    "",
    "```text",
    payload.publicStatus || "clean",
    "```",
    "",
    "## Release notes",
    "",
    notes.trim(),
    "",
  ];
  await writeFile(options.output, lines.join("\n"));
}

export async function preparationCommand(
  command: string,
  args: string[],
  root: string,
): Promise<void> {
  if (command === "workspace") {
    const values = readOptions(args, [
      "directory",
      "ref",
      "public-repository",
      "bun",
      "npm",
    ]);
    console.log(
      JSON.stringify(
        await createWorkspace(root, {
          directory: required(values, "directory"),
          ref: required(values, "ref"),
          publicRepository: required(values, "public-repository"),
          bun: values.bun,
          npm: values.npm,
        }),
        null,
        2,
      ),
    );
  } else if (command === "qualify") {
    const values = readOptions(args, ["config", "output"]);
    const configPath = required(values, "config");
    const outputPath = required(values, "output");
    assert.notEqual(
      resolve(outputPath),
      resolve(configPath),
      "qualification output must preserve config",
    );
    // A copied resume config may be supplied on retry, but never overwrite an original input via a colliding output.
    await qualifyRelease(
      await jsonFile<QualificationConfig>(required(values, "config")),
      required(values, "output"),
      { sourceRoot: root },
    );
  } else if (command === "packet") {
    const values = readOptions(args, [
      "plan",
      "stage",
      "destination",
      "output",
    ]);
    await reviewPacket({
      plan: required(values, "plan"),
      stage: required(values, "stage"),
      destination: required(values, "destination"),
      output: required(values, "output"),
    });
  } else throw new Error(`unknown preparation command ${command}`);
}
