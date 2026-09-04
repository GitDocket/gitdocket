import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildPublicationCandidate,
  completeGitHubRelease,
  type GitHubBoundary,
  type GitHubReleaseView,
  type PackageCandidate,
  type PublicationCandidate,
  type RegistryBoundary,
  type RegistryReceipt,
  type RegistryVersion,
  type RegistryView,
  runPublicationPreflight,
  runRegistryPublication,
} from "./release-publication";
import {
  parseStageReceipt,
  type SmokeResult,
  verifyStageArtifacts,
} from "./release-stage";

const ROOT = join(import.meta.dir, "..");

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed\n${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

function correctVersion(candidate: PackageCandidate): RegistryVersion {
  return {
    integrity: candidate.integrity,
    dependencies: { ...candidate.dependencies },
    repository: { ...candidate.repository },
    provenanceUrl: `https://registry.npmjs.invalid/-/npm/v1/attestations/${encodeURIComponent(candidate.name)}@${candidate.version}`,
    provenancePredicate: "https://slsa.dev/provenance/v1",
  };
}

class MemoryRegistry implements RegistryBoundary {
  versions = new Map<string, RegistryVersion>();
  tags = new Map<string, Record<string, string>>();
  actions: string[] = [];
  failedTags = new Set<string>();

  async inspect(name: string): Promise<RegistryView> {
    return {
      version: this.versions.get(name) ?? null,
      distTags: { ...(this.tags.get(name) ?? {}) },
    };
  }

  async publish(
    candidate: PackageCandidate,
    holdingTag: string,
  ): Promise<void> {
    this.actions.push(
      `publish ${candidate.name}@${candidate.version} --tag ${holdingTag}`,
    );
    this.versions.set(candidate.name, correctVersion(candidate));
    this.tags.set(candidate.name, {
      ...(this.tags.get(candidate.name) ?? {}),
      [holdingTag]: candidate.version,
    });
  }

  async setTag(name: string, version: string, tag: string): Promise<void> {
    this.actions.push(`dist-tag ${name}@${version} ${tag}`);
    if (this.failedTags.has(`${name}:${tag}`)) {
      throw new Error(`simulated dist-tag failure for ${name} ${tag}`);
    }
    this.tags.set(name, { ...(this.tags.get(name) ?? {}), [tag]: version });
  }

  seed(candidate: PackageCandidate, tags: Record<string, string> = {}): void {
    this.versions.set(candidate.name, correctVersion(candidate));
    this.tags.set(candidate.name, { retained: "0.0.0", ...tags });
  }
}

class MemoryGitHub implements GitHubBoundary {
  release: GitHubReleaseView | null = null;

  async inspectRelease(): Promise<GitHubReleaseView | null> {
    return this.release;
  }

  async createRelease(options: {
    tag: string;
    title: string;
    notesPath: string;
    receiptPath: string;
    prerelease: boolean;
  }): Promise<void> {
    const receipt = await readFile(options.receiptPath, "utf8");
    this.release = {
      tag: options.tag,
      title: options.title,
      body: await readFile(options.notesPath, "utf8"),
      draft: false,
      prerelease: options.prerelease,
      url: `https://github.com/GitDocket/gitdocket/releases/tag/${options.tag}`,
      assets: [
        {
          name: basename(options.receiptPath),
          sha256: sha256(receipt),
        },
      ],
    };
  }
}

function candidateEnvironment(
  version: string,
  publicCommit: string,
): Record<string, string> {
  const tag = `v${version}`;
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "GitDocket/gitdocket",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: tag,
    GITHUB_SHA: publicCommit,
    GITHUB_WORKFLOW_REF: `GitDocket/gitdocket/.github/workflows/publish.yml@refs/tags/${tag}`,
    GITHUB_EVENT_NAME: "push",
    RUNNER_ENVIRONMENT: "github-hosted",
    RELEASE_HOLDING_TAG: "staged",
    RELEASE_PUBLIC_TAG: "latest",
  };
}

async function simulate(
  candidate: PublicationCandidate,
  registry: MemoryRegistry,
  smoke: SmokeResult,
): Promise<RegistryReceipt> {
  const preflight = await runPublicationPreflight(candidate, registry);
  return runRegistryPublication(preflight, registry, {
    smoke: async () => smoke,
    sleep: async () => {},
    now: () => "rehearsal",
  });
}

