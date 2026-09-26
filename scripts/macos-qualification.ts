import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  digest,
  type StandaloneManifest,
  verifyStandaloneSet,
} from "./standalone-release";
import type { CheckLevel } from "./standalone-smoke";

export function qualificationHost() {
  let armHardware = process.arch === "arm64";
  let translated = false;
  if (process.platform === "darwin") {
    const translation = Bun.spawnSync([
      "/usr/sbin/sysctl",
      "-in",
      "sysctl.proc_translated",
    ]);
    assert(
      [0, 1].includes(translation.exitCode),
      "cannot inspect Rosetta execution",
    );
    translated = translation.stdout.toString().trim() === "1";
    const hardware = Bun.spawnSync([
      "/usr/sbin/sysctl",
      "-n",
      "hw.optional.arm64",
    ]);
    assert.equal(
      hardware.exitCode,
      0,
      "cannot inspect Mac hardware architecture",
    );
    armHardware = translated || hardware.stdout.toString().trim() === "1";
    if (translated) assert.equal(process.arch, "x64");
  }
  const dockerExecution = process.env.GITDOCKET_QUALIFICATION_EXECUTION;
  const dockerHardware = process.env.GITDOCKET_QUALIFICATION_HARDWARE;
  if (dockerExecution) {
    assert.equal(process.platform, "linux");
    assert(["arm64", "x64"].includes(dockerHardware ?? ""));
    assert.equal(
      dockerExecution,
      process.arch === dockerHardware ? "docker-native" : "docker-emulated",
    );
  }
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    osVersion:
      process.platform === "darwin"
        ? Bun.spawnSync(["/usr/bin/sw_vers", "-productVersion"])
            .stdout.toString()
            .trim()
        : release(),
    ...(process.platform === "linux"
      ? {
          distribution:
            readFileSync("/etc/os-release", "utf8").match(
              /^PRETTY_NAME="(.*)"$/m,
            )?.[1] ?? "unknown",
        }
      : {}),
    hardwareArch: dockerHardware ?? (armHardware ? "arm64" : process.arch),
    execution: dockerExecution ?? (translated ? "rosetta" : "native"),
  };
}

type ChannelReceipt = {
  status: "READY";
  level: CheckLevel;
  version: string;
  source: StandaloneManifest["source"];
  archiveSha256: string;
  qualificationHost: ReturnType<typeof qualificationHost>;
  checks: string[];
};
type NpmReceipt = ChannelReceipt & {
  platform: string;
  arch: string;
  node: string;
  npm: string;
  productPath: string;
  smoke: {
    level: CheckLevel;
    packageVersions: Record<string, string>;
    mcpTools: string[];
    serveStatus: number;
  };
};
type HomebrewReceipt = ChannelReceipt & {
  target: string;
  formulaSha256: string;
  smoke: StandaloneManifest["smoke"];
};

