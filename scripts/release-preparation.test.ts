import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PRIVATE_RELEASE_CHECKS,
  RELEASE_PACKAGE_DEFINITIONS,
} from "./release-contract";
import { capture } from "./release-operator";
import {
  createWorkspace,
  publicReviewDiff,
  qualifyRelease,
  reviewPacket,
  validateQualificationConfig,
} from "./release-preparation";
import { sha256 } from "./release-stage";

function planFixture() {
  const version = "0.5.1";
  return {
    schema: 1,
    version,
    channel: "latest",
    holdingTag: "staged",
    sourceCommit: "a".repeat(40),
    sourceTag: `v${version}`,
    publicRepository: "GitDocket/gitdocket",
    notes: { path: `docs/releases/v${version}.md`, sha256: "b".repeat(64) },
    exportManifest: {
      path: "release/public-export.json",
      sha256: "c".repeat(64),
    },
    packages: RELEASE_PACKAGE_DEFINITIONS.map((definition) => ({
      ...definition,
      version,
      dependencies: [...definition.dependencies],
      tarball: `release/tarballs/gitdocket-${definition.id}-${version}.tgz`,
    })),
    checks: [...PRIVATE_RELEASE_CHECKS],
    approval: {
      required: true,
      boundary: "public-commit-tag-registry-and-github-release",
    },
  };
}

