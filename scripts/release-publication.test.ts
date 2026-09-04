import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";
import {
  assertTrustedPublishingRuntime,
  buildPublicationCandidate,
  classifyRegistry,
  completeGitHubRelease,
  type GitHubBoundary,
  type GitHubReleaseView,
  type PackageCandidate,
  PUBLICATION_SCHEMA,
  type PublicationCandidate,
  RELEASE_NPM_VERSION,
  RELEASE_REGISTRY,
  RELEASE_REPOSITORY,
  type RegistryBoundary,
  type RegistryReceipt,
  type RegistryVersion,
  type RegistryView,
  runPublicationPreflight,
  runRegistryPublication,
} from "./release-publication";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gitdocket-publication-test-"));
  temporaryRoots.push(root);
  return root;
}

function candidateFixture(): PublicationCandidate {
  return {
    version: "0.2.0",
    sourceTag: "v0.2.0",
    publicCommit: "a".repeat(40),
    stageReceiptSha256: "b".repeat(64),
    repository: RELEASE_REPOSITORY,
    registry: RELEASE_REGISTRY,
    npmVersion: RELEASE_NPM_VERSION,
    workflowRef:
      "GitDocket/gitdocket/.github/workflows/publish.yml@refs/tags/v0.2.0",
    holdingTag: "staged",
    publicTag: "latest",
    packages: ["core", "web", "cli", "mcp"].map(
      (id): PackageCandidate => ({
        id: id as PackageCandidate["id"],
        name: `@gitdocket/${id}`,
        version: "0.2.0",
        tarball: `release/tarballs/gitdocket-${id}-0.2.0.tgz`,
        integrity: `sha512-${id}`,
        dependencies:
          id === "web"
            ? { "@gitdocket/core": "0.2.0" }
            : id === "cli"
              ? {
                  "@gitdocket/core": "0.2.0",
                  "@gitdocket/web": "0.2.0",
                }
              : id === "mcp"
                ? { "@gitdocket/core": "0.2.0" }
                : {},
        repository: {
          url: "git+https://github.com/GitDocket/gitdocket.git",
          directory: `packages/${id}`,
        },
      }),
    ),
  };
}

function correctVersion(candidate: PackageCandidate): RegistryVersion {
  return {
    integrity: candidate.integrity,
    dependencies: { ...candidate.dependencies },
    repository: { ...candidate.repository },
    provenanceUrl: `https://registry.npmjs.test/attestations/${candidate.name}`,
    provenancePredicate: "https://slsa.dev/provenance/v1",
  };
}

class FakeRegistry implements RegistryBoundary {
  versions = new Map<string, RegistryVersion>();
  tags = new Map<string, Record<string, string>>();
  actions: string[] = [];
  omitHoldingOnPublish = false;
  omitProvenanceOnPublish = false;
  failPublish = new Set<string>();
  failTags = new Set<string>();

  async inspect(name: string, _version?: string): Promise<RegistryView> {
    return {
      version: this.versions.get(name) ?? null,
      distTags: { ...(this.tags.get(name) ?? {}) },
    };
  }

  async publish(
    candidate: PackageCandidate,
    holdingTag: string,
  ): Promise<void> {
    this.actions.push(`publish:${candidate.name}`);
    if (this.failPublish.has(candidate.name)) throw new Error("publish failed");
    const version = correctVersion(candidate);
    if (this.omitProvenanceOnPublish) {
      delete version.provenanceUrl;
      delete version.provenancePredicate;
    }
    this.versions.set(candidate.name, version);
    if (!this.omitHoldingOnPublish) {
      this.tags.set(candidate.name, {
        ...(this.tags.get(candidate.name) ?? {}),
        [holdingTag]: candidate.version,
      });
    }
  }

  async setTag(name: string, version: string, tag: string): Promise<void> {
    this.actions.push(`tag:${name}:${tag}`);
    if (this.failTags.has(`${name}:${tag}`)) throw new Error("tag failed");
    this.tags.set(name, { ...(this.tags.get(name) ?? {}), [tag]: version });
  }

  seedCorrect(
    candidate: PackageCandidate,
    tags: Record<string, string> = {},
  ): void {
    this.versions.set(candidate.name, correctVersion(candidate));
    this.tags.set(candidate.name, { beta: "0.0.9", ...tags });
  }
}

const smoke = async () => ({
  packageVersions: Object.fromEntries(
    candidateFixture().packages.map((item) => [item.name, item.version]),
  ),
  mcpTools: Array.from({ length: 9 }, (_, index) => `tool-${index}`),
  serveStatus: 200,
});

