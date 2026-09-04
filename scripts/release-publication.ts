import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { runInstalledSmoke, type SmokeResult } from "./release-stage";

export const PUBLICATION_SCHEMA = 1 as const;
export const PACKAGE_IDS = ["core", "web", "cli", "mcp"] as const;
export const PACKAGE_NAMES = PACKAGE_IDS.map((id) => `@gitdocket/${id}`);
export const RELEASE_REPOSITORY = "GitDocket/gitdocket";
export const RELEASE_WORKFLOW = ".github/workflows/publish.yml";
export const RELEASE_ENVIRONMENT = "release";
export const RELEASE_REGISTRY = "https://registry.npmjs.org/";
export const RELEASE_NPM_VERSION = "11.17.0";

export interface PackageCandidate {
  id: (typeof PACKAGE_IDS)[number];
  name: string;
  version: string;
  tarball: string;
  integrity: string;
  dependencies: Record<string, string>;
  repository: { url: string; directory: string };
}

export interface PublicationCandidate {
  version: string;
  sourceTag: string;
  publicCommit: string;
  stageReceiptSha256: string;
  repository: typeof RELEASE_REPOSITORY;
  registry: typeof RELEASE_REGISTRY;
  npmVersion: typeof RELEASE_NPM_VERSION;
  workflowRef: string;
  holdingTag: string;
  publicTag: string;
  packages: PackageCandidate[];
}

export interface RegistryVersion {
  integrity: string;
  dependencies: Record<string, string>;
  repository: { url: string; directory: string };
  provenanceUrl?: string;
  provenancePredicate?: string;
}

export interface RegistryView {
  version: RegistryVersion | null;
  distTags: Record<string, string>;
}

export type PackageVersionState = "absent" | "correct" | "conflicting";

export interface PackageState {
  name: string;
  state: PackageVersionState;
  reasons: string[];
  distTags: Record<string, string>;
  evidence?: {
    integrity: string;
    provenanceUrl?: string;
    provenancePredicate?: string;
  };
}

export interface RegistrySnapshot {
  classification: "absent" | "partial" | "complete" | "conflicting";
  holding: "absent" | "partial" | "complete";
  public: "absent" | "partial" | "complete";
  packages: PackageState[];
}

export interface PublicationPreflight {
  schema: typeof PUBLICATION_SCHEMA;
  candidate: PublicationCandidate;
  registry: RegistrySnapshot;
  trustedPublishing: {
    provider: "github-actions-oidc";
    workflow: typeof RELEASE_WORKFLOW;
    environment: typeof RELEASE_ENVIRONMENT;
    longLivedToken: false;
    automaticProvenance: true;
  };
  approvalBoundary: string;
}

export interface RegistryReceipt {
  schema: typeof PUBLICATION_SCHEMA;
  candidate: PublicationCandidate;
  initial: RegistrySnapshot;
  actions: string[];
  smoke: SmokeResult;
  final: RegistrySnapshot;
  completedAt: string;
}

export interface GitHubReleaseView {
  tag: string;
  title: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  url: string;
  assets: Array<{ name: string; sha256?: string }>;
}

export interface GitHubReleaseReceipt {
  schema: typeof PUBLICATION_SCHEMA;
  tag: string;
  publicCommit: string;
  registryReceiptSha256: string;
  releaseUrl: string;
  action: "created" | "already-correct";
  completedAt: string;
}

export interface RegistryBoundary {
  inspect(name: string, version: string): Promise<RegistryView>;
  publish(candidate: PackageCandidate, holdingTag: string): Promise<void>;
  setTag(name: string, version: string, tag: string): Promise<void>;
}

export interface GitHubBoundary {
  inspectRelease(
    tag: string,
    assetName: string,
  ): Promise<GitHubReleaseView | null>;
  createRelease(options: {
    tag: string;
    title: string;
    notesPath: string;
    receiptPath: string;
    prerelease: boolean;
  }): Promise<void>;
}

