import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DOCKET_VERSION } from "../packages/core/src/version";
import {
  buildStandalone,
  type StandaloneTarget,
  standaloneTarget,
} from "./standalone-build";
import { smokeStandalone } from "./standalone-smoke";

export const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hashFile = async (path: string) => digest(await readFile(path));
export interface StandaloneManifest {
  schema: 1;
  version: string;
  target: StandaloneTarget;
  bunVersion: string;
  source: {
    kind: "public-export" | "development";
    commit: string;
    exportSha256: string | null;
  };
  archive: string;
  sha256: string;
  files: Record<string, string>;
  smoke: Awaited<ReturnType<typeof smokeStandalone>>;
}
export interface StandaloneAsset {
  path: string;
  sha256: string;
}
async function releaseConfig(root: string) {
  const config = JSON.parse(
    await readFile(join(root, "release/standalone.json"), "utf8"),
  ) as { schema: number; bunVersion: string; targets: string[] };
  assert.equal(config.schema, 1);
  assert(/^\d+\.\d+\.\d+$/.test(config.bunVersion));
  assert(Array.isArray(config.targets) && config.targets.length > 0);
  assert.equal(new Set(config.targets).size, config.targets.length);
  for (const target of config.targets) standaloneTarget(target);
  return config;
}
export function checked(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(result.exitCode, 0, `${command.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

async function sourceIdentity(
  root: string,
  development: boolean,
): Promise<StandaloneManifest["source"]> {
  if (development)
    return {
      kind: "development",
      commit: checked(["git", "rev-parse", "HEAD"], root),
      exportSha256: null,
    };
  const body = await readFile(join(root, ".gitdocket-source.json"), "utf8");
  const state = JSON.parse(body) as {
    schema: number;
    sourceCommit: string;
    files: Record<string, string>;
  };
  assert.equal(state.schema, 1);
  assert(/^[a-f0-9]{40}$/.test(state.sourceCommit));
  assert(
    state.files["scripts/standalone-release.ts"],
    "release code must belong to the public export",
  );
  for (const [path, hash] of Object.entries(state.files)) {
    assert(!path.startsWith("/") && !path.split("/").includes(".."));
    assert.equal(
      await hashFile(join(root, path)),
      hash,
      `public export drift: ${path}`,
    );
  }
  return {
    kind: "public-export",
    commit: state.sourceCommit,
    exportSha256: digest(body),
  };
}

async function dependencyNotices(root: string): Promise<string> {
  const modules = join(root, "node_modules");
  const paths: string[] = [];
  for (const name of (await readdir(modules)).sort()) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const child of (await readdir(join(modules, name))).sort())
        paths.push(join(modules, name, child));
    } else paths.push(join(modules, name));
  }
  const notices: string[] = [];
  for (const path of paths) {
    const manifestPath = join(path, "package.json");
    if (!(await Bun.file(manifestPath).exists())) continue;
    const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
    if (pkg.name?.startsWith("@gitdocket/")) continue;
    const licenses = (await readdir(path))
      .filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name))
      .sort();
    const texts: string[] = [];
    for (const name of licenses) {
      const file = Bun.file(join(path, name));
      if (await file.exists()) texts.push(await file.text());
    }
    notices.push(
      `${pkg.name}@${pkg.version} (${pkg.license ?? "see upstream"})\n${texts.join("\n")}`,
    );
  }
  return `${await readFile(join(root, "release/licenses/bun-1.3.14.md"), "utf8")}\n\n${notices.join("\n\n---\n\n")}\n`;
}

export async function packageStandalone(
  root: string,
  output: string,
  development = false,
) {
  const config = await releaseConfig(root);
  assert.equal(
    Bun.version,
    config.bunVersion,
    "standalone release requires the pinned Bun compiler",
  );
  const target = standaloneTarget(`${process.platform}-${process.arch}`);
  assert(
    config.targets.includes(target),
    `unqualified native target ${target}`,
  );
  const source = await sourceIdentity(root, development);
  const scratch = await mkdtemp(join(tmpdir(), "gitdocket-native-package-"));
  try {
    const bin = join(scratch, "compile");
    await buildStandalone({ target, output: bin });
    const contents = join(scratch, "contents");
    await mkdir(contents);
    for (const name of ["docket", "docket-mcp"])
      await copyFile(join(bin, name), join(contents, name));
    await copyFile(join(root, "LICENSE"), join(contents, "LICENSE"));
    await writeFile(
      join(contents, "THIRD_PARTY_NOTICES.txt"),
      await dependencyNotices(root),
    );
    await writeFile(
      join(contents, "BUILD.json"),
      `${JSON.stringify({ version: DOCKET_VERSION, target, bunVersion: Bun.version, source }, null, 2)}\n`,
    );
    const names = (await readdir(contents)).sort();
    const files: Record<string, string> = {};
    for (const name of names) {
      files[name] = await hashFile(join(contents, name));
      await chmod(
        join(contents, name),
        name === "docket" || name === "docket-mcp" ? 0o755 : 0o644,
      );
      await utimes(join(contents, name), 0, 0);
    }
    await mkdir(output, { recursive: true });
    const archive = `gitdocket-${DOCKET_VERSION}-${target}.tar.gz`;
    const tar = join(output, archive.slice(0, -3));
    const owner =
      process.platform === "darwin"
        ? ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"]
        : ["--owner=0", "--group=0"];
    checked(
      [
        "tar",
        "--format=ustar",
        "--no-xattrs",
        ...owner,
        "-cf",
        tar,
        "-C",
        contents,
        ...names,
      ],
      root,
    );
    // Use the pinned compiler's compressor: host gzip versions can produce
    // different archive bytes from an identical tar stream.
    await writeFile(
      join(output, archive),
      Bun.gzipSync(await readFile(tar), { level: 9 }),
    );
    await rm(tar);
    // Qualify the archive users receive, not the compiler output directory.
    const extracted = join(scratch, "installed");
    await mkdir(extracted);
    checked(["tar", "-xzf", join(output, archive), "-C", extracted], root);
    const smoke = await smokeStandalone(extracted);
    const manifest: StandaloneManifest = {
      schema: 1,
      version: DOCKET_VERSION,
      target,
      bunVersion: Bun.version,
      source,
      archive,
      sha256: await hashFile(join(output, archive)),
      files,
      smoke,
    };
    await writeFile(
      join(output, `${target}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeFile(
      join(output, `${archive}.sha256`),
      `${manifest.sha256}  ${archive}\n`,
    );
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function verifyStandaloneSet(
  root: string,
  directory: string,
  options: { development?: boolean } = {},
): Promise<StandaloneAsset[]> {
  const config = await releaseConfig(root);
  const expectedSource = await sourceIdentity(
    root,
    options.development ?? false,
  );
  const assets: StandaloneAsset[] = [];
  for (const target of config.targets) {
    standaloneTarget(target);
    const manifestPath = join(directory, `${target}.json`);
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as StandaloneManifest;
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.version, DOCKET_VERSION);
    assert.equal(manifest.target, target);
    assert.equal(manifest.bunVersion, config.bunVersion);
    assert.deepEqual(
      manifest.source,
      expectedSource,
      "standalone source differs from the approved export",
    );
    assert.equal(
      `${manifest.smoke.platform}-${manifest.smoke.arch}`,
      target,
      "native execution evidence is required",
    );
    assert.equal(manifest.smoke.version, DOCKET_VERSION);
    assert.equal(
      manifest.smoke.runtimePath,
      "Git and standalone executables only",
    );
    assert.deepEqual(manifest.smoke.checks, [
      "CLI/MCP versions",
      "dual-agent initialization",
      "task create/ready/index",
      "embedded browser assets",
      "MCP ready tool",
      "source-only watch diagnostic",
      "historical/customized/stale upgrades",
    ]);
    assert.equal(
      manifest.archive,
      `gitdocket-${DOCKET_VERSION}-${target}.tar.gz`,
    );
    assert(/^[a-f0-9]{64}$/.test(manifest.sha256));
    const archivePath = join(directory, manifest.archive);
    assert.equal(
      await hashFile(archivePath),
      manifest.sha256,
      `archive checksum mismatch: ${target}`,
    );
    const entries = checked(["tar", "-tzf", archivePath], root)
      .split("\n")
      .sort();
    assert(
      checked(["tar", "-tvzf", archivePath], root)
        .split("\n")
        .every((line) => line.startsWith("-")),
      "archive entries must be regular files",
    );
    assert.deepEqual(entries, [
      "BUILD.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
      "docket",
      "docket-mcp",
    ]);
    assert.deepEqual(Object.keys(manifest.files).sort(), entries);
    for (const name of entries) {
      const child = Bun.spawnSync(["tar", "-xOf", archivePath, name], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      assert.equal(child.exitCode, 0);
      assert.equal(
        digest(child.stdout),
        manifest.files[name],
        `archive contents differ: ${name}`,
      );
      if (name === "BUILD.json") {
        assert.deepEqual(JSON.parse(child.stdout.toString()), {
          version: manifest.version,
          target: manifest.target,
          bunVersion: manifest.bunVersion,
          source: manifest.source,
        });
      }
    }
    const checksumPath = `${archivePath}.sha256`;
    assert.equal(
      await readFile(checksumPath, "utf8"),
      `${manifest.sha256}  ${manifest.archive}\n`,
    );
    for (const path of [archivePath, manifestPath, checksumPath])
      assets.push({
        path: `release/standalone/${basename(path)}`,
        sha256: await hashFile(path),
      });
  }
  return assets;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string" },
      development: { type: "boolean", default: false },
    },
  });
  const root = resolve(import.meta.dir, "..");
  const output = resolve(values.output ?? join(root, "release/standalone"));
  if (positionals[0] === "build")
    console.log(
      JSON.stringify(
        await packageStandalone(root, output, values.development),
        null,
        2,
      ),
    );
  else if (positionals[0] === "verify")
    console.log(
      JSON.stringify(
        await verifyStandaloneSet(root, output, {
          development: values.development,
        }),
        null,
        2,
      ),
    );
  else
    throw new Error(
      "Usage: bun scripts/standalone-release.ts <build|verify> [--output DIR] [--development]",
    );
}