test("workspace pins tools, preserves exact Git identities, and refuses to overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-workspace-test-"));
  const repo = join(root, "repo");
  const workspace = join(root, "workspace");
  try {
    await mkdir(repo);
    capture(["git", "init", "-q", repo]);
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "workspace-fixture", private: true }),
    );
    capture([process.execPath, "install"], repo);
    await writeFile(
      join(repo, ".gitdocket-source.json"),
      "retained provenance\n",
    );
    capture(["git", "add", "."], repo);
    capture(
      [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      repo,
    );
    const commit = capture(["git", "rev-parse", "HEAD"], repo);
    await createWorkspace(repo, {
      directory: workspace,
      ref: commit,
      publicRepository: repo,
    });
    const receipt = JSON.parse(
      await readFile(join(workspace, "workspace.json"), "utf8"),
    );
    expect(receipt.commit).toBe(commit);
    expect(receipt.publicBaseline).toBe(commit);
    expect(receipt.externalWrites).toBe(false);
    expect(
      await readFile(join(workspace, "public/.gitdocket-source.json"), "utf8"),
    ).toBe("retained provenance\n");
    await expect(
      createWorkspace(repo, {
        directory: workspace,
        ref: commit,
        publicRepository: repo,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qualification rejects wrong Linux source before compute and retains a resumable failure receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-qualify-test-"));
  try {
    const source = join(root, "export");
    const linux = join(root, "linux");
    await mkdir(source);
    await mkdir(linux);
    const plan = planFixture();
    await writeFile(join(root, "plan.json"), JSON.stringify(plan));
    await writeFile(
      join(source, ".gitdocket-source.json"),
      JSON.stringify({ sourceCommit: plan.sourceCommit }),
    );
    await writeFile(
      join(linux, "linux-arm64.json"),
      JSON.stringify({
        target: "linux-arm64",
        version: plan.version,
        source: {
          kind: "public-export",
          commit: "d".repeat(40),
          exportSha256: "e".repeat(64),
        },
      }),
    );
    let computed = false;
    const output = join(root, "qualify.json");
    await expect(
      qualifyRelease(
        {
          source,
          plan: join(root, "plan.json"),
          linuxArtifacts: linux,
          mode: "verify",
        },
        output,
        {
          run: async () => {
            computed = true;
          },
        },
      ),
    ).rejects.toThrow("Linux artifacts");
    expect(computed).toBe(false);
    const receipt = JSON.parse(await readFile(output, "utf8"));
    expect(receipt.status).toBe("FAILED");
    expect(receipt.externalWrites).toBe(false);
    expect(receipt.resume).toContain(`${output}.config.json`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qualification sequences import, archive verification, packing and Mac evidence; stops on checksum drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-qualify-sequence-"));
  try {
    const source = join(root, "export");
    const linux = join(root, "linux");
    await mkdir(source);
    await mkdir(linux);
    const plan = planFixture();
    const state = JSON.stringify({ sourceCommit: plan.sourceCommit });
    await writeFile(join(root, "plan.json"), JSON.stringify(plan));
    await writeFile(join(source, ".gitdocket-source.json"), state);
    for (const target of ["linux-arm64", "linux-x64"]) {
      const archive = `gitdocket-${plan.version}-${target}.tar.gz`;
      await writeFile(join(linux, archive), "fixture archive");
      await writeFile(join(linux, `${archive}.sha256`), "fixture checksum");
      await writeFile(
        join(linux, `${target}.json`),
        JSON.stringify({
          target,
          version: plan.version,
          archive,
          sha256: sha256("fixture archive"),
          source: {
            kind: "public-export",
            commit: plan.sourceCommit,
            exportSha256: sha256(state),
          },
        }),
      );
    }
    const steps: string[] = [];
    const config = {
      source,
      plan: join(root, "plan.json"),
      linuxArtifacts: linux,
      mode: "verify" as const,
    };
    const output = join(root, "qualify.json");
    await qualifyRelease(config, output, {
      run: async (args) => {
        steps.push(args[1] as string);
      },
      verify: async () => {
        steps.push("verify archives");
        return [];
      },
      verifyMac: async () => {
        steps.push("verify Mac channels");
      },
    });
    expect(steps).toEqual([
      "verify archives",
      "scripts/release-pack.ts",
      "verify Mac channels",
    ]);
    expect(JSON.parse(await readFile(output, "utf8")).status).toBe("READY");
    await writeFile(
      join(linux, `gitdocket-${plan.version}-linux-x64.tar.gz`),
      "different",
    );
    await expect(qualifyRelease(config, output)).rejects.toThrow(
      "checksum differs",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packet rejects an unbound stage before any registry observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-packet-test-"));
  try {
    await writeFile(join(root, "plan.json"), JSON.stringify(planFixture()));
    await writeFile(
      join(root, "stage.json"),
      JSON.stringify({ schema: 1, approvalReady: true }),
    );
    let inspected = false;
    await expect(
      reviewPacket(
        {
          plan: join(root, "plan.json"),
          stage: join(root, "stage.json"),
          destination: root,
          output: join(root, "packet.md"),
        },
        {
          inspect: async () => {
            inspected = true;
            return { version: null, distTags: {} };
          },
        },
      ),
    ).rejects.toThrow("stage receipt violates");
    expect(inspected).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qualification configuration rejects ambiguous paths and incomplete architecture toolchains", () => {
  expect(() =>
    validateQualificationConfig({
      source: "relative",
      plan: "/plan",
      linuxArtifacts: "/linux",
      mode: "verify",
    }),
  ).toThrow("absolute");
  expect(() =>
    validateQualificationConfig({
      source: "/source",
      plan: "/plan",
      linuxArtifacts: "/linux",
      mode: "build",
    }),
  ).toThrow();
});

test("review diff includes added files and tracked edits without modifying the real index", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-diff-test-"));
  try {
    capture(["git", "init", "-q", root]);
    await writeFile(join(root, "existing.txt"), "old\n");
    capture(["git", "add", "."], root);
    capture(
      [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      root,
    );
    await writeFile(join(root, "existing.txt"), "new\n");
    await writeFile(join(root, "added.txt"), "new file\n");
    const before = capture(["git", "status", "--porcelain"], root);
    const diff = publicReviewDiff(root, "HEAD");
    expect(diff).toContain("+new file");
    expect(diff).toContain("-old");
    expect(capture(["git", "status", "--porcelain"], root)).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