export interface PublicationEnvironment
  extends Record<string, string | undefined> {
  GITHUB_ACTIONS?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_REF_TYPE?: string;
  GITHUB_REF_NAME?: string;
  GITHUB_SHA?: string;
  GITHUB_WORKFLOW_REF?: string;
  GITHUB_EVENT_NAME?: string;
  RUNNER_ENVIRONMENT?: string;
  RELEASE_HOLDING_TAG?: string;
  RELEASE_PUBLIC_TAG?: string;
  RELEASE_ENVIRONMENT?: string;
  ACTIONS_ID_TOKEN_REQUEST_URL?: string;
  ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string;
  NODE_AUTH_TOKEN?: string;
  NPM_TOKEN?: string;
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`,
    );
  }
  return stdout;
}

function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function sha512Integrity(value: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha512").update(value).digest("base64");
  return `sha512-${digest}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertTag(tag: string, label: string): void {
  if (!/^[a-z][a-z0-9._-]*$/.test(tag) || /^v?\d+(?:\.\d+){1,2}$/.test(tag)) {
    throw new Error(`${label} is not a safe npm dist-tag: ${tag}`);
  }
}

function assertTokenless(env: PublicationEnvironment): void {
  const names = [
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "npm_config_token",
    "NPM_CONFIG_TOKEN",
  ];
  const found = names.filter((name) => Boolean(env[name]));
  if (found.length) {
    throw new Error(
      `long-lived npm credentials are forbidden for release publication: ${found.join(", ")}`,
    );
  }
}

function parseTagAnnotation(body: string, version: string): string {
  if (!body.includes(`GitDocket v${version}`)) {
    throw new Error(`annotated tag does not identify GitDocket v${version}`);
  }
  const matches = [
    ...body.matchAll(/^Stage-Receipt-SHA256:\s*([0-9a-f]{64})\s*$/gm),
  ];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error(
      "annotated tag must contain one Stage-Receipt-SHA256 trailer",
    );
  }
  return matches[0][1];
}

function assertGitHubContext(
  root: string,
  env: PublicationEnvironment,
): {
  tag: string;
  commit: string;
  stageReceiptSha256: string;
  workflowRef: string;
} {
  if (env.GITHUB_ACTIONS !== "true") {
    throw new Error("publication preflight is restricted to GitHub Actions");
  }
  if (env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY) {
    throw new Error(`publication is restricted to ${RELEASE_REPOSITORY}`);
  }
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF_TYPE !== "tag") {
    throw new Error("publication requires the public annotated-tag push event");
  }
  const tag = `v${DOCKET_VERSION}`;
  if (env.GITHUB_REF_NAME !== tag) {
    throw new Error(`publication requires exact tag ${tag}`);
  }
  const commit = env.GITHUB_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("GITHUB_SHA must be one exact public commit");
  }
  const workflowRef = env.GITHUB_WORKFLOW_REF ?? "";
  const expected = `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/tags/${tag}`;
  if (workflowRef !== expected) {
    throw new Error(`trusted publisher workflow identity must be ${expected}`);
  }
  if (env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error("trusted publishing requires a GitHub-hosted runner");
  }
  if (run(["git", "cat-file", "-t", `refs/tags/${tag}`], root) !== "tag") {
    throw new Error(`${tag} must be an annotated release-candidate tag`);
  }
  const peeled = run(["git", "rev-list", "-n", "1", `refs/tags/${tag}`], root);
  if (peeled !== commit) {
    throw new Error(
      `${tag} resolves to ${peeled}, not public commit ${commit}`,
    );
  }
  const annotation = run(["git", "cat-file", "-p", `refs/tags/${tag}`], root);
  return {
    tag,
    commit,
    stageReceiptSha256: parseTagAnnotation(annotation, DOCKET_VERSION),
    workflowRef,
  };
}

