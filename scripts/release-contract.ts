import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const RELEASE_SCHEMA = 1 as const;
export const PUBLIC_REPOSITORY = "GitDocket/gitdocket";
export const HOLDING_TAG = "staged";
export const RELEASE_PLAN_DIR = "release/candidates";

export const RELEASE_PACKAGE_DEFINITIONS = [
  {
    id: "core",
    name: "@gitdocket/core",
    manifest: "packages/core/package.json",
    dependencies: [],
  },
  {
    id: "web",
    name: "@gitdocket/web",
    manifest: "packages/web/package.json",
    dependencies: ["@gitdocket/core"],
  },
  {
    id: "cli",
    name: "@gitdocket/cli",
    manifest: "packages/cli/package.json",
    dependencies: ["@gitdocket/core", "@gitdocket/web"],
  },
  {
    id: "mcp",
    name: "@gitdocket/mcp",
    manifest: "packages/mcp/package.json",
    dependencies: ["@gitdocket/core"],
  },
] as const;

export const PRIVATE_RELEASE_CHECKS = [
  "bun install --frozen-lockfile",
  "bunx biome ci .",
  "bunx tsc --noEmit",
  "bun test",
  "bun run docket lint",
  "bun run docket index --check",
  "bun run audit:dependencies",
  "bun run release:pack",
] as const;

const REQUIRED_PUBLIC_PATHS = [
  "release/public-export.json",
  "scripts/release-contract.test.ts",
  "scripts/release-contract.ts",
  "scripts/release-pack.ts",
  "scripts/release-publish.ts",
  "scripts/release-publication.test.ts",
  "scripts/release-publication.ts",
  "scripts/release-rehearse.test.ts",
  "scripts/release-rehearse.ts",
  "scripts/release-stage.test.ts",
  "scripts/release-stage.ts",
  "scripts/release.ts",
] as const;

const VERSION_SURFACES = ["README.md", "docs/getting-started.md"] as const;
const VERSION_SOURCE = "packages/core/src/version.ts";
const SHIPPED_HISTORY = "packages/core/src/shipped-history.json";
const EXPORT_MANIFEST = "release/public-export.json";

export interface ReleaseIntent {
  version: string;
  channel: string;
  notesPath: string;
}

export interface ReleasePackagePlan {
  id: string;
  name: string;
  version: string;
  manifest: string;
  dependencies: string[];
  tarball: string;
}

export interface ReleasePlan {
  schema: typeof RELEASE_SCHEMA;
  version: string;
  channel: string;
  holdingTag: typeof HOLDING_TAG;
  sourceCommit: string;
  sourceTag: string;
  publicRepository: typeof PUBLIC_REPOSITORY;
  notes: { path: string; sha256: string };
  exportManifest: { path: typeof EXPORT_MANIFEST; sha256: string };
  packages: ReleasePackagePlan[];
  checks: string[];
  approval: {
    required: true;
    boundary: "public-commit-tag-registry-and-github-release";
  };
}

export interface ReleaseSnapshot {
  sourceCommit: string;
  dirtyPaths: string[];
  existingTag: boolean;
  engineVersion: string;
  packageVersions: Record<string, string>;
  packageDependencies: Record<string, string[]>;
  shippedVersion: string;
  notesPath: string;
  notesTracked: boolean;
  notesBody: string;
  notesSha256: string;
  exportPaths: string[];
  exportManifestSha256: string;
  versionSurfaces: Record<string, string>;
  lockBody: string;
}

export type GitReader = (...args: string[]) => Promise<string>;

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIST_TAG = /^[a-z][a-z0-9-]{0,31}$/;

