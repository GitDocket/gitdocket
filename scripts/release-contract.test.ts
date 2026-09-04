import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildReleasePlan,
  collectReleaseSnapshot,
  parseReleasePlan,
  serializeReleasePlan,
  updateVersionSurfaces,
  validateReleaseIntent,
  validateReleaseSnapshot,
} from "./release-contract";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function put(root: string, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}

async function fixture(version = "0.2.0"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gitdocket-release-contract-"));
  roots.push(root);
  await put(
    root,
    "packages/core/src/version.ts",
    `export const DOCKET_VERSION = "${version}";\n`,
  );
  const definitions = [
    ["core", {}],
    ["web", { "@gitdocket/core": "workspace:*" }],
    [
      "cli",
      {
        "@gitdocket/core": "workspace:*",
        "@gitdocket/web": "workspace:*",
      },
    ],
    ["mcp", { "@gitdocket/core": "workspace:*" }],
  ] as const;
  for (const [id, dependencies] of definitions) {
    await put(
      root,
      `packages/${id}/package.json`,
      `${JSON.stringify(
        { name: `@gitdocket/${id}`, version, dependencies },
        null,
        2,
      )}\n`,
    );
  }
  await put(
    root,
    "bun.lock",
    `${definitions
      .map(
        ([id]) =>
          `"packages/${id}": { "name": "@gitdocket/${id}", "version": "${version}" }`,
      )
      .join("\n")}\n`,
  );
  await put(
    root,
    "packages/core/src/shipped-history.json",
    `${JSON.stringify([{ version, bodies: {} }])}\n`,
  );
  await put(root, "README.md", `GitDocket ${version}\n`);
  await put(
    root,
    "docs/getting-started.md",
    `The version command reports ${version}.\n`,
  );
  await put(
    root,
    `docs/releases/v${version}.md`,
    `# GitDocket ${version}\n\nA reviewed description of this release and its operational improvements.\n`,
  );
  const exportPaths = [
    `docs/releases/v${version}.md`,
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
  ].sort();
  await put(
    root,
    "release/public-export.json",
    `${JSON.stringify({ schema: 1, paths: exportPaths }, null, 2)}\n`,
  );
  return root;
}

const commit = "a".repeat(40);
const intent = {
  version: "0.2.0",
  channel: "latest",
  notesPath: "docs/releases/v0.2.0.md",
};