async function packageCandidate(
  root: string,
  id: (typeof PACKAGE_IDS)[number],
): Promise<PackageCandidate> {
  const relativeTarball = `release/tarballs/gitdocket-${id}-${DOCKET_VERSION}.tgz`;
  const tarball = join(root, relativeTarball);
  if (!(await Bun.file(tarball).exists())) {
    throw new Error(`missing packed artifact ${tarball}`);
  }
  const manifest = JSON.parse(
    run(["tar", "-xOf", tarball, "package/package.json"], root),
  ) as {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    repository?: { url?: string; directory?: string };
  };
  const name = `@gitdocket/${id}`;
  const repository = {
    url: "git+https://github.com/GitDocket/gitdocket.git",
    directory: `packages/${id}`,
  };
  if (
    manifest.name !== name ||
    manifest.version !== DOCKET_VERSION ||
    manifest.repository?.url !== repository.url ||
    manifest.repository.directory !== repository.directory
  ) {
    throw new Error(`${basename(tarball)} has inconsistent release identity`);
  }
  const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer());
  return {
    id,
    name,
    version: DOCKET_VERSION,
    tarball: relativeTarball,
    integrity: sha512Integrity(bytes),
    dependencies: manifest.dependencies ?? {},
    repository,
  };
}

function assertPackageGraph(packages: PackageCandidate[]): void {
  const expected: Record<string, string[]> = {
    "@gitdocket/core": [],
    "@gitdocket/web": ["@gitdocket/core"],
    "@gitdocket/cli": ["@gitdocket/core", "@gitdocket/web"],
    "@gitdocket/mcp": ["@gitdocket/core"],
  };
  for (const item of packages) {
    const internal = Object.keys(item.dependencies)
      .filter((name) => name.startsWith("@gitdocket/"))
      .sort();
    if (stableJson(internal) !== stableJson(expected[item.name])) {
      throw new Error(
        `${item.name} has an unexpected coordinated dependency graph`,
      );
    }
    for (const name of internal) {
      if (item.dependencies[name] !== item.version) {
        throw new Error(`${item.name} must depend on ${name}@${item.version}`);
      }
      const dependencyIndex = packages.findIndex(
        (candidate) => candidate.name === name,
      );
      const packageIndex = packages.findIndex(
        (candidate) => candidate.name === item.name,
      );
      if (dependencyIndex < 0 || dependencyIndex >= packageIndex) {
        throw new Error(`${item.name} is not ordered after ${name}`);
      }
    }
  }
}

export async function buildPublicationCandidate(
  root: string,
  env: PublicationEnvironment = process.env,
): Promise<PublicationCandidate> {
  assertTokenless(env);
  const context = assertGitHubContext(root, env);
  const registry = run(["npm", "config", "get", "registry"], root);
  if (registry !== RELEASE_REGISTRY) {
    throw new Error(`publication registry must be ${RELEASE_REGISTRY}`);
  }
  const npmVersion = run(["npm", "--version"], root);
  if (npmVersion !== RELEASE_NPM_VERSION) {
    throw new Error(`publication requires npm ${RELEASE_NPM_VERSION}`);
  }
  const holdingTag = env.RELEASE_HOLDING_TAG ?? "staged";
  const publicTag = env.RELEASE_PUBLIC_TAG ?? "latest";
  assertTag(holdingTag, "holding tag");
  assertTag(publicTag, "public tag");
  if (holdingTag === publicTag) {
    throw new Error("holding and public dist-tags must differ");
  }
  const packages = await Promise.all(
    PACKAGE_IDS.map((id) => packageCandidate(root, id)),
  );
  assertPackageGraph(packages);
  return {
    version: DOCKET_VERSION,
    sourceTag: context.tag,
    publicCommit: context.commit,
    stageReceiptSha256: context.stageReceiptSha256,
    repository: RELEASE_REPOSITORY,
    registry: RELEASE_REGISTRY,
    npmVersion: RELEASE_NPM_VERSION,
    workflowRef: context.workflowRef,
    holdingTag,
    publicTag,
    packages,
  };
}