// The receipts supplement archive/source verification; they never replace it.
export function validateChannelReceipts(
  native: StandaloneManifest,
  npm: NpmReceipt,
  brew: HomebrewReceipt,
  nodeMajor = 22,
  expectedLevel?: CheckLevel,
) {
  assert(/^(darwin|linux)-(arm64|x64)$/.test(native.target));
  assert.equal(native.status, "READY", "native qualification is not ready");
  const [platform, arch] = native.target.split("-");
  const level = expectedLevel ?? (arch === "arm64" ? "deep" : npm.level);
  assert(["basic", "deep"].includes(level), "invalid channel check level");
  assert.equal(npm.level, level, "npm check level differs");
  assert.equal(brew.level, level, "Homebrew check level differs");
  assert.equal(npm.status, "READY", "npm qualification is not ready");
  assert.equal(brew.status, "READY", "Homebrew qualification is not ready");
  assert.equal(npm.smoke.level, level, "npm smoke level differs");
  assert.equal(brew.smoke.level, level, "Homebrew smoke level differs");
  assert.equal(native.smoke.level, level, "native smoke level differs");
  for (const receipt of [npm, brew]) {
    assert.equal(
      receipt.version,
      native.version,
      "macOS receipt version differs",
    );
    assert.deepEqual(
      receipt.source,
      native.source,
      "macOS receipt source differs",
    );
    assert.equal(
      receipt.archiveSha256,
      native.sha256,
      "macOS receipt archive differs",
    );
    const host = receipt.qualificationHost;
    assert(host, "macOS receipt must disclose its execution host");
    assert.equal(host.platform, platform);
    if (platform === "linux")
      assert(
        host.distribution?.startsWith("Ubuntu 24.04"),
        "Linux qualification requires Ubuntu 24.04",
      );
    assert.equal(
      host.arch,
      arch,
      "macOS receipt execution architecture differs",
    );
    assert(/^(arm64|x64)$/.test(host.hardwareArch));
    assert(host.osRelease && /^\d+\.\d+/.test(host.osVersion));
    assert.equal(
      host.execution,
      platform === "linux"
        ? arch === host.hardwareArch
          ? "docker-native"
          : "docker-emulated"
        : arch === "x64" && host.hardwareArch === "arm64"
          ? "rosetta"
          : "native",
      "macOS translation assistance must be disclosed",
    );
  }
  assert.equal(npm.platform, platform);
  assert.equal(npm.arch, arch);
  assert(
    npm.node.startsWith(`v${nodeMajor}.`),
    `qualification requires Node ${nodeMajor}`,
  );
  assert.equal(npm.npm, "11.17.0");
  assert.equal(npm.productPath, "Node, Git and npm launchers; no Bun");
  assert.equal(npm.smoke.serveStatus, 200);
  assert(npm.smoke.mcpTools.includes("ready"));
  for (const name of [
    "@gitdocket/cli",
    "@gitdocket/mcp",
    `@gitdocket/bin-${native.target}`,
  ])
    assert.equal(npm.smoke.packageVersions[name], native.version);
  for (const check of [
    "npm global install",
    "npx acquisition",
    "CLI/MCP versions",
    "initialization/task/index",
    "embedded Serve resources",
    "MCP ready call",
    ...(level === "deep"
      ? [
          "historical/customized/stale upgrades",
          "npm update",
          "npm uninstall preserves project",
          "migration from published Bun-dependent 0.3.1",
        ]
      : []),
  ])
    assert(npm.checks.includes(check), `missing macOS npm check: ${check}`);
  assert.equal(brew.target, native.target);
  assert(/^[a-f0-9]{64}$/.test(brew.formulaSha256));
  if (level === "deep")
    assert.deepEqual(
      brew.smoke,
      native.smoke,
      "Homebrew must exercise the installed standalone product",
    );
  else {
    assert.equal(brew.smoke.version, native.version);
    assert.equal(brew.smoke.platform, platform);
    assert.equal(brew.smoke.arch, arch);
    for (const check of [
      "CLI/MCP versions",
      "dual-agent initialization",
      "task create/ready/index",
      "embedded browser assets",
      "MCP ready tool",
    ])
      assert(
        brew.smoke.checks.includes(check),
        `missing basic Homebrew smoke: ${check}`,
      );
  }
  for (const check of [
    "formula install and both executable hashes",
    "formula functional test",
    ...(level === "deep"
      ? [
          "reinstall",
          "revision upgrade",
          "failed checksum preserves accepted keg",
          "failed download preserves accepted keg",
          "published npm 0.3.1 precedence",
          "preserved custom MCP path and explicit migration",
          "MCP actual tool through stable Homebrew opt path",
          "uninstall preserves project and competing npm installation",
        ]
      : []),
  ])
    assert(
      brew.checks.includes(check),
      `missing macOS Homebrew check: ${check}`,
    );
}

export function validateMacosReceipts(
  native: StandaloneManifest,
  npm: NpmReceipt,
  brew: HomebrewReceipt,
  expectedLevel?: CheckLevel,
) {
  assert(native.target.startsWith("darwin-"));
  validateChannelReceipts(native, npm, brew, 22, expectedLevel);
}

export function validateDockerReceipt(
  receipt: {
    schema: number;
    mode: string;
    status: string;
    sourceCommit: string;
    exportSha256: string;
    engine: { architecture: string; version: string; os: string };
    completed: {
      target: string;
      platform: string;
      execution: string;
      imageId: string;
      artifacts: Record<string, string>;
    }[];
  },
  mode: string,
  source: StandaloneManifest["source"],
) {
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.mode, mode);
  assert.equal(receipt.status, "READY", "Docker qualification is not complete");
  assert.equal(receipt.sourceCommit, source.commit);
  assert.equal(receipt.exportSha256, source.exportSha256);
  assert(["arm64", "x64"].includes(receipt.engine.architecture));
  assert(receipt.engine.version && receipt.engine.os);
  assert.deepEqual(receipt.completed.map((item) => item.target).sort(), [
    "linux-arm64",
    "linux-x64",
  ]);
  for (const item of receipt.completed) {
    const arch = item.target.slice(6);
    assert.equal(item.platform, `linux/${arch === "x64" ? "amd64" : "arm64"}`);
    assert.equal(
      item.execution,
      arch === receipt.engine.architecture
        ? "docker-native"
        : "docker-emulated",
    );
    assert(/^sha256:[a-f0-9]{64}$/.test(item.imageId));
    const names =
      mode === "build"
        ? [`${item.target}.json`]
        : [
            `npm-${item.target}.json`,
            `homebrew-${item.target}.json`,
            ...(arch === "x64" ? ["npm-linux-x64-node24.json"] : []),
          ];
    assert.deepEqual(Object.keys(item.artifacts).sort(), names.sort());
    for (const hash of Object.values(item.artifacts))
      assert(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
  }
}

