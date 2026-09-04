import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";

const ROOT = join(import.meta.dir, "..");
const OUTPUT = join(ROOT, "release", "tarballs");
const PACKAGES = ["core", "web", "cli", "mcp"] as const;

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  files?: string[];
  repository?: { url?: string; directory?: string };
  publishConfig?: { access?: string; registry?: string };
};

function run(command: string[], cwd = ROOT): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

function assertManifest(
  name: (typeof PACKAGES)[number],
  manifest: PackageManifest,
): void {
  const expectedName = `@gitdocket/${name}`;
  if (manifest.name !== expectedName)
    throw new Error(`${name}: expected name ${expectedName}`);
  if (manifest.version !== DOCKET_VERSION) {
    throw new Error(
      `${name}: version ${manifest.version} does not match ${DOCKET_VERSION}`,
    );
  }
  if (manifest.private) throw new Error(`${name}: package is private`);
  if (!manifest.files?.length)
    throw new Error(`${name}: files allowlist is missing`);
  if (
    manifest.repository?.url !==
    "git+https://github.com/GitDocket/gitdocket.git"
  ) {
    throw new Error(
      `${name}: repository URL does not name the public release mirror exactly`,
    );
  }
  if (manifest.repository.directory !== `packages/${name}`) {
    throw new Error(`${name}: repository directory is incorrect`);
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`${name}: publish access is not public`);
  }
  if (manifest.publishConfig.registry !== "https://registry.npmjs.org/") {
    throw new Error(`${name}: publish registry is not npmjs`);
  }
}

function inspectTarball(path: string): void {
  const entries = run(["tar", "-tzf", path]).trim().split("\n").filter(Boolean);
  const forbidden = entries.filter(
    (entry) =>
      /(?:^|\/)(?:node_modules|docket|\.git|release)(?:\/|$)/.test(entry) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry),
  );
  if (forbidden.length) {
    throw new Error(
      `${basename(path)} contains forbidden files:\n${forbidden.join("\n")}`,
    );
  }
  if (!entries.includes("package/package.json")) {
    throw new Error(`${basename(path)} has no package.json`);
  }
}

const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${DOCKET_VERSION}`) {
  throw new Error(`release tag ${tag} does not match v${DOCKET_VERSION}`);
}

await rm(OUTPUT, { recursive: true, force: true });
await mkdir(OUTPUT, { recursive: true });

for (const name of PACKAGES) {
  const directory = join(ROOT, "packages", name);
  const manifest = (await Bun.file(
    join(directory, "package.json"),
  ).json()) as PackageManifest;
  assertManifest(name, manifest);
  const filename = `gitdocket-${name}-${DOCKET_VERSION}.tgz`;
  run(
    [
      "bun",
      "pm",
      "pack",
      "--filename",
      join(OUTPUT, filename),
      "--ignore-scripts",
    ],
    directory,
  );
  inspectTarball(join(OUTPUT, filename));
  console.log(`verified release/${basename(OUTPUT)}/${filename}`);
}