async function preflight(
  candidate: PublicationCandidate,
  registry: FakeRegistry,
) {
  return runPublicationPreflight(candidate, registry);
}

describe("publication candidate and preflight", () => {
  test("keeps read-only preflight, protected OIDC publication, and GitHub write permissions separate", async () => {
    const workflow = await Bun.file(
      join(import.meta.dir, "..", ".github", "workflows", "publish.yml"),
    ).text();
    expect(workflow).toContain(
      "preflight:\n    if: github.repository == 'GitDocket/gitdocket'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read",
    );
    expect(workflow).toContain(
      "registry:\n    needs: preflight\n    runs-on: ubuntu-latest\n    environment: release\n    permissions:\n      contents: read\n      id-token: write",
    );
    expect(workflow).toContain(
      "github-release:\n    needs: registry\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write",
    );
    expect(workflow).not.toContain("registry-url:");
  });

  test("classifies absent, partial, complete, and conflicting registry states", () => {
    const candidate = candidateFixture();
    const absent: RegistryView[] = candidate.packages.map(() => ({
      version: null,
      distTags: {},
    }));
    expect(classifyRegistry(candidate, absent).classification).toBe("absent");
    absent[0] = {
      version: correctVersion(candidate.packages[0] as PackageCandidate),
      distTags: { staged: "0.2.0" },
    };
    expect(classifyRegistry(candidate, absent).classification).toBe("partial");
    const complete: RegistryView[] = candidate.packages.map((item) => ({
      version: correctVersion(item),
      distTags: { staged: "0.2.0", latest: "0.2.0", beta: "0.0.9" },
    }));
    const completeState = classifyRegistry(candidate, complete);
    expect(completeState.classification).toBe("complete");
    expect(completeState.holding).toBe("complete");
    expect(completeState.public).toBe("complete");
    complete[2] = {
      distTags: { ...(complete[2]?.distTags ?? {}) },
      version: {
        ...(complete[2]?.version as RegistryVersion),
        integrity: "sha512-occupied-by-other-content",
      },
    };
    expect(classifyRegistry(candidate, complete).classification).toBe(
      "conflicting",
    );
  });

  test("requires an exact annotated tag, workflow identity, runner, and tokenless context", async () => {
    const root = await temporaryRoot();
    await git(root, "init", "-q");
    await writeFile(join(root, "README.md"), "release candidate\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-qm", "candidate");
    const commit = await git(root, "rev-parse", "HEAD");
    await git(
      root,
      "tag",
      "-a",
      `v${DOCKET_VERSION}`,
      "-m",
      `GitDocket v${DOCKET_VERSION}\n\nStage-Receipt-SHA256: ${"c".repeat(64)}`,
    );
    for (const id of ["core", "web", "cli", "mcp"]) {
      const coordinatedDependencies: Record<string, Record<string, string>> = {
        core: {},
        web: { "@gitdocket/core": DOCKET_VERSION },
        cli: {
          "@gitdocket/core": DOCKET_VERSION,
          "@gitdocket/web": DOCKET_VERSION,
        },
        mcp: { "@gitdocket/core": DOCKET_VERSION },
      };
      const staging = join(await temporaryRoot(), "package");
      await mkdir(staging, { recursive: true });
      await writeFile(
        join(staging, "package.json"),
        `${JSON.stringify({
          name: `@gitdocket/${id}`,
          version: DOCKET_VERSION,
          dependencies: coordinatedDependencies[id],
          repository: {
            type: "git",
            url: "git+https://github.com/GitDocket/gitdocket.git",
            directory: `packages/${id}`,
          },
        })}\n`,
      );
      const tarball = join(
        root,
        "release",
        "tarballs",
        `gitdocket-${id}-${DOCKET_VERSION}.tgz`,
      );
      await mkdir(dirname(tarball), { recursive: true });
      await git(root, "status", "--short");
      const result = Bun.spawnSync(
        ["tar", "-czf", tarball, "-C", dirname(staging), "package"],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: RELEASE_REPOSITORY,
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: `v${DOCKET_VERSION}`,
      GITHUB_SHA: commit,
      GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/publish.yml@refs/tags/v${DOCKET_VERSION}`,
      GITHUB_EVENT_NAME: "push",
      RUNNER_ENVIRONMENT: "github-hosted",
    };
    const candidate = await buildPublicationCandidate(root, env);
    expect(candidate.stageReceiptSha256).toBe("c".repeat(64));
    await expect(
      buildPublicationCandidate(root, { ...env, NODE_AUTH_TOKEN: "forbidden" }),
    ).rejects.toThrow("long-lived npm credentials are forbidden");
    await expect(
      buildPublicationCandidate(root, {
        ...env,
        GITHUB_WORKFLOW_REF: "wrong/workflow.yml@refs/tags/v0.1.0",
      }),
    ).rejects.toThrow("trusted publisher workflow identity");
  });

  test("requires the protected environment and OIDC request context before writes", () => {
    expect(() =>
      assertTrustedPublishingRuntime({
        RELEASE_ENVIRONMENT: "release",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral",
      }),
    ).not.toThrow();
    expect(() =>
      assertTrustedPublishingRuntime({ RELEASE_ENVIRONMENT: "release" }),
    ).toThrow("OIDC request context");
  });
});

describe("resumable registry publication", () => {
  test("resumes a partial set, publishes missing packages in order, and preserves unrelated tags", async () => {
    const candidate = candidateFixture();
    const registry = new FakeRegistry();
    registry.seedCorrect(candidate.packages[0] as PackageCandidate);
    registry.seedCorrect(candidate.packages[1] as PackageCandidate, {
      staged: candidate.version,
    });
    const result = await runRegistryPublication(
      await preflight(candidate, registry),
      registry,
      { smoke, sleep: async () => {}, now: () => "2026-09-04T00:00:00Z" },
    );
    expect(
      registry.actions.filter((item) => item.startsWith("publish")),
    ).toEqual(["publish:@gitdocket/cli", "publish:@gitdocket/mcp"]);
    expect(result.final.public).toBe("complete");
    expect(result.final.holding).toBe("complete");
    expect(result.final.packages[0]?.distTags.beta).toBe("0.0.9");
    expect(result.final.packages[1]?.distTags.beta).toBe("0.0.9");
  });

  test("stops on an occupied immutable version instead of publishing or promoting", async () => {
    const candidate = candidateFixture();
    const registry = new FakeRegistry();
    registry.seedCorrect(candidate.packages[0] as PackageCandidate);
    registry.versions.set(candidate.packages[1]?.name ?? "", {
      ...correctVersion(candidate.packages[1] as PackageCandidate),
      integrity: "sha512-conflict",
    });
    await expect(preflight(candidate, registry)).rejects.toThrow(
      "immutable versions require operator reconciliation",
    );
    expect(registry.actions).toEqual([]);
  });

  test("fails closed when the holding tag cannot be established", async () => {
    const candidate = candidateFixture();
    const registry = new FakeRegistry();
    registry.omitHoldingOnPublish = true;
    registry.failTags.add("@gitdocket/core:staged");
    await expect(
      runRegistryPublication(await preflight(candidate, registry), registry, {
        smoke,
        sleep: async () => {},
      }),
    ).rejects.toThrow("tag failed");
    expect(registry.tags.get("@gitdocket/core")?.latest).toBeUndefined();
  });

  test("fails closed when trusted-publisher provenance never appears", async () => {
    const candidate = candidateFixture();
    const registry = new FakeRegistry();
    registry.omitProvenanceOnPublish = true;
    await expect(
      runRegistryPublication(await preflight(candidate, registry), registry, {
        smoke,
        sleep: async () => {},
      }),
    ).rejects.toThrow("registry did not converge");
    expect(registry.tags.get("@gitdocket/core")?.latest).toBeUndefined();
  });

  test("a rerun resumes after a package publication failure", async () => {
    const candidate = candidateFixture();
    const registry = new FakeRegistry();
    registry.failPublish.add("@gitdocket/web");
    const approved = await preflight(candidate, registry);
    await expect(
      runRegistryPublication(approved, registry, {
        smoke,
        sleep: async () => {},
      }),
    ).rejects.toThrow("publish failed");
    expect(registry.versions.has("@gitdocket/core")).toBeTrue();
    expect(registry.versions.has("@gitdocket/web")).toBeFalse();

    registry.failPublish.clear();
    await runRegistryPublication(
      await preflight(candidate, registry),
      registry,
      {
        smoke,
        sleep: async () => {},
      },
    );
    expect(
      registry.actions.filter((item) => item === "publish:@gitdocket/core"),
    ).toHaveLength(1);
    expect(
      registry.actions.filter((item) => item.startsWith("publish:")),
    ).toEqual([
      "publish:@gitdocket/core",
      "publish:@gitdocket/web",
      "publish:@gitdocket/web",
      "publish:@gitdocket/cli",
      "publish:@gitdocket/mcp",
    ]);
  });

  test("a rerun safely completes a prior partial promotion", async () => {
    const candidate = candidateFixture();
    const registry = new FakeRegistry();
    for (const item of candidate.packages) {
      registry.seedCorrect(item, { staged: candidate.version });
    }
    registry.failTags.add("@gitdocket/web:latest");
    const approved = await preflight(candidate, registry);
    await expect(
      runRegistryPublication(approved, registry, {
        smoke,
        sleep: async () => {},
      }),
    ).rejects.toThrow("tag failed");
    expect(registry.tags.get("@gitdocket/core")?.latest).toBe(
      candidate.version,
    );
    expect(registry.tags.get("@gitdocket/web")?.latest).toBeUndefined();

    registry.failTags.clear();
    const resumed = await runRegistryPublication(
      await preflight(candidate, registry),
      registry,
      { smoke, sleep: async () => {} },
    );
    expect(resumed.final.public).toBe("complete");
    expect(
      registry.actions.filter((item) => item.startsWith("publish")),
    ).toEqual([]);
  });
});

async function receiptFixture(): Promise<{
  receipt: RegistryReceipt;
  receiptPath: string;
  notesPath: string;
}> {
  const root = await temporaryRoot();
  const candidate = candidateFixture();
  const registry = new FakeRegistry();
  for (const item of candidate.packages) {
    registry.seedCorrect(item, {
      staged: candidate.version,
      latest: candidate.version,
    });
  }
  const state = classifyRegistry(
    candidate,
    await Promise.all(
      candidate.packages.map((item) =>
        registry.inspect(item.name, item.version),
      ),
    ),
  );
  const receipt: RegistryReceipt = {
    schema: PUBLICATION_SCHEMA,
    candidate,
    initial: state,
    actions: [],
    smoke: await smoke(),
    final: state,
    completedAt: "2026-09-04T00:00:00Z",
  };
  const receiptPath = join(root, "registry-receipt.json");
  const notesPath = join(root, "notes.md");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(notesPath, "# GitDocket 0.2.0\n\nReviewed notes.\n");
  return { receipt, receiptPath, notesPath };
}

class FakeGitHub implements GitHubBoundary {
  release: GitHubReleaseView | null = null;
  fail = false;

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
    if (this.fail) throw new Error("GitHub Release failed");
    const receiptBody = await Bun.file(options.receiptPath).text();
    this.release = {
      tag: options.tag,
      title: options.title,
      body: await Bun.file(options.notesPath).text(),
      draft: false,
      prerelease: options.prerelease,
      url: `https://github.test/releases/${options.tag}`,
      assets: [
        {
          name: options.receiptPath.split("/").pop() ?? "receipt",
          sha256: new Bun.CryptoHasher("sha256")
            .update(receiptBody)
            .digest("hex"),
        },
      ],
    };
  }
}

describe("GitHub Release completion", () => {
  test("creates one verified first-class release and treats an exact rerun as complete", async () => {
    const fixture = await receiptFixture();
    const github = new FakeGitHub();
    const created = await completeGitHubRelease(
      fixture.receipt,
      fixture.receiptPath,
      fixture.notesPath,
      github,
      () => "2026-09-04T00:00:01Z",
    );
    expect(created.action).toBe("created");
    expect(github.release?.body).toContain("registry-receipt.json");
    expect(github.release?.body).toContain(
      "https://registry.npmjs.test/attestations/@gitdocket/core",
    );
    const rerun = await completeGitHubRelease(
      fixture.receipt,
      fixture.receiptPath,
      fixture.notesPath,
      github,
    );
    expect(rerun.action).toBe("already-correct");
  });

  test("surfaces GitHub Release failure without weakening the registry receipt", async () => {
    const fixture = await receiptFixture();
    const github = new FakeGitHub();
    github.fail = true;
    await expect(
      completeGitHubRelease(
        fixture.receipt,
        fixture.receiptPath,
        fixture.notesPath,
        github,
      ),
    ).rejects.toThrow("GitHub Release failed");
    expect(fixture.receipt.final.public).toBe("complete");
  });
});

async function git(root: string, ...args: string[]): Promise<string> {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "GitDocket publication test",
      GIT_AUTHOR_EMAIL: "publication-test@example.invalid",
      GIT_COMMITTER_NAME: "GitDocket publication test",
      GIT_COMMITTER_EMAIL: "publication-test@example.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