export async function verifyLinuxQualification(
  root: string,
  artifacts: string,
  fullMatrix = false,
) {
  await verifyStandaloneSet(root, artifacts);
  const native = JSON.parse(
    await readFile(join(artifacts, "linux-arm64.json"), "utf8"),
  );
  for (const mode of ["build", "channels"]) {
    const receipt = JSON.parse(
      await readFile(join(artifacts, `linux-docker-${mode}.json`), "utf8"),
    );
    validateDockerReceipt(receipt, mode, native.source);
    for (const target of receipt.completed)
      for (const [path, hash] of Object.entries(target.artifacts)) {
        assert.equal(
          digest(await readFile(join(artifacts, path))),
          hash,
          `Docker receipt artifact differs: ${path}`,
        );
      }
  }
  for (const target of ["linux-arm64", "linux-x64"]) {
    const read = async (name: string) =>
      JSON.parse(await readFile(join(artifacts, `${name}.json`), "utf8"));
    const native = await read(target);
    const brew = await read(`homebrew-${target}`);
    validateChannelReceipts(
      native,
      await read(`npm-${target}`),
      brew,
      22,
      fullMatrix ? "deep" : undefined,
    );
    if (target === "linux-x64")
      validateChannelReceipts(
        native,
        await read(`npm-${target}-node24`),
        brew,
        24,
        fullMatrix ? "deep" : undefined,
      );
  }
}

export async function verifyMacosQualification(
  root: string,
  artifacts: string,
  fullMatrix = false,
) {
  await verifyStandaloneSet(root, artifacts);
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const read = async (name: string) =>
      JSON.parse(await readFile(join(artifacts, `${name}.json`), "utf8"));
    validateMacosReceipts(
      await read(target),
      await read(`npm-${target}`),
      await read(`homebrew-${target}`),
      fullMatrix ? "deep" : undefined,
    );
  }
}

export async function verifyQualificationMatrix(
  artifacts: string,
  fullMatrix?: boolean,
) {
  const readLevel = async (name: string): Promise<CheckLevel> => {
    const receipt = JSON.parse(
      await readFile(join(artifacts, `${name}.json`), "utf8"),
    );
    assert(
      ["basic", "deep"].includes(receipt.level),
      `invalid check level: ${name}`,
    );
    return receipt.level;
  };
  const x64 = await readLevel("npm-darwin-x64");
  const expected =
    fullMatrix === undefined ? x64 : fullMatrix ? "deep" : "basic";
  assert.equal(x64, expected, "Mac x64 check level differs from matrix");
  for (const name of [
    "homebrew-darwin-x64",
    "npm-linux-x64",
    "homebrew-linux-x64",
    "npm-linux-x64-node24",
  ])
    assert.equal(
      await readLevel(name),
      expected,
      `${name} check level differs from matrix`,
    );
  for (const name of [
    "npm-darwin-arm64",
    "homebrew-darwin-arm64",
    "npm-linux-arm64",
    "homebrew-linux-arm64",
  ])
    assert.equal(await readLevel(name), "deep", `${name} must be deep`);
  return expected === "deep" ? "full" : "lean";
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      artifacts: { type: "string", default: "release/standalone" },
      linux: { type: "boolean" },
    },
  });
  await verifyMacosQualification(
    resolve(import.meta.dir, ".."),
    resolve(values.artifacts ?? "release/standalone"),
  );
  if (values.linux)
    await verifyLinuxQualification(
      resolve(import.meta.dir, ".."),
      resolve(values.artifacts ?? "release/standalone"),
    );
  if (values.linux)
    await verifyQualificationMatrix(
      resolve(values.artifacts ?? "release/standalone"),
    );
  console.log(
    "Verified source-bound macOS ARM64 and Intel channel qualification",
  );
}
