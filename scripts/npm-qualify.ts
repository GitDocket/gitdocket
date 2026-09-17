import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { qualificationHost } from "./macos-qualification";
import { runNpmInstalledSmoke } from "./npm-smoke";
import { RELEASE_PACKAGE_DEFINITIONS } from "./release-contract";
import {
  type StandaloneManifest,
  verifyStandaloneSet,
} from "./standalone-release";

if (import.meta.main) {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  const root = resolve(import.meta.dir, "..");
  await verifyStandaloneSet(root, join(root, "release/standalone"));
  const manifest = (await Bun.file(
    join(
      root,
      "release/standalone",
      `${process.platform}-${process.arch}.json`,
    ),
  ).json()) as StandaloneManifest;
  assert.equal(
    Bun.spawnSync(["node", "-p", "process.arch"]).stdout.toString().trim(),
    process.arch,
    "Node and Bun must exercise the same architecture",
  );
  const dependencies = Object.fromEntries(
    RELEASE_PACKAGE_DEFINITIONS.map((item) => [
      item.name,
      `file:${join(root, "release/tarballs", `gitdocket-${item.id}-${DOCKET_VERSION}.tgz`)}`,
    ]),
  );
  const smoke = await runNpmInstalledSmoke({
    version: DOCKET_VERSION,
    dependencies,
    localTarballs: Object.values(dependencies).map((value) => value.slice(5)),
  });
  const receipt = {
    qualificationHost: qualificationHost(),
    source: manifest.source,
    archiveSha256: manifest.sha256,
    version: DOCKET_VERSION,
    platform: process.platform,
    arch: process.arch,
    node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim(),
    npm: Bun.spawnSync(["npm", "--version"]).stdout.toString().trim(),
    productPath: "Node, Git and npm launchers; no Bun",
    checks: [
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
    ],
    smoke,
  };
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  if (values.output) await Bun.write(values.output, body);
  console.log(body);
}