function gitFixture(options?: {
  dirty?: string;
  tag?: string;
  tracked?: boolean;
}) {
  return async (...args: string[]): Promise<string> => {
    if (args[0] === "rev-parse") return commit;
    if (args[0] === "status") return options?.dirty ?? "";
    if (args[0] === "tag") return options?.tag ?? "";
    if (args[0] === "ls-files") {
      if (options?.tracked === false) throw new Error("not tracked");
      return intent.notesPath;
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

describe("release intent and plan", () => {
  test("rejects malformed versions, channels, and notes paths", () => {
    expect(
      validateReleaseIntent({
        version: "v1",
        channel: "staged",
        notesPath: "../notes.md",
      }),
    ).toHaveLength(3);
    expect(
      validateReleaseIntent({
        version: "0.2.0-rc.0",
        channel: "next",
        notesPath: "docs/releases/v0.2.0-rc.0.md",
      }),
    ).toEqual(['version "0.2.0-rc.0" is not a supported stable SemVer']);
  });

  test("builds and round-trips one deterministic schema-1 plan", async () => {
    const root = await fixture();
    const snapshot = await collectReleaseSnapshot(root, intent, gitFixture());
    expect(validateReleaseSnapshot(snapshot, intent)).toEqual([]);

    const plan = buildReleasePlan(snapshot, intent);
    expect(plan.sourceCommit).toBe(commit);
    expect(plan.packages.map((item) => item.name)).toEqual([
      "@gitdocket/core",
      "@gitdocket/web",
      "@gitdocket/cli",
      "@gitdocket/mcp",
    ]);
    expect(plan.packages[2]?.dependencies).toEqual([
      "@gitdocket/core",
      "@gitdocket/web",
    ]);
    expect(parseReleasePlan(JSON.parse(serializeReleasePlan(plan)))).toEqual(
      plan,
    );
  });

  test("reports version, ledger, notes, manifest, and Git drift together", async () => {
    const root = await fixture("0.1.0");
    const snapshot = await collectReleaseSnapshot(
      root,
      intent,
      gitFixture({
        dirty: " M README.md",
        tag: "v0.2.0",
        tracked: false,
      }),
    );
    snapshot.exportPaths = [];
    snapshot.notesBody = "TODO";
    const issues = validateReleaseSnapshot(snapshot, intent);
    expect(issues.some((issue) => issue.includes("not clean"))).toBeTrue();
    expect(issues.some((issue) => issue.includes("already exists"))).toBeTrue();
    expect(issues.some((issue) => issue.includes("version.ts"))).toBeTrue();
    expect(issues.some((issue) => issue.includes("heads at 0.1.0"))).toBeTrue();
    expect(issues.some((issue) => issue.includes("not tracked"))).toBeTrue();
    expect(issues.some((issue) => issue.includes("placeholder"))).toBeTrue();
    expect(
      issues.some((issue) => issue.includes("does not allowlist")),
    ).toBeTrue();
  });

  test("rejects malformed and internally inconsistent plans", async () => {
    const root = await fixture();
    const plan = buildReleasePlan(
      await collectReleaseSnapshot(root, intent, gitFixture()),
      intent,
    );
    expect(() => parseReleasePlan({ ...plan, schema: 2 })).toThrow(
      "violates schema 1",
    );
    expect(() =>
      parseReleasePlan({
        ...plan,
        packages: plan.packages.map((item, index) =>
          index === 0 ? { ...item, version: "9.9.9" } : item,
        ),
      }),
    ).toThrow("package set or versions");
    expect(() =>
      parseReleasePlan({
        ...plan,
        notes: { ...plan.notes, sha256: "not-a-hash" },
      }),
    ).toThrow("evidence or checks");
  });
});

describe("version preparation", () => {
  test("updates coordinated surfaces and scaffolds allowlisted notes", async () => {
    const root = await fixture("0.1.0");
    await rm(join(root, "docs/releases/v0.1.0.md"));
    const manifest = JSON.parse(
      await readFile(join(root, "release/public-export.json"), "utf8"),
    ) as { schema: number; paths: string[] };
    manifest.paths = manifest.paths.filter(
      (path) => path !== "docs/releases/v0.1.0.md",
    );
    await writeFile(
      join(root, "release/public-export.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const result = await updateVersionSurfaces(root, "0.2.0");
    expect(result.previousVersion).toBe("0.1.0");
    expect(
      await readFile(join(root, "packages/core/src/version.ts"), "utf8"),
    ).toContain('"0.2.0"');
    expect(await readFile(join(root, "README.md"), "utf8")).toContain("0.2.0");
    expect(await readFile(join(root, "bun.lock"), "utf8")).not.toContain(
      '"version": "0.1.0"',
    );
    expect(
      JSON.parse(
        await readFile(join(root, "release/public-export.json"), "utf8"),
      ).paths,
    ).toContain("docs/releases/v0.2.0.md");
    expect(
      await readFile(join(root, "docs/releases/v0.2.0.md"), "utf8"),
    ).toContain("replace this comment");
  });

  test("rejects non-increasing or inconsistent versions before writing", async () => {
    const current = await fixture("0.2.0");
    await expect(updateVersionSurfaces(current, "0.1.9")).rejects.toThrow(
      "must be greater",
    );

    const inconsistent = await fixture("0.1.0");
    const webPath = join(inconsistent, "packages/web/package.json");
    await writeFile(
      webPath,
      (await readFile(webPath, "utf8")).replace("0.1.0", "9.9.9"),
    );
    const versionPath = join(inconsistent, "packages/core/src/version.ts");
    const before = await readFile(versionPath, "utf8");
    await expect(updateVersionSurfaces(inconsistent, "0.2.0")).rejects.toThrow(
      "packages/web/package.json is 9.9.9",
    );
    expect(await readFile(versionPath, "utf8")).toBe(before);
  });
});