export function validateReleaseIntent(intent: ReleaseIntent): string[] {
  const issues: string[] = [];
  if (!SEMVER.test(intent.version) || !STABLE_SEMVER.test(intent.version)) {
    issues.push(
      `version ${JSON.stringify(intent.version)} is not a supported stable SemVer`,
    );
  }
  if (!DIST_TAG.test(intent.channel) || intent.channel === HOLDING_TAG) {
    issues.push(
      `channel ${JSON.stringify(intent.channel)} must be a lowercase npm dist-tag other than ${HOLDING_TAG}`,
    );
  }
  if (
    !intent.notesPath.startsWith("docs/releases/") ||
    intent.notesPath.includes("..") ||
    isAbsolute(intent.notesPath)
  ) {
    issues.push("release notes must be a relative path under docs/releases/");
  }
  return issues;
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease?: string[] } => {
    const [core, prerelease] = value.split("-", 2);
    return {
      core: (core ?? "").split(".").map(Number),
      prerelease: prerelease?.split("."),
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return Math.sign(leftNumber - rightNumber);
    }
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export async function runGit(root: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd: ["git", "-C", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return stdout.trim();
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function parseEngineVersion(source: string): string {
  const match = source.match(/DOCKET_VERSION\s*=\s*"([^"]+)"/);
  if (!match?.[1]) throw new Error(`${VERSION_SOURCE} has no DOCKET_VERSION`);
  return match[1];
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function collectReleaseSnapshot(
  root: string,
  intent: ReleaseIntent,
  git: GitReader = (...args) => runGit(root, ...args),
): Promise<ReleaseSnapshot> {
  const intentIssues = validateReleaseIntent(intent);
  if (intentIssues.length > 0) throw new Error(intentIssues.join("\n"));

  const sourceCommit = await git("rev-parse", "HEAD");
  const dirtyPaths = lines(
    await git("status", "--porcelain", "--untracked-files=all"),
  );
  const existingTag =
    (await git("tag", "--list", `v${intent.version}`)) === `v${intent.version}`;
  const engineVersion = parseEngineVersion(
    await readFile(join(root, VERSION_SOURCE), "utf8"),
  );

  const packageVersions: Record<string, string> = {};
  const packageDependencies: Record<string, string[]> = {};
  for (const definition of RELEASE_PACKAGE_DEFINITIONS) {
    const manifest = JSON.parse(
      await readFile(join(root, definition.manifest), "utf8"),
    ) as PackageManifest;
    packageVersions[definition.name] = manifest.version ?? "";
    packageDependencies[definition.name] = Object.keys(
      manifest.dependencies ?? {},
    ).filter((name) => name.startsWith("@gitdocket/"));
  }

  const shipped = JSON.parse(
    await readFile(join(root, SHIPPED_HISTORY), "utf8"),
  ) as Array<{ version?: string }>;
  let notesBody = "";
  try {
    notesBody = await readFile(join(root, intent.notesPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let notesTracked = true;
  try {
    await git("ls-files", "--error-unmatch", "--", intent.notesPath);
  } catch {
    notesTracked = false;
  }
  const exportManifestBody = await readFile(
    join(root, EXPORT_MANIFEST),
    "utf8",
  );
  const exportManifest = JSON.parse(exportManifestBody) as {
    schema?: number;
    paths?: string[];
  };
  if (exportManifest.schema !== 1 || !Array.isArray(exportManifest.paths)) {
    throw new Error(`${EXPORT_MANIFEST} is not a schema-1 export manifest`);
  }

  const versionSurfaces: Record<string, string> = {};
  for (const path of VERSION_SURFACES) {
    versionSurfaces[path] = await readFile(join(root, path), "utf8");
  }

  return {
    sourceCommit,
    dirtyPaths,
    existingTag,
    engineVersion,
    packageVersions,
    packageDependencies,
    shippedVersion: shipped[0]?.version ?? "",
    notesPath: intent.notesPath,
    notesTracked,
    notesBody,
    notesSha256: sha256(notesBody),
    exportPaths: exportManifest.paths,
    exportManifestSha256: sha256(exportManifestBody),
    versionSurfaces,
    lockBody: await readFile(join(root, "bun.lock"), "utf8"),
  };
}

export function validateReleaseSnapshot(
  snapshot: ReleaseSnapshot,
  intent: ReleaseIntent,
): string[] {
  const issues = validateReleaseIntent(intent);
  if (!/^[0-9a-f]{40}$/.test(snapshot.sourceCommit)) {
    issues.push(
      "candidate source must resolve to one exact 40-character commit",
    );
  }
  if (snapshot.dirtyPaths.length > 0) {
    issues.push(
      `canonical checkout is not clean: ${snapshot.dirtyPaths.join(", ")}`,
    );
  }
  if (snapshot.existingTag) {
    issues.push(`source tag v${intent.version} already exists`);
  }
  if (snapshot.engineVersion !== intent.version) {
    issues.push(
      `${VERSION_SOURCE} is ${snapshot.engineVersion}, expected ${intent.version}`,
    );
  }
  for (const definition of RELEASE_PACKAGE_DEFINITIONS) {
    const actual = snapshot.packageVersions[definition.name];
    if (actual !== intent.version) {
      issues.push(
        `${definition.manifest} is ${actual || "missing a version"}, expected ${intent.version}`,
      );
    }
    const actualDependencies =
      snapshot.packageDependencies[definition.name] ?? [];
    if (
      JSON.stringify(actualDependencies) !==
      JSON.stringify(definition.dependencies)
    ) {
      issues.push(
        `${definition.manifest} release dependencies are ${actualDependencies.join(", ") || "none"}, expected ${definition.dependencies.join(", ") || "none"}`,
      );
    }
  }
  if (snapshot.shippedVersion !== intent.version) {
    issues.push(
      `${SHIPPED_HISTORY} heads at ${snapshot.shippedVersion || "no version"}, expected ${intent.version}; run bun run sync-shipped`,
    );
  }
  const lockVersionCount =
    snapshot.lockBody.split(`"version": "${intent.version}"`).length - 1;
  if (lockVersionCount !== RELEASE_PACKAGE_DEFINITIONS.length) {
    issues.push(
      `bun.lock contains ${lockVersionCount} coordinated ${intent.version} workspace versions, expected ${RELEASE_PACKAGE_DEFINITIONS.length}`,
    );
  }
  if (!snapshot.notesTracked) {
    issues.push(`${intent.notesPath} is not tracked at the candidate commit`);
  }
  if (
    snapshot.notesBody.trim().length < 40 ||
    /TODO|replace this comment|<!--/i.test(snapshot.notesBody)
  ) {
    issues.push(`${intent.notesPath} still contains placeholder release notes`);
  }
  const requiredPaths = [...REQUIRED_PUBLIC_PATHS, intent.notesPath];
  for (const path of requiredPaths) {
    if (!snapshot.exportPaths.includes(path)) {
      issues.push(`${EXPORT_MANIFEST} does not allowlist ${path}`);
    }
  }
  for (const [path, body] of Object.entries(snapshot.versionSurfaces)) {
    if (!body.includes(intent.version)) {
      issues.push(`${path} does not name release ${intent.version}`);
    }
  }
  return issues;
}

export function buildReleasePlan(
  snapshot: ReleaseSnapshot,
  intent: ReleaseIntent,
): ReleasePlan {
  const issues = validateReleaseSnapshot(snapshot, intent);
  if (issues.length > 0) {
    throw new Error(
      `release candidate is not ready:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
  }
  return {
    schema: RELEASE_SCHEMA,
    version: intent.version,
    channel: intent.channel,
    holdingTag: HOLDING_TAG,
    sourceCommit: snapshot.sourceCommit,
    sourceTag: `v${intent.version}`,
    publicRepository: PUBLIC_REPOSITORY,
    notes: { path: intent.notesPath, sha256: snapshot.notesSha256 },
    exportManifest: {
      path: EXPORT_MANIFEST,
      sha256: snapshot.exportManifestSha256,
    },
    packages: RELEASE_PACKAGE_DEFINITIONS.map((definition) => ({
      ...definition,
      version: intent.version,
      dependencies: [...definition.dependencies],
      tarball: `release/tarballs/gitdocket-${definition.id}-${intent.version}.tgz`,
    })),
    checks: [...PRIVATE_RELEASE_CHECKS],
    approval: {
      required: true,
      boundary: "public-commit-tag-registry-and-github-release",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleasePlan(value: unknown): ReleasePlan {
  if (!isRecord(value)) throw new Error("release plan must be an object");
  const version = typeof value.version === "string" ? value.version : "";
  const channel = typeof value.channel === "string" ? value.channel : "";
  const notes = isRecord(value.notes) ? value.notes : {};
  const manifest = isRecord(value.exportManifest) ? value.exportManifest : {};
  const approval = isRecord(value.approval) ? value.approval : {};
  if (
    value.schema !== RELEASE_SCHEMA ||
    !STABLE_SEMVER.test(version) ||
    !DIST_TAG.test(channel) ||
    value.holdingTag !== HOLDING_TAG ||
    value.sourceTag !== `v${version}` ||
    value.publicRepository !== PUBLIC_REPOSITORY ||
    typeof value.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.sourceCommit) ||
    typeof notes.path !== "string" ||
    typeof notes.sha256 !== "string" ||
    manifest.path !== EXPORT_MANIFEST ||
    typeof manifest.sha256 !== "string" ||
    approval.required !== true ||
    approval.boundary !== "public-commit-tag-registry-and-github-release" ||
    !Array.isArray(value.packages) ||
    !Array.isArray(value.checks)
  ) {
    throw new Error("release plan violates schema 1");
  }
  const expectedPackages = RELEASE_PACKAGE_DEFINITIONS.map((definition) => ({
    ...definition,
    version,
    dependencies: [...definition.dependencies],
    tarball: `release/tarballs/gitdocket-${definition.id}-${version}.tgz`,
  }));
  if (JSON.stringify(value.packages) !== JSON.stringify(expectedPackages)) {
    throw new Error("release plan package set or versions are inconsistent");
  }
  if (
    !/^[0-9a-f]{64}$/.test(String(notes.sha256)) ||
    !/^[0-9a-f]{64}$/.test(String(manifest.sha256)) ||
    JSON.stringify(value.checks) !== JSON.stringify(PRIVATE_RELEASE_CHECKS)
  ) {
    throw new Error("release plan evidence or checks are inconsistent");
  }
  return value as unknown as ReleasePlan;
}

export function serializeReleasePlan(plan: ReleasePlan): string {
  parseReleasePlan(plan);
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export async function writeReleasePlan(
  root: string,
  plan: ReleasePlan,
  output?: string,
): Promise<string> {
  const path = output
    ? isAbsolute(output)
      ? output
      : resolve(root, output)
    : join(root, RELEASE_PLAN_DIR, `v${plan.version}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeReleasePlan(plan), "utf8");
  return relative(root, path) || path;
}

function replaceAllExact(source: string, from: string, to: string): string {
  if (!source.includes(from)) {
    throw new Error(`expected ${JSON.stringify(from)} in version surface`);
  }
  return source.split(from).join(to);
}

function replaceExactCount(
  source: string,
  from: string,
  to: string,
  expected: number,
  surface: string,
): string {
  const count = source.split(from).length - 1;
  if (count !== expected) {
    throw new Error(
      `${surface} contains ${count} coordinated version entries, expected ${expected}`,
    );
  }
  return source.split(from).join(to);
}

export async function updateVersionSurfaces(
  root: string,
  nextVersion: string,
  notesPath = `docs/releases/v${nextVersion}.md`,
): Promise<{ previousVersion: string; changed: string[]; notesPath: string }> {
  const intentIssues = validateReleaseIntent({
    version: nextVersion,
    channel: "latest",
    notesPath,
  });
  if (intentIssues.length > 0) throw new Error(intentIssues.join("\n"));
  const versionPath = join(root, VERSION_SOURCE);
  const versionSource = await readFile(versionPath, "utf8");
  const previousVersion = parseEngineVersion(versionSource);
  if (
    !SEMVER.test(previousVersion) ||
    compareSemver(nextVersion, previousVersion) <= 0
  ) {
    throw new Error(
      `next release ${nextVersion} must be greater than current ${previousVersion}`,
    );
  }

  const writes: Array<{ path: string; body: string }> = [
    {
      path: VERSION_SOURCE,
      body: replaceAllExact(versionSource, previousVersion, nextVersion),
    },
  ];

  const lockPath = "bun.lock";
  const lockBody = await readFile(join(root, lockPath), "utf8");
  writes.push({
    path: lockPath,
    body: replaceExactCount(
      lockBody,
      `"version": "${previousVersion}"`,
      `"version": "${nextVersion}"`,
      RELEASE_PACKAGE_DEFINITIONS.length,
      lockPath,
    ),
  });

  for (const definition of RELEASE_PACKAGE_DEFINITIONS) {
    const path = join(root, definition.manifest);
    const body = await readFile(path, "utf8");
    const manifest = JSON.parse(body) as PackageManifest;
    if (manifest.version !== previousVersion) {
      throw new Error(
        `${definition.manifest} is ${manifest.version}, expected ${previousVersion} before versioning`,
      );
    }
    writes.push({
      path: definition.manifest,
      body: body.replace(
        `"version": "${previousVersion}"`,
        `"version": "${nextVersion}"`,
      ),
    });
  }

  for (const surface of VERSION_SURFACES) {
    const path = join(root, surface);
    const body = await readFile(path, "utf8");
    writes.push({
      path: surface,
      body: replaceAllExact(body, previousVersion, nextVersion),
    });
  }

  try {
    await readFile(join(root, notesPath), "utf8");
    throw new Error(`${notesPath} already exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const manifestPath = join(root, EXPORT_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schema: number;
    paths: string[];
  };
  if (manifest.schema !== 1 || !Array.isArray(manifest.paths)) {
    throw new Error(`${EXPORT_MANIFEST} is not a schema-1 export manifest`);
  }
  manifest.paths = [...new Set([...manifest.paths, notesPath])].sort();
  writes.push({
    path: EXPORT_MANIFEST,
    body: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  for (const write of writes) {
    await writeFile(join(root, write.path), write.body);
  }
  await mkdir(dirname(join(root, notesPath)), { recursive: true });
  await writeFile(
    join(root, notesPath),
    `# GitDocket ${nextVersion}\n\n## Highlights\n\n<!-- replace this comment with reviewed release notes -->\n`,
    { flag: "wx" },
  );

  return {
    previousVersion,
    changed: [...writes.map((write) => write.path), notesPath],
    notesPath,
  };
}