export async function rehearseRelease(options: {
  stagePath: string;
  destination: string;
  output: string;
}): Promise<Record<string, unknown>> {
  const stageBody = await readFile(resolve(ROOT, options.stagePath), "utf8");
  const stage = parseStageReceipt(JSON.parse(stageBody));
  const destination = resolve(options.destination);
  await verifyStageArtifacts(destination, stage);
  if (git(destination, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error(
      "rehearsal public checkout must contain a committed local candidate",
    );
  }
  const publicCommit = git(destination, "rev-parse", "HEAD");
  const candidate = await buildPublicationCandidate(
    destination,
    candidateEnvironment(stage.version, publicCommit),
  );
  if (candidate.stageReceiptSha256 !== sha256(stageBody)) {
    throw new Error(
      "annotated rehearsal tag does not bind the supplied stage receipt",
    );
  }

  const absentRegistry = new MemoryRegistry();
  const absent = await simulate(candidate, absentRegistry, stage.smoke);

  const partialRegistry = new MemoryRegistry();
  for (const item of candidate.packages.slice(0, 2)) {
    partialRegistry.seed(item, { staged: candidate.version });
  }
  const partial = await simulate(candidate, partialRegistry, stage.smoke);

  const conflictRegistry = new MemoryRegistry();
  const conflictPackage = candidate.packages[0] as PackageCandidate;
  conflictRegistry.seed(conflictPackage);
  conflictRegistry.versions.set(conflictPackage.name, {
    ...correctVersion(conflictPackage),
    integrity: "sha512-simulated-conflict",
  });
  let conflict = "";
  try {
    await runPublicationPreflight(candidate, conflictRegistry);
  } catch (error) {
    conflict = error instanceof Error ? error.message : String(error);
  }
  if (
    !conflict.includes("immutable versions require operator reconciliation")
  ) {
    throw new Error("conflict rehearsal did not fail closed");
  }

  const promotionRegistry = new MemoryRegistry();
  for (const item of candidate.packages) {
    promotionRegistry.seed(item, { staged: candidate.version });
  }
  const failedPackage = candidate.packages[1] as PackageCandidate;
  promotionRegistry.failedTags.add(`${failedPackage.name}:latest`);
  let partialPromotion = "";
  try {
    await simulate(candidate, promotionRegistry, stage.smoke);
  } catch (error) {
    partialPromotion = error instanceof Error ? error.message : String(error);
  }
  promotionRegistry.failedTags.clear();
  const recovered = await simulate(candidate, promotionRegistry, stage.smoke);

  const output = resolve(ROOT, options.output);
  await mkdir(dirname(output), { recursive: true });
  const registryReceiptPath = join(dirname(output), "rehearsal-registry.json");
  await writeFile(
    registryReceiptPath,
    `${JSON.stringify(absent, null, 2)}\n`,
    "utf8",
  );
  const github = new MemoryGitHub();
  const githubReceipt = await completeGitHubRelease(
    absent,
    registryReceiptPath,
    join(destination, "docs", "releases", `v${stage.version}.md`),
    github,
    () => "rehearsal",
  );

  const receipt = {
    schema: 1,
    mode: "local-only",
    externalWrites: false,
    stageReceiptSha256: sha256(stageBody),
    publicCommit,
    sourceTag: candidate.sourceTag,
    candidate,
    scenarios: {
      absent: {
        initial: absent.initial,
        actions: absent.actions,
        final: absent.final,
      },
      partial: {
        initial: partial.initial,
        actions: partial.actions,
        final: partial.final,
      },
      conflict: { stopped: true, message: conflict },
      partialPromotion: {
        stopped: true,
        message: partialPromotion,
        recoveryActions: recovered.actions,
        final: recovered.final,
      },
      githubRelease: githubReceipt,
    },
    manualBoundaries: [
      "review the canonical plan, public diff, stage receipt, and release notes",
      "approve the public commit and annotated-tag push",
      "review the read-only workflow preflight and approve the protected release environment",
      "reconcile any immutable registry or existing GitHub Release conflict",
    ],
  };
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function parseArgs(args: string[]): {
  stagePath: string;
  destination: string;
  output: string;
} {
  let stagePath = "";
  let destination = "";
  let output = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stage") stagePath = args[++index] ?? "";
    else if (arg === "--destination") destination = args[++index] ?? "";
    else if (arg === "--output") output = args[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!stagePath || !destination || !output) {
    throw new Error(
      "usage: bun run release:rehearse -- --stage <receipt> --destination <committed-local-public-checkout> --output <receipt>",
    );
  }
  return { stagePath, destination, output };
}

if (import.meta.main) {
  try {
    const receipt = await rehearseRelease(parseArgs(Bun.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
