import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type StandaloneManifest,
  verifyStandaloneSet,
} from "./standalone-release";

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
    hardwareArch: armHardware ? "arm64" : process.arch,
    execution: translated ? "rosetta" : "native",
  };
}

type ChannelReceipt = {
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
export function validateMacosReceipts(
  native: StandaloneManifest,
  npm: NpmReceipt,
  brew: HomebrewReceipt,
) {
  assert(/^darwin-(arm64|x64)$/.test(native.target));
  const arch = native.target.slice("darwin-".length);
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
    assert.equal(host.platform, "darwin");
    assert.equal(
      host.arch,
      arch,
      "macOS receipt execution architecture differs",
    );
    assert(/^(arm64|x64)$/.test(host.hardwareArch));
    assert(host.osRelease && /^\d+\.\d+/.test(host.osVersion));
    assert.equal(
      host.execution,
      arch === "x64" && host.hardwareArch === "arm64" ? "rosetta" : "native",
      "macOS translation assistance must be disclosed",
    );
  }
  assert.equal(npm.platform, "darwin");
  assert.equal(npm.arch, arch);
  assert(/^v22\./.test(npm.node), "macOS qualification requires Node 22");
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
    "historical/customized/stale upgrades",
    "npm update",
    "npm uninstall preserves project",
    "migration from published Bun-dependent 0.3.1",
  ])
    assert(npm.checks.includes(check), `missing macOS npm check: ${check}`);
  assert.equal(brew.target, native.target);
  assert(/^[a-f0-9]{64}$/.test(brew.formulaSha256));
  assert.deepEqual(
    brew.smoke,
    native.smoke,
    "Homebrew must exercise the installed standalone product",
  );
  for (const check of [
    "formula install and both executable hashes",
    "formula functional test",
    "reinstall",
    "revision upgrade",
    "failed checksum preserves accepted keg",
    "failed download preserves accepted keg",
    "published npm 0.3.1 precedence",
    "preserved custom MCP path and explicit migration",
    "MCP actual tool through stable Homebrew opt path",
    "uninstall preserves project and competing npm installation",
  ])
    assert(
      brew.checks.includes(check),
      `missing macOS Homebrew check: ${check}`,
    );
}

export async function verifyMacosQualification(
  root: string,
  artifacts: string,
) {
  await verifyStandaloneSet(root, artifacts);
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const read = async (name: string) =>
      JSON.parse(await readFile(join(artifacts, `${name}.json`), "utf8"));
    validateMacosReceipts(
      await read(target),
      await read(`npm-${target}`),
      await read(`homebrew-${target}`),
    );
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { artifacts: { type: "string", default: "release/standalone" } },
  });
  await verifyMacosQualification(
    resolve(import.meta.dir, ".."),
    resolve(values.artifacts ?? "release/standalone"),
  );
  console.log(
    "Verified source-bound macOS ARM64 and Intel channel qualification",
  );
}
