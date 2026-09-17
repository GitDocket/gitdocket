import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { RELEASE_PACKAGE_DEFINITIONS } from "./release-contract";
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
    optionalDependencies: { ...candidate.optionalDependencies },
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

function fastPolling() {
  let elapsed = 0;
  return {
    sleep: async (milliseconds: number) => {
      elapsed += milliseconds;
    },
    monotonicNow: () => elapsed,
  };
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
      "preflight:\n    needs: standalone\n    if: github.repository == 'GitDocket/gitdocket'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read",
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
    for (const definition of RELEASE_PACKAGE_DEFINITIONS) {
      const id = definition.id;
      const staging = join(root, "staging", id, "package");
      await mkdir(staging, { recursive: true });
      const coordinatedDependencies = {
        [id]: Object.fromEntries(
          definition.dependencies.map((name) => [name, DOCKET_VERSION]),
        ),
      };
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
    const candidate = await buildPublicationCandidate(root, env, {
      verifyStandalone: async () => [],
    });
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
  test("a missing platform cannot promote launchers, and retry never republishes existing binaries", async () => {
    const candidate = candidateFixture();
    candidate.packages = RELEASE_PACKAGE_DEFINITIONS.map((definition) => ({
      id: definition.id as PackageCandidate["id"],
      name: definition.name,
      version: candidate.version,
      tarball: `release/tarballs/gitdocket-${definition.id}-${candidate.version}.tgz`,
      integrity: `sha512-${definition.id}`,
      dependencies: Object.fromEntries(
        definition.dependencies.map((name) => [name, candidate.version]),
      ),
      optionalDependencies: ["cli", "mcp"].includes(definition.id)
        ? Object.fromEntries(
            definition.dependencies.map((name) => [name, candidate.version]),
          )
        : {},
      repository: {
        url: "git+https://github.com/GitDocket/gitdocket.git",
        directory: `packages/${definition.id}`,
      },
    }));
    const registry = new FakeRegistry();
    registry.failPublish.add("@gitdocket/bin-linux-arm64");
    const proof = await preflight(candidate, registry);
    await expect(
      runRegistryPublication(proof, registry, { smoke, sleep: async () => {} }),
    ).rejects.toThrow("publish failed");
    expect(registry.actions).not.toContain("publish:@gitdocket/cli");
    expect(
      registry.actions.some((action) => action.endsWith(":latest")),
    ).toBeFalse();
    registry.failPublish.clear();
    await runRegistryPublication(proof, registry, {
      smoke,
      ...fastPolling(),
    });
    expect(
      registry.actions.filter(
        (action) => action === "publish:@gitdocket/bin-darwin-arm64",
      ),
    ).toHaveLength(1);
    expect(
      registry.actions.indexOf("publish:@gitdocket/bin-linux-x64"),
    ).toBeLessThan(registry.actions.indexOf("publish:@gitdocket/cli"));
    const cli = candidate.packages.find(
      (item) => item.id === "cli",
    ) as PackageCandidate;
    const current = registry.versions.get(cli.name) as RegistryVersion;
    current.optionalDependencies = {};
    expect(
      classifyRegistry({ ...candidate, packages: [cli] }, [
        { version: current, distTags: {} },
      ]).classification,
    ).toBe("conflicting");
  });

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
      { smoke, ...fastPolling(), now: () => "2026-09-04T00:00:00Z" },
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
        ...fastPolling(),
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
        ...fastPolling(),
      }),
    ).rejects.toThrow("registry did not converge");
    expect(registry.tags.get("@gitdocket/core")?.latest).toBeUndefined();
  });

  test("waits through delayed version, provenance and tag visibility without repeating writes", async () => {
    const candidate = candidateFixture();
    const polling = fastPolling();
    class DelayedRegistry extends FakeRegistry {
      acceptedAt = new Map<string, number>();
      promotedAt = new Map<string, number>();
      override async publish(item: PackageCandidate, tag: string) {
        await super.publish(item, tag);
        this.acceptedAt.set(item.name, polling.monotonicNow());
      }
      override async setTag(name: string, version: string, tag: string) {
        await super.setTag(name, version, tag);
        if (tag === "latest") this.promotedAt.set(name, polling.monotonicNow());
      }
      override async inspect(name: string): Promise<RegistryView> {
        const result = await super.inspect(name);
        const accepted = this.acceptedAt.get(name);
        if (accepted !== undefined) {
          const elapsed = polling.monotonicNow() - accepted;
          if (elapsed < 180_000) return { version: null, distTags: {} };
          if (elapsed < 240_000 && result.version) {
            result.version = {
              ...result.version,
              provenanceUrl: undefined,
              provenancePredicate: undefined,
            };
          }
        }
        const promoted = this.promotedAt.get(name);
        if (
          promoted !== undefined &&
          polling.monotonicNow() - promoted < 120_000
        )
          delete result.distTags.latest;
        return result;
      }
    }
    const registry = new DelayedRegistry();
    const messages: string[] = [];
    const result = await runRegistryPublication(
      await preflight(candidate, registry),
      registry,
      {
        ...polling,
        smoke,
        onProgress: (message) => messages.push(message),
      },
    );
    expect(result.final.public).toBe("complete");
    expect(
      registry.actions.filter((item) => item.startsWith("publish:")),
    ).toHaveLength(4);
    expect(
      registry.actions.filter((item) => item.includes(":latest")),
    ).toHaveLength(4);
    expect(messages[0]).toBe("published @gitdocket/core@0.2.0 under staged");
    expect(
      messages.some((item) => item.startsWith("waiting for @gitdocket/core")),
    ).toBeTrue();
    expect(messages).toContain(
      "registry installation smoke passed; promoting public tags",
    );
  });

  test("reports accepted publication on timeout and resumes without republishing it", async () => {
    const candidate = candidateFixture();
    const polling = fastPolling();
    class InvisibleRegistry extends FakeRegistry {
      hideAccepted = true;
      override async inspect(name: string): Promise<RegistryView> {
        if (this.hideAccepted) return { version: null, distTags: {} };
        return super.inspect(name);
      }
    }
    const registry = new InvisibleRegistry();
    const messages: string[] = [];
    let smoked = false;
    await expect(
      runRegistryPublication(await preflight(candidate, registry), registry, {
        ...polling,
        smoke: async () => {
          smoked = true;
          return smoke();
        },
        onProgress: (message) => messages.push(message),
      }),
    ).rejects.toThrow("publication may already have succeeded");
    expect(polling.monotonicNow()).toBe(600_000);
    expect(smoked).toBeFalse();
    expect(registry.actions).toEqual(["publish:@gitdocket/core"]);
    expect(messages[0]).toBe("published @gitdocket/core@0.2.0 under staged");
    registry.hideAccepted = false;
    const resumed = await runRegistryPublication(
      await preflight(candidate, registry),
      registry,
      { ...polling, smoke },
    );
    expect(resumed.final.public).toBe("complete");
    expect(
      registry.actions.filter((action) => action === "publish:@gitdocket/core"),
    ).toHaveLength(1);
  });

  test("stops immediately when delayed publication reveals different immutable bytes", async () => {
    const candidate = candidateFixture();
    const polling = fastPolling();
    class ConflictingRegistry extends FakeRegistry {
      override async publish(item: PackageCandidate, tag: string) {
        await super.publish(item, tag);
        this.versions.set(item.name, {
          ...correctVersion(item),
          integrity: "sha512-conflicting-bytes",
        });
      }
    }
    const registry = new ConflictingRegistry();
    await expect(
      runRegistryPublication(await preflight(candidate, registry), registry, {
        ...polling,
        smoke,
      }),
    ).rejects.toThrow("immutable versions require operator reconciliation");
    expect(polling.monotonicNow()).toBe(0);
    expect(registry.actions).toEqual(["publish:@gitdocket/core"]);
  });

  test("a rerun resumes after a package publication failure", async () => {
    const candidate = candidateFixture();
    const registry = new FakeRegistry();
    registry.failPublish.add("@gitdocket/web");
    const approved = await preflight(candidate, registry);
    await expect(
      runRegistryPublication(approved, registry, {
        smoke,
        ...fastPolling(),
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
        ...fastPolling(),
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
        ...fastPolling(),
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
    assets?: string[];
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
        ...(await Promise.all(
          (options.assets ?? []).map(async (path) => ({
            name: path.split("/").pop() ?? "",
            sha256: new Bun.CryptoHasher("sha256")
              .update(await Bun.file(path).arrayBuffer())
              .digest("hex"),
          })),
        )),
      ],
    };
  }
}

describe("GitHub Release completion", () => {
  test("binds standalone assets and rejects changed or missing published archives", async () => {
    const fixture = await receiptFixture();
    const root = join(fixture.receiptPath, "..");
    const notes = join(root, "docs/releases/v0.2.0.md");
    await mkdir(join(root, "docs/releases"), { recursive: true });
    await mkdir(join(root, "release/standalone"), { recursive: true });
    await writeFile(notes, "# Release\n");
    const archive = join(root, "release/standalone/example.tar.gz");
    await writeFile(archive, "reviewed archive");
    fixture.receipt.candidate.standalone = [
      {
        path: "release/standalone/example.tar.gz",
        sha256: new Bun.CryptoHasher("sha256")
          .update("reviewed archive")
          .digest("hex"),
      },
    ];
    await writeFile(fixture.receiptPath, JSON.stringify(fixture.receipt));
    const github = new FakeGitHub();
    await completeGitHubRelease(
      fixture.receipt,
      fixture.receiptPath,
      notes,
      github,
    );
    expect(github.release?.assets).toHaveLength(2);
    github.release?.assets.pop();
    await expect(
      completeGitHubRelease(
        fixture.receipt,
        fixture.receiptPath,
        notes,
        github,
      ),
    ).rejects.toThrow("standalone asset differs or is missing");
    await writeFile(archive, "changed");
    await expect(
      completeGitHubRelease(
        fixture.receipt,
        fixture.receiptPath,
        notes,
        github,
      ),
    ).rejects.toThrow("standalone asset drift");
  });
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