function compareVersion(
  candidate: PackageCandidate,
  version: RegistryVersion,
): string[] {
  const reasons: string[] = [];
  if (version.integrity !== candidate.integrity)
    reasons.push("tarball integrity differs");
  if (stableJson(version.dependencies) !== stableJson(candidate.dependencies)) {
    reasons.push("dependencies differ");
  }
  if (stableJson(version.repository) !== stableJson(candidate.repository)) {
    reasons.push("repository identity differs");
  }
  if (!version.provenanceUrl)
    reasons.push("trusted-publisher provenance is absent");
  if (version.provenancePredicate !== "https://slsa.dev/provenance/v1") {
    reasons.push("SLSA provenance predicate is absent");
  }
  return reasons;
}

export function classifyRegistry(
  candidate: PublicationCandidate,
  views: RegistryView[],
): RegistrySnapshot {
  if (views.length !== candidate.packages.length) {
    throw new Error(
      "registry snapshot does not cover the coordinated package set",
    );
  }
  const packages = candidate.packages.map((item, index): PackageState => {
    const view = views[index] as RegistryView;
    const reasons = view.version ? compareVersion(item, view.version) : [];
    return {
      name: item.name,
      state: !view.version
        ? "absent"
        : reasons.length
          ? "conflicting"
          : "correct",
      reasons,
      distTags: { ...view.distTags },
      evidence: view.version
        ? {
            integrity: view.version.integrity,
            provenanceUrl: view.version.provenanceUrl,
            provenancePredicate: view.version.provenancePredicate,
          }
        : undefined,
    };
  });
  const correct = packages.filter((item) => item.state === "correct").length;
  const conflicting = packages.some((item) => item.state === "conflicting");
  const phase = (tag: string): "absent" | "partial" | "complete" => {
    const count = packages.filter(
      (item) => item.distTags[tag] === candidate.version,
    ).length;
    return count === 0
      ? "absent"
      : count === packages.length
        ? "complete"
        : "partial";
  };
  return {
    classification: conflicting
      ? "conflicting"
      : correct === 0
        ? "absent"
        : correct === packages.length
          ? "complete"
          : "partial",
    holding: phase(candidate.holdingTag),
    public: phase(candidate.publicTag),
    packages,
  };
}

async function snapshot(
  candidate: PublicationCandidate,
  registry: RegistryBoundary,
): Promise<RegistrySnapshot> {
  return classifyRegistry(
    candidate,
    await Promise.all(
      candidate.packages.map((item) =>
        registry.inspect(item.name, item.version),
      ),
    ),
  );
}

function assertNoConflicts(state: RegistrySnapshot): void {
  const conflicts = state.packages.filter(
    (item) => item.state === "conflicting",
  );
  if (conflicts.length) {
    throw new Error(
      `registry conflict; immutable versions require operator reconciliation: ${conflicts
        .map((item) => `${item.name} (${item.reasons.join(", ")})`)
        .join("; ")}`,
    );
  }
}

export async function runPublicationPreflight(
  candidate: PublicationCandidate,
  registry: RegistryBoundary,
): Promise<PublicationPreflight> {
  const state = await snapshot(candidate, registry);
  assertNoConflicts(state);
  return {
    schema: PUBLICATION_SCHEMA,
    candidate,
    registry: state,
    trustedPublishing: {
      provider: "github-actions-oidc",
      workflow: RELEASE_WORKFLOW,
      environment: RELEASE_ENVIRONMENT,
      longLivedToken: false,
      automaticProvenance: true,
    },
    approvalBoundary:
      "Approve the protected release environment only after reviewing this exact tag, commit, stage-receipt hash, tarball set, and registry state.",
  };
}

export function assertTrustedPublishingRuntime(
  env: PublicationEnvironment = process.env,
): void {
  assertTokenless(env);
  if (env.RELEASE_ENVIRONMENT !== RELEASE_ENVIRONMENT) {
    throw new Error(
      `publication job must name protected environment ${RELEASE_ENVIRONMENT}`,
    );
  }
  if (
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    throw new Error("GitHub Actions OIDC request context is unavailable");
  }
}

