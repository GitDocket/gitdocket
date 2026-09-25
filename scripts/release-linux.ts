import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { exportPublicSnapshot } from "./export-public";
import { parseReleasePlan } from "./release-contract";
import { capture, jsonFile, saveReceipt } from "./release-operator";
import { compute } from "./release-preparation";
import { sha256 } from "./release-stage";

export async function linuxDocker(options: {
  source: string;
  output: string;
  mode: "build" | "channels";
  plan?: string;
  sourceRoot?: string;
}) {
  const source = resolve(options.source);
  const output = resolve(options.output);
  assert(source !== output, "Linux output must be separate from source");
  assert(["build", "channels"].includes(options.mode));
  if (!(await Bun.file(join(source, ".gitdocket-source.json")).exists())) {
    assert(
      options.plan && options.sourceRoot,
      "new Linux export requires --plan",
    );
    const plan = parseReleasePlan(await jsonFile(options.plan));
    await mkdir(source);
    capture(["git", "init", "-q", source]);
    await exportPublicSnapshot({
      sourceRoot: options.sourceRoot,
      sourceCommit: plan.sourceCommit,
      destination: source,
    });
  }
  const identityBody = await readFile(
    join(source, ".gitdocket-source.json"),
    "utf8",
  );
  const identity = JSON.parse(identityBody);
  if (options.plan)
    assert.equal(
      identity.sourceCommit,
      parseReleasePlan(await jsonFile(options.plan)).sourceCommit,
    );
  for (const [path, hash] of Object.entries(identity.files)) {
    assert(!path.startsWith("/") && !path.split("/").includes(".."));
    assert.equal(
      sha256(await readFile(join(source, path))),
      hash,
      `Linux export drift: ${path}`,
    );
  }
  await mkdir(output, { recursive: true });
  const engine = JSON.parse(
    capture(["docker", "info", "--format", "{{json .}}"]),
  );
  const hardwareArch =
    engine.Architecture === "aarch64" || engine.Architecture === "arm64"
      ? "arm64"
      : engine.Architecture === "x86_64" || engine.Architecture === "amd64"
        ? "x64"
        : engine.Architecture;
  assert(
    ["arm64", "x64"].includes(hardwareArch),
    "unsupported Docker engine architecture",
  );
  const completed: unknown[] = [];
  const receipt = join(output, `linux-docker-${options.mode}.json`);
  const record = (status: string, error?: string) =>
    saveReceipt(receipt, {
      schema: 1,
      command: "linux",
      mode: options.mode,
      status,
      sourceCommit: identity.sourceCommit,
      exportSha256: sha256(identityBody),
      engine: {
        version: engine.ServerVersion,
        architecture: hardwareArch,
        os: engine.OperatingSystem,
      },
      completed,
      error,
      externalWrites: false,
      resume: [
        "bun",
        "run",
        "release",
        "--",
        "linux",
        "--mode",
        options.mode,
        "--source",
        source,
        "--output",
        output,
      ],
    });
  await record("RUNNING");
  try {
    for (const arch of ["arm64", "x64"] as const) {
      const platform = `linux/${arch === "x64" ? "amd64" : "arm64"}`;
      const image = `gitdocket-qualification:${arch}-${sha256(await readFile(join(source, "release/docker/Dockerfile"))).slice(0, 12)}`;
      await compute(
        [
          "docker",
          "build",
          "--platform",
          platform,
          "--tag",
          image,
          join(source, "release/docker"),
        ],
        source,
      );
      const imageId = capture([
        "docker",
        "image",
        "inspect",
        image,
        "--format",
        "{{.Id}}",
      ]);
      const execution =
        arch === hardwareArch ? "docker-native" : "docker-emulated";
      const command = [
        "set -euo pipefail",
        "tar -C /source --exclude=node_modules --exclude=.git --exclude=release/tools --exclude=release/tarballs --exclude=release/standalone -cf - . | tar -C /work -xf -",
        'test "$(bun --version)" = 1.3.14',
        'test "$(npm --version)" = 11.17.0',
        `test "$(bun -p 'process.platform + "-" + process.arch')" = linux-${arch}`,
        "bun install --frozen-lockfile",
        ...(options.mode === "build"
          ? ["bun scripts/standalone-release.ts build --output /output"]
          : [
              "mkdir -p release/standalone",
              "cp -a /artifacts/. release/standalone/",
              "bun scripts/release-pack.ts",
              `bun scripts/npm-qualify.ts --output /output/npm-linux-${arch}.json`,
              ...(arch === "x64"
                ? [
                    "PATH=/opt/node24/bin:$PATH bun scripts/npm-qualify.ts --output /output/npm-linux-x64-node24.json",
                  ]
                : []),
              `bun scripts/homebrew-qualify.ts --source /work --artifacts /work/release/standalone --brew /home/linuxbrew/.linuxbrew/bin/brew --audit --output /output/homebrew-linux-${arch}.json`,
            ]),
      ].join("\n");
      // Only the reviewed export and explicit artifacts are exposed. No host credentials or Docker socket enter the container.
      await compute(
        [
          "docker",
          "run",
          "--rm",
          "--platform",
          platform,
          "--mount",
          `type=bind,source=${source},target=/source,readonly`,
          "--mount",
          `type=bind,source=${output},target=/output`,
          ...(options.mode === "channels"
            ? [
                "--mount",
                `type=bind,source=${output},target=/artifacts,readonly`,
              ]
            : []),
          "--env",
          `GITDOCKET_QUALIFICATION_EXECUTION=${execution}`,
          "--env",
          `GITDOCKET_QUALIFICATION_HARDWARE=${hardwareArch}`,
          imageId,
          "bash",
          "-c",
          command,
        ],
        source,
      );
      const artifactNames =
        options.mode === "build"
          ? [`linux-${arch}.json`]
          : [
              `npm-linux-${arch}.json`,
              `homebrew-linux-${arch}.json`,
              ...(arch === "x64" ? ["npm-linux-x64-node24.json"] : []),
            ];
      const artifactHashes = Object.fromEntries(
        await Promise.all(
          artifactNames.map(async (name) => [
            name,
            sha256(await readFile(join(output, name))),
          ]),
        ),
      );
      completed.push({
        artifacts: artifactHashes,
        target: `linux-${arch}`,
        platform,
        imageId,
        execution,
      });
      await record("RUNNING");
    }
    await record("READY");
  } catch (error) {
    await record("FAILED", String(error));
    throw error;
  }
}

export async function linuxCommand(args: string[], sourceRoot: string) {
  const { values } = parseArgs({
    args,
    options: {
      source: { type: "string" },
      output: { type: "string" },
      plan: { type: "string" },
      mode: { type: "string", default: "build" },
    },
  });
  assert(
    values.source && values.output,
    "linux requires --source DIR --output DIR [--plan FILE] [--mode build|channels]",
  );
  assert(values.mode === "build" || values.mode === "channels");
  await linuxDocker({
    source: values.source,
    output: values.output,
    mode: values.mode,
    plan: values.plan,
    sourceRoot,
  });
}
