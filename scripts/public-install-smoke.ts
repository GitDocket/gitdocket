import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { qualificationHost } from "./macos-qualification";
import { runNpmInstalledSmoke } from "./npm-smoke";
import { RELEASE_PACKAGE_DEFINITIONS } from "./release-contract";
import { digest, type StandaloneManifest } from "./standalone-release";
import { smokeStandalone } from "./standalone-smoke";

// This runs after authorized publication, on a fresh disposable machine.
// No local artifact mirror or registry substitute is accepted here.
export async function verifyPublicInstallation(root: string) {
  const stateBody = await readFile(
    join(root, ".gitdocket-source.json"),
    "utf8",
  );
  const state = JSON.parse(stateBody);
  const target = `${process.platform}-${process.arch}`;
  assert.equal(
    Bun.spawnSync(["node", "-p", "process.arch"]).stdout.toString().trim(),
    process.arch,
    "Node and Bun must exercise the same architecture",
  );
  const url = `https://github.com/GitDocket/gitdocket/releases/download/v${DOCKET_VERSION}/${target}.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  assert(
    response.ok,
    `public native receipt unavailable: ${response.status} ${url}`,
  );
  const manifest = (await response.json()) as StandaloneManifest;
  assert.equal(manifest.version, DOCKET_VERSION);
  assert.equal(manifest.target, target);
  assert.deepEqual(manifest.source, {
    kind: "public-export",
    commit: state.sourceCommit,
    exportSha256: digest(stateBody),
  });
  const brew = Bun.which("brew");
  assert(brew, "Homebrew must be installed on the disposable runner");
  async function command(args: string[]) {
    const child = Bun.spawn(args, {
      cwd: root,
      env: {
        ...process.env,
        HOMEBREW_NO_AUTO_UPDATE: "1",
        HOMEBREW_NO_ANALYTICS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 600_000,
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, `${args.join(" ")}\n${out}\n${err}`);
    return out.trim();
  }
  const prefix = await command([brew, "--prefix"]);
  for (const name of ["docket", "docket-mcp"])
    assert(
      !(await Bun.file(join(prefix, "bin", name)).exists()),
      `refusing a preinstalled ${name}`,
    );
  const tapsBefore = (await command([brew, "tap"])).split("\n");
  assert(!tapsBefore.includes("gitdocket/tap"), "refusing a pre-added tap");
  const trustBefore = await command([brew, "trust", "--json=v1"]);
  assert(
    !trustBefore.includes("gitdocket/tap"),
    "refusing pre-existing GitDocket trust",
  );
  await command([brew, "install", "gitdocket/tap/gitdocket"]);
  const installed = await command([
    brew,
    "--prefix",
    "gitdocket/tap/gitdocket",
  ]);
  const bin = join(installed, "bin");
  for (const name of ["docket", "docket-mcp"])
    assert.equal(
      digest(await readFile(join(bin, name))),
      manifest.files[name],
      `public ${name} differs from its release receipt`,
    );
  const homebrew = await smokeStandalone(bin, { level: "basic" });
  const npm = await runNpmInstalledSmoke({
    level: "basic",
    version: DOCKET_VERSION,
    dependencies: Object.fromEntries(
      RELEASE_PACKAGE_DEFINITIONS.map((pkg) => [pkg.name, DOCKET_VERSION]),
    ),
  });
  return {
    schema: 1,
    status: "READY",
    level: "basic",
    version: DOCKET_VERSION,
    target,
    source: manifest.source,
    qualificationHost: qualificationHost(),
    homebrewPrefix: prefix,
    nativeReceiptUrl: url,
    archiveSha256: manifest.sha256,
    tapsBefore,
    trustBefore: JSON.parse(trustBefore),
    homebrew,
    npm,
    acquisition:
      "Actual public Homebrew tap, GitHub Release and npm registry; no local mirror",
    assistance:
      "Ephemeral runner or clean isolated local prefix; host details record any Rosetta assistance. Bun/Node/npm run verification harnesses. Homebrew product smoke contains only copied binaries and Git on PATH; npm product smoke additionally includes Node.",
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  const result = await verifyPublicInstallation(resolve(import.meta.dir, ".."));
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) await writeFile(values.output, body);
  console.log(body);
}