async function waitFor(
  candidate: PackageCandidate,
  registry: RegistryBoundary,
  predicate: (view: RegistryView) => boolean,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<RegistryView> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const view = await registry.inspect(candidate.name, candidate.version);
    const state = classifyRegistry(
      {
        version: candidate.version,
        sourceTag: "",
        publicCommit: "",
        stageReceiptSha256: "",
        repository: RELEASE_REPOSITORY,
        registry: RELEASE_REGISTRY,
        npmVersion: RELEASE_NPM_VERSION,
        workflowRef: "",
        holdingTag: "staged",
        publicTag: "latest",
        packages: [candidate],
      },
      [view],
    );
    const conflicts = state.packages[0]?.reasons ?? [];
    if (
      conflicts.some(
        (reason) =>
          reason !== "trusted-publisher provenance is absent" &&
          reason !== "SLSA provenance predicate is absent",
      )
    ) {
      assertNoConflicts(state);
    }
    if (predicate(view)) return view;
    if (attempt < 11) await sleep(5_000);
  }
  throw new Error(
    `registry did not converge for ${candidate.name}@${candidate.version}`,
  );
}

export async function runRegistryPublication(
  preflight: PublicationPreflight,
  registry: RegistryBoundary,
  options: {
    smoke: (candidate: PublicationCandidate) => Promise<SmokeResult>;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => string;
  },
): Promise<RegistryReceipt> {
  const candidate = preflight.candidate;
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const initial = await snapshot(candidate, registry);
  assertNoConflicts(initial);
  const actions: string[] = [];

  for (const item of candidate.packages) {
    let view = await registry.inspect(item.name, item.version);
    const state = classifyRegistry({ ...candidate, packages: [item] }, [view]);
    assertNoConflicts(state);
    if (state.packages[0]?.state === "absent") {
      await registry.publish(item, candidate.holdingTag);
      actions.push(
        `published ${item.name}@${item.version} under ${candidate.holdingTag}`,
      );
      view = await waitFor(
        item,
        registry,
        (current) =>
          Boolean(current.version) &&
          compareVersion(item, current.version as RegistryVersion).length === 0,
        sleep,
      );
    } else {
      actions.push(`kept existing correct ${item.name}@${item.version}`);
    }
    if (view.distTags[candidate.holdingTag] !== candidate.version) {
      await registry.setTag(item.name, item.version, candidate.holdingTag);
      actions.push(`set ${item.name}@${item.version} ${candidate.holdingTag}`);
      await waitFor(
        item,
        registry,
        (current) =>
          current.distTags[candidate.holdingTag] === candidate.version,
        sleep,
      );
    }
  }

  const held = await snapshot(candidate, registry);
  assertNoConflicts(held);
  if (held.classification !== "complete" || held.holding !== "complete") {
    throw new Error(
      "coordinated package set is not complete under the holding tag",
    );
  }

  const smoke = await options.smoke(candidate);

  for (const item of candidate.packages) {
    const view = await registry.inspect(item.name, item.version);
    const state = classifyRegistry({ ...candidate, packages: [item] }, [view]);
    assertNoConflicts(state);
    if (view.distTags[candidate.publicTag] === candidate.version) {
      actions.push(
        `kept ${item.name} ${candidate.publicTag} at ${item.version}`,
      );
      continue;
    }
    await registry.setTag(item.name, item.version, candidate.publicTag);
    actions.push(`set ${item.name}@${item.version} ${candidate.publicTag}`);
    await waitFor(
      item,
      registry,
      (current) => current.distTags[candidate.publicTag] === candidate.version,
      sleep,
    );
  }

  const final = await snapshot(candidate, registry);
  assertNoConflicts(final);
  if (
    final.classification !== "complete" ||
    final.holding !== "complete" ||
    final.public !== "complete"
  ) {
    throw new Error(
      "publication remains partial; rerun the exact tag after registry reconciliation",
    );
  }
  return {
    schema: PUBLICATION_SCHEMA,
    candidate,
    initial,
    actions,
    smoke,
    final,
    completedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

export async function runRegistryOnlySmoke(
  candidate: PublicationCandidate,
): Promise<SmokeResult> {
  return runInstalledSmoke({
    dependencies: Object.fromEntries(
      candidate.packages.map((item) => [item.name, item.version]),
    ),
    version: candidate.version,
  });
}

export async function completeGitHubRelease(
  receipt: RegistryReceipt,
  receiptPath: string,
  notesPath: string,
  github: GitHubBoundary,
  now: () => string = () => new Date().toISOString(),
): Promise<GitHubReleaseReceipt> {
  if (
    receipt.final.classification !== "complete" ||
    receipt.final.public !== "complete"
  ) {
    throw new Error(
      "GitHub Release requires a coherently promoted registry receipt",
    );
  }
  const receiptBody = await readFile(receiptPath, "utf8");
  const notes = await readFile(notesPath, "utf8");
  const assetName = basename(receiptPath);
  const receiptSha256 = sha256(receiptBody);
  const provenance = receipt.final.packages
    .map((item) => {
      const url = item.evidence?.provenanceUrl;
      if (!url)
        throw new Error(`final receipt has no provenance URL for ${item.name}`);
      return `- [${item.name}@${receipt.candidate.version}](${url})`;
    })
    .join("\n");
  const releaseBody = `${notes.trimEnd()}\n\n## Verification\n\n- Publication receipt: attached \`${assetName}\` (SHA-256 \`${receiptSha256}\`)\n- npm trusted-publisher provenance:\n${provenance}\n`;
  const desired = {
    tag: receipt.candidate.sourceTag,
    title: `GitDocket v${receipt.candidate.version}`,
    body: releaseBody,
    draft: false,
    prerelease: receipt.candidate.publicTag !== "latest",
  };
  const assertRelease = (release: GitHubReleaseView): void => {
    const asset = release.assets.find((item) => item.name === assetName);
    const errors = [
      release.tag === desired.tag ? "" : "tag differs",
      release.title === desired.title ? "" : "title differs",
      release.body === desired.body ? "" : "notes differ",
      release.draft === desired.draft ? "" : "draft state differs",
      release.prerelease === desired.prerelease
        ? ""
        : "prerelease state differs",
      asset ? "" : `receipt asset ${assetName} is absent`,
      asset?.sha256 === receiptSha256 ? "" : "receipt asset hash differs",
    ].filter(Boolean);
    if (errors.length) {
      throw new Error(
        `GitHub Release conflicts with the receipt: ${errors.join(", ")}`,
      );
    }
  };

  const existing = await github.inspectRelease(desired.tag, assetName);
  if (existing) {
    assertRelease(existing);
    return {
      schema: PUBLICATION_SCHEMA,
      tag: desired.tag,
      publicCommit: receipt.candidate.publicCommit,
      registryReceiptSha256: receiptSha256,
      releaseUrl: existing.url,
      action: "already-correct",
      completedAt: now(),
    };
  }
  const composedNotesPath = join(
    receiptPath,
    "..",
    `github-${receipt.candidate.sourceTag}-notes.md`,
  );
  await writeFile(composedNotesPath, releaseBody, "utf8");
  await github.createRelease({
    tag: desired.tag,
    title: desired.title,
    notesPath: composedNotesPath,
    receiptPath,
    prerelease: desired.prerelease,
  });
  const created = await github.inspectRelease(desired.tag, assetName);
  if (!created) throw new Error("GitHub Release creation returned no release");
  assertRelease(created);
  return {
    schema: PUBLICATION_SCHEMA,
    tag: desired.tag,
    publicCommit: receipt.candidate.publicCommit,
    registryReceiptSha256: receiptSha256,
    releaseUrl: created.url,
    action: "created",
    completedAt: now(),
  };
}

export async function inspectGitHubReleaseAssetSha256(
  tag: string,
  assetName: string,
  root: string,
): Promise<string | undefined> {
  const temporary = await mkdtemp(join(tmpdir(), "gitdocket-release-asset-"));
  try {
    const result = Bun.spawnSync(
      [
        "gh",
        "release",
        "download",
        tag,
        "--repo",
        RELEASE_REPOSITORY,
        "--pattern",
        assetName,
        "--dir",
        temporary,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) return undefined;
    return sha256(
      new Uint8Array(await Bun.file(join(temporary, assetName)).arrayBuffer()),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
