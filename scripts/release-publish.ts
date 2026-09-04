import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertTrustedPublishingRuntime,
  buildPublicationCandidate,
  completeGitHubRelease,
  type GitHubBoundary,
  type GitHubReleaseView,
  inspectGitHubReleaseAssetSha256,
  type PackageCandidate,
  PUBLICATION_SCHEMA,
  type PublicationPreflight,
  RELEASE_REPOSITORY,
  type RegistryBoundary,
  type RegistryReceipt,
  type RegistryVersion,
  type RegistryView,
  runPublicationPreflight,
  runRegistryOnlySmoke,
  runRegistryPublication,
  stableJson,
} from "./release-publication";

const ROOT = join(import.meta.dir, "..");

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function command(args: string[], cwd = ROOT): CommandResult {
  const result = Bun.spawnSync(args, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function checked(args: string[], cwd = ROOT): string {
  const result = command(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} failed${result.stdout ? `\n${result.stdout}` : ""}${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }
  return result.stdout;
}

function parseJson<T>(body: string, context: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${context} returned malformed JSON`);
  }
}

export class NpmRegistryBoundary implements RegistryBoundary {
  async inspect(name: string, version: string): Promise<RegistryView> {
    const versionResult = command([
      "npm",
      "view",
      `${name}@${version}`,
      "--json",
      "dist",
      "dependencies",
      "repository",
    ]);
    let metadata: RegistryVersion | null = null;
    if (versionResult.exitCode === 0) {
      const value = parseJson<{
        dist?: {
          integrity?: string;
          attestations?: {
            url?: string;
            provenance?: { predicateType?: string };
          };
        };
        dependencies?: Record<string, string>;
        repository?: { url?: string; directory?: string };
      }>(versionResult.stdout, `npm view ${name}@${version}`);
      if (
        !value.dist?.integrity ||
        !value.repository?.url ||
        !value.repository.directory
      ) {
        throw new Error(
          `registry metadata is incomplete for ${name}@${version}`,
        );
      }
      metadata = {
        integrity: value.dist.integrity,
        dependencies: value.dependencies ?? {},
        repository: {
          url: value.repository.url,
          directory: value.repository.directory,
        },
        provenanceUrl: value.dist.attestations?.url,
        provenancePredicate: value.dist.attestations?.provenance?.predicateType,
      };
    } else if (!/E404|404 Not Found/i.test(versionResult.stderr)) {
      throw new Error(
        `npm view ${name}@${version} failed\n${versionResult.stderr}`,
      );
    }

    const tagsResult = command(["npm", "view", name, "dist-tags", "--json"]);
    const distTags =
      tagsResult.exitCode === 0
        ? parseJson<Record<string, string>>(
            tagsResult.stdout || "{}",
            `npm view ${name} dist-tags`,
          )
        : /E404|404 Not Found/i.test(tagsResult.stderr)
          ? {}
          : (() => {
              throw new Error(
                `npm view ${name} dist-tags failed\n${tagsResult.stderr}`,
              );
            })();
    return { version: metadata, distTags };
  }

  async publish(
    candidate: PackageCandidate,
    holdingTag: string,
  ): Promise<void> {
    checked([
      "npm",
      "publish",
      resolve(ROOT, candidate.tarball),
      "--access",
      "public",
      "--tag",
      holdingTag,
    ]);
  }

  async setTag(name: string, version: string, tag: string): Promise<void> {
    checked(["npm", "dist-tag", "add", `${name}@${version}`, tag]);
  }
}

export class GhReleaseBoundary implements GitHubBoundary {
  async inspectRelease(
    tag: string,
    assetName: string,
  ): Promise<GitHubReleaseView | null> {
    const result = command([
      "gh",
      "release",
      "view",
      tag,
      "--repo",
      RELEASE_REPOSITORY,
      "--json",
      "tagName,name,body,isDraft,isPrerelease,url,assets",
    ]);
    if (result.exitCode !== 0) {
      if (/not found|release does not exist|HTTP 404/i.test(result.stderr)) {
        return null;
      }
      throw new Error(`gh release view ${tag} failed\n${result.stderr}`);
    }
    const release = parseJson<{
      tagName: string;
      name: string;
      body: string;
      isDraft: boolean;
      isPrerelease: boolean;
      url: string;
      assets: Array<{ name: string }>;
    }>(result.stdout, `gh release view ${tag}`);
    const assetSha256 = release.assets.some((asset) => asset.name === assetName)
      ? await inspectGitHubReleaseAssetSha256(tag, assetName, ROOT)
      : undefined;
    return {
      tag: release.tagName,
      title: release.name,
      body: release.body,
      draft: release.isDraft,
      prerelease: release.isPrerelease,
      url: release.url,
      assets: release.assets.map((asset) => ({
        name: asset.name,
        sha256: asset.name === assetName ? assetSha256 : undefined,
      })),
    };
  }

  async createRelease(options: {
    tag: string;
    title: string;
    notesPath: string;
    receiptPath: string;
    prerelease: boolean;
  }): Promise<void> {
    checked([
      "gh",
      "release",
      "create",
      options.tag,
      options.receiptPath,
      "--repo",
      RELEASE_REPOSITORY,
      "--verify-tag",
      "--title",
      options.title,
      "--notes-file",
      options.notesPath,
      options.prerelease ? "--prerelease" : "--latest",
    ]);
  }
}

function parseArgs(args: string[]): {
  command: "preflight" | "registry" | "github";
  input?: string;
  output: string;
  notes?: string;
} {
  const name = args.shift();
  if (name !== "preflight" && name !== "registry" && name !== "github") {
    throw new Error(
      "usage: bun run release:publish -- <preflight|registry|github> --output <path> [--input <path>] [--notes <path>]",
    );
  }
  let input: string | undefined;
  let output = "";
  let notes: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") input = args[++index];
    else if (arg === "--output") output = args[++index] ?? "";
    else if (arg === "--notes") notes = args[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!output) throw new Error("--output is required");
  if (name !== "preflight" && !input) {
    throw new Error(`${name} requires --input`);
  }
  if (name === "github" && !notes) {
    throw new Error("github requires --notes");
  }
  return { command: name, input, output, notes };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const absolute = resolve(ROOT, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return parseJson<T>(await readFile(resolve(ROOT, path), "utf8"), path);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const registry = new NpmRegistryBoundary();
  if (args.command === "preflight") {
    const candidate = await buildPublicationCandidate(ROOT);
    const preflight = await runPublicationPreflight(candidate, registry);
    await writeJson(args.output, preflight);
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    return;
  }
  if (args.command === "registry") {
    assertTrustedPublishingRuntime();
    const preflight = await readJson<PublicationPreflight>(
      args.input as string,
    );
    if (preflight.schema !== PUBLICATION_SCHEMA) {
      throw new Error("unsupported publication preflight schema");
    }
    const current = await buildPublicationCandidate(ROOT);
    if (stableJson(current) !== stableJson(preflight.candidate)) {
      throw new Error("approved preflight does not match this exact candidate");
    }
    const receipt = await runRegistryPublication(preflight, registry, {
      smoke: runRegistryOnlySmoke,
    });
    await writeJson(args.output, receipt);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  const receipt = await readJson<RegistryReceipt>(args.input as string);
  if (receipt.schema !== PUBLICATION_SCHEMA) {
    throw new Error("unsupported registry receipt schema");
  }
  const result = await completeGitHubRelease(
    receipt,
    resolve(ROOT, args.input as string),
    resolve(ROOT, args.notes as string),
    new GhReleaseBoundary(),
  );
  await writeJson(args.output, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
