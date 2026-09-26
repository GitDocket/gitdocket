import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";
import {
  checked,
  dependencyNotices,
  digest,
  type StandaloneManifest,
  verifyStandaloneSet,
} from "./standalone-release";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(arch: "arm64" | "x64" = "arm64") {
  const target = `darwin-${arch}` as const;
  const root = await mkdtemp(join(tmpdir(), "standalone-release-test-"));
  roots.push(root);
  const output = join(root, "release/standalone");
  const contents = join(root, "contents");
  await mkdir(output, { recursive: true });
  await mkdir(contents);
  checked(["git", "init", "-q"], root);
  checked(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    root,
  );
  await writeFile(
    join(root, "release/standalone.json"),
    JSON.stringify({
      schema: 1,
      bunVersion: "1.3.14",
      targets: [target],
    }),
  );
  const source = {
    kind: "development" as const,
    commit: checked(["git", "rev-parse", "HEAD"], root),
    exportSha256: null,
  };
  const build = {
    version: DOCKET_VERSION,
    target,
    bunVersion: "1.3.14",
    source,
  };
  const files: Record<string, string> = {};
  for (const [name, body] of Object.entries({
    "BUILD.json": JSON.stringify(build),
    LICENSE: "fixture license",
    "THIRD_PARTY_NOTICES.txt": "fixture notices",
    docket: "fixture cli",
    "docket-mcp": "fixture mcp",
  })) {
    await writeFile(join(contents, name), body);
    files[name] = digest(body);
  }
  const archive = `gitdocket-${DOCKET_VERSION}-${target}.tar.gz`;
  checked(
    [
      "tar",
      "-czf",
      join(output, archive),
      "-C",
      contents,
      ...Object.keys(files),
    ],
    root,
  );
  const sha256 = digest(await readFile(join(output, archive)));
  const manifest: StandaloneManifest = {
    schema: 1,
    status: "READY",
    ...build,
    archive,
    sha256,
    files,
    smoke: {
      level: "deep",
      version: DOCKET_VERSION,
      platform: "darwin",
      arch,
      runtimePath: "Git and standalone executables only",
      checks: [
        "CLI/MCP versions",
        "dual-agent initialization",
        "task create/ready/index",
        "embedded browser assets",
        "MCP ready tool",
        "source-only watch diagnostic",
        "historical/customized/stale upgrades",
      ],
    },
  };
  const save = () =>
    writeFile(join(output, `${target}.json`), JSON.stringify(manifest));
  await save();
  await writeFile(join(output, `${archive}.sha256`), `${sha256}  ${archive}\n`);
  return { root, output, manifest, save };
}

test("release verification checks archive bytes and rejects development evidence for publication", async () => {
  const f = await fixture();
  expect(
    await verifyStandaloneSet(f.root, f.output, { development: true }),
  ).toHaveLength(3);
  await expect(verifyStandaloneSet(f.root, f.output)).rejects.toThrow();
  await writeFile(join(f.output, f.manifest.archive), "corrupted download");
  await expect(
    verifyStandaloneSet(f.root, f.output, { development: true }),
  ).rejects.toThrow("checksum mismatch");
});

test("a compile-only or incomplete smoke cannot qualify a native platform", async () => {
  const f = await fixture();
  f.manifest.smoke.arch = "x64";
  await f.save();
  await expect(
    verifyStandaloneSet(f.root, f.output, { development: true }),
  ).rejects.toThrow("native execution");
  f.manifest.smoke.arch = "arm64";
  f.manifest.smoke.checks.pop();
  await f.save();
  await expect(
    verifyStandaloneSet(f.root, f.output, { development: true }),
  ).rejects.toThrow();
});

test("x64 native archive accepts basic installed smoke but not missing behavior", async () => {
  const f = await fixture("x64");
  f.manifest.smoke.level = "basic";
  f.manifest.smoke.checks = f.manifest.smoke.checks.slice(0, 5);
  await f.save();
  expect(
    await verifyStandaloneSet(f.root, f.output, { development: true }),
  ).toHaveLength(3);
  f.manifest.smoke.checks.pop();
  await f.save();
  await expect(
    verifyStandaloneSet(f.root, f.output, { development: true }),
  ).rejects.toThrow();
});

test("release verification rejects source/version drift and absent platforms", async () => {
  const f = await fixture();
  f.manifest.version = "0.0.0";
  await f.save();
  await expect(
    verifyStandaloneSet(f.root, f.output, { development: true }),
  ).rejects.toThrow();
  f.manifest.version = DOCKET_VERSION;
  f.manifest.source.commit = "f".repeat(40);
  await f.save();
  await expect(
    verifyStandaloneSet(f.root, f.output, { development: true }),
  ).rejects.toThrow("source differs");
  await rm(join(f.output, "darwin-arm64.json"));
  await expect(
    verifyStandaloneSet(f.root, f.output, { development: true }),
  ).rejects.toThrow();
});

test("license notices follow workspace and isolated dependencies without stale store versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "standalone-notices-"));
  roots.push(root);
  await mkdir(join(root, "release/licenses"), { recursive: true });
  await writeFile(join(root, "release/licenses/bun-1.3.14.md"), "Bun notice");
  const workspace = join(root, "packages/web/node_modules");
  await mkdir(workspace, { recursive: true });
  const store = join(root, "node_modules/.bun");
  const packageDir = async (name: string, version: string) => {
    const path = join(
      store,
      `${name.replace("/", "+")}@${version}`,
      "node_modules",
      name,
    );
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ name, version, license: "MIT" }),
    );
    await writeFile(join(path, "LICENSE"), `${name} ${version} notice`);
    return path;
  };
  const renderer = await packageDir("renderer", "1");
  const helper = await packageDir("@diagram/helper", "2");
  await packageDir("renderer", "stale");
  await symlink(renderer, join(workspace, "renderer"));
  const peers = join(renderer, "../@diagram");
  await mkdir(peers);
  await symlink(helper, join(peers, "helper"));
  await symlink(renderer, join(helper, "../../renderer"));
  const notices = await dependencyNotices(root);
  expect(notices).toContain("renderer 1 notice");
  expect(notices).toContain("@diagram/helper 2 notice");
  expect(notices.match(/renderer@1/g)).toHaveLength(1);
  expect(notices).not.toContain("stale");
});
