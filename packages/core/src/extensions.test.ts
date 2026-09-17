import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vector from "../../../examples/extensions/package-digest-vector.json";
import {
  inspectExtensionPackage,
  mutateExtension,
  readExtensions,
} from "./extensions";
import {
  applyExtensionTransaction,
  type ExtensionJournal,
  publishExtensionText,
} from "./extensions-transaction";
import type { ExtensionManifest, ExtensionRegistry } from "./extensions-types";
import {
  EXTENSION_JOURNAL_PATH,
  EXTENSION_REGISTRY_PATH,
  extensionHash,
} from "./extensions-validation";
import { LocalFileStore } from "./filestore";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(
  manifest: ExtensionManifest = structuredClone(
    vector.manifest,
  ) as ExtensionManifest,
  files: Record<string, string> = structuredClone(vector.files),
) {
  const root = await mkdtemp(join(tmpdir(), "docket-extensions-"));
  temporary.push(root);
  const bundle = join(root, "bundle");
  const source = join(root, "package");
  await mkdir(bundle);
  await mkdir(source);
  await writeFile(join(source, "extension.json"), JSON.stringify(manifest));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), text);
  }
  return { root, bundle, source, manifest, files };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), {
      withFileTypes: true,
    })) {
      const relative = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile())
        result[relative] = await readFile(join(root, relative), "utf8");
      else result[relative] = "[nonregular]";
    }
  }
  await walk("");
  return result;
}

async function registry(bundle: string): Promise<ExtensionRegistry> {
  return JSON.parse(
    await readFile(join(bundle, EXTENSION_REGISTRY_PATH), "utf8"),
  );
}

async function saveRegistry(bundle: string, value: ExtensionRegistry) {
  await writeFile(
    join(bundle, EXTENSION_REGISTRY_PATH),
    `${JSON.stringify(value)}\n`,
  );
}

async function installationJournal(
  source: string,
  bundle: string,
): Promise<ExtensionJournal> {
  const candidate = await inspectExtensionPackage(source, {
    bundleRoot: bundle,
  });
  expect(candidate.ok).toBe(true);
  const manifest = candidate.manifest as ExtensionManifest;
  const next: ExtensionRegistry = {
    formatVersion: 1,
    packages: {
      [manifest.id]: {
        manifest,
        digest: candidate.digest as string,
        base: candidate.files,
        status: "installed",
        requestedEnabled: true,
        config: {},
        bindings: {},
        reviewedLocal: {},
        retainedFiles: {},
      },
    },
  };
  return {
    formatVersion: 1,
    kind: "install",
    id: manifest.id,
    entries: [
      ...Object.entries(candidate.files).map(([path, text]) => ({
        path: `extensions/${manifest.id}/${path}`,
        before: null,
        after: text,
      })),
      {
        path: EXTENSION_REGISTRY_PATH,
        before: null,
        after: `${JSON.stringify(next)}\n`,
      },
    ],
  };
}

describe("workflow extension content and provenance", () => {
  test("exact published digest vector, empty optional feature, and inert inspection/dry-run", async () => {
    const { source, bundle } = await fixture();
    const initial = await snapshot(bundle);
    expect((await readExtensions(bundle)).packages).toEqual([]);
    const inspected = await inspectExtensionPackage(source, {
      bundleRoot: bundle,
      engineVersion: "0.4.0-dev.1",
    });
    expect(inspected.ok).toBe(true);
    expect(inspected.digest).toBe(vector.sha256);
    expect(inspected.digest).toBe(extensionHash(vector.payload));
    const result = await mutateExtension(
      bundle,
      { kind: "install", source, enable: true },
      { dryRun: true },
    );
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.inventory.workflows[0]?.identity).toBe("tiny:review");
    expect(await snapshot(bundle)).toEqual(initial);
    expect(await readdir(bundle)).toEqual([]);
  });

  test("pinned disabled/enable/configure/remove/reinstate survives the original source and a clone", async () => {
    const { source, bundle, root } = await fixture();
    expect(
      (await mutateExtension(bundle, { kind: "install", source })).inventory
        .packages[0]?.availability,
    ).toBe("disabled");
    expect(
      (
        await mutateExtension(bundle, {
          kind: "configure",
          id: "tiny",
          set: { reviewer: "release owner" },
        })
      ).ok,
    ).toBe(true);
    expect(
      (await mutateExtension(bundle, { kind: "enable", id: "tiny" })).inventory
        .workflows[0]?.identity,
    ).toBe("tiny:review");
    const before = await snapshot(bundle);
    const repeated = await mutateExtension(bundle, {
      kind: "install",
      source,
      enable: true,
    });
    expect(repeated.ok).toBe(true);
    expect(repeated.changed).toBe(false);
    expect(await snapshot(bundle)).toEqual(before);
    await mkdir(join(bundle, "delivery"));
    await writeFile(
      join(bundle, "delivery/completed.md"),
      "Completed project-owned evidence.\n",
    );
    const removed = await mutateExtension(bundle, {
      kind: "remove",
      id: "tiny",
    });
    expect(removed.inventory.packages[0]?.availability).toBe("removed");
    const stillRemoved = await mutateExtension(bundle, {
      kind: "install",
      source,
      enable: true,
    });
    expect(stillRemoved.inventory.packages[0]?.status).toBe("removed");
    const clone = join(root, "clone");
    await cp(bundle, clone, { recursive: true });
    await rm(source, { recursive: true });
    const reinstated = await mutateExtension(clone, {
      kind: "enable",
      id: "tiny",
    });
    expect(reinstated.ok).toBe(true);
    expect(reinstated.inventory.workflows).toHaveLength(1);
    expect(reinstated.inventory.packages[0]?.effectiveConfig.reviewer).toEqual({
      value: "release owner",
      owner: "project",
    });
    expect(await readFile(join(clone, "delivery/completed.md"), "utf8")).toBe(
      "Completed project-owned evidence.\n",
    );
  });

  test("project choices enforce finite scalar types, declared tool identifiers and unambiguous resets", async () => {
    const manifest = structuredClone(vector.manifest) as ExtensionManifest;
    manifest.defaults = {
      reviewer: "owner",
      limit: 2,
      strict: true,
      empty: null,
    };
    manifest.files.push("recipes/issues.md");
    manifest.capabilities = [
      {
        id: "read-issue",
        description: "Read one issue",
        access: "read",
        recipe: "recipes/issues.md",
      },
    ];
    const { source, bundle } = await fixture(manifest, {
      ...vector.files,
      "recipes/issues.md":
        "---\ntype: Reference\ntitle: Issue\ndescription: Read only\n---\nRead supplied issue.\n",
    });
    expect(
      (await mutateExtension(bundle, { kind: "install", source })).ok,
    ).toBe(true);
    const before = await snapshot(bundle);
    for (const set of [
      { unknown: 1 },
      { limit: "2" },
      { empty: false },
      { strict: null },
      { limit: Number.NaN },
      { reviewer: {} },
    ]) {
      const result = await mutateExtension(bundle, {
        kind: "configure",
        id: "tiny",
        set,
      } as unknown as Parameters<typeof mutateExtension>[1]);
      expect(result.ok).toBe(false);
      expect(await snapshot(bundle)).toEqual(before);
    }
    for (const bindings of [
      { unknown: "fixture.issue_get" },
      { "read-issue": "has whitespace" },
      { "read-issue": { command: "sh" } },
    ]) {
      expect(
        (
          await mutateExtension(bundle, {
            kind: "configure",
            id: "tiny",
            bindings,
          } as unknown as Parameters<typeof mutateExtension>[1])
        ).ok,
      ).toBe(false);
    }
    expect(
      (
        await mutateExtension(bundle, {
          kind: "configure",
          id: "tiny",
          set: { reviewer: "release owner" },
          reset: ["reviewer"],
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await mutateExtension(bundle, {
          kind: "configure",
          id: "tiny",
          set: { limit: 3 },
          bindings: { "read-issue": "fixture.issue_get" },
        })
      ).ok,
    ).toBe(true);
    const reset = await mutateExtension(bundle, {
      kind: "configure",
      id: "tiny",
      reset: ["limit"],
      unbind: ["read-issue"],
    });
    expect(reset.inventory.packages[0]?.effectiveConfig.limit).toEqual({
      value: 2,
      owner: "default",
    });
    expect(reset.inventory.packages[0]?.bindings).toEqual({});
  });

  test("prototype-shaped IDs/keys stay ordinary owned data", async () => {
    const manifest = structuredClone(vector.manifest) as ExtensionManifest;
    manifest.id = "constructor";
    manifest.defaults = { constructor: "owner", prototype: true };
    const { source, bundle } = await fixture(manifest);
    expect(
      (await mutateExtension(bundle, { kind: "install", source, enable: true }))
        .ok,
    ).toBe(true);
    const configured = await mutateExtension(bundle, {
      kind: "configure",
      id: "constructor",
      set: { constructor: "project", prototype: false },
    });
    expect(configured.ok).toBe(true);
    expect(
      configured.inventory.packages[0]?.effectiveConfig[
        "constructor" as string
      ],
    ).toEqual({ value: "project", owner: "project" });
    expect(
      (await mutateExtension(bundle, { kind: "enable", id: "toString" })).ok,
    ).toBe(false);
  });

  test("local edits withhold availability and survive repeats, retirement and hash-specific review", async () => {
    const { source, bundle } = await fixture();
    await mutateExtension(bundle, { kind: "install", source, enable: true });
    const path = join(bundle, "extensions/tiny/workflows/review.md");
    const adapted = `${vector.files["workflows/review.md"]}\nRequire project approval.\n`;
    await writeFile(path, adapted);
    let current = await readExtensions(bundle);
    expect(current.packages[0]?.availability).toBe("review-required");
    expect(current.workflows).toEqual([]);
    expect(
      (await mutateExtension(bundle, { kind: "install", source })).changed,
    ).toBe(false);
    expect(
      (await mutateExtension(bundle, { kind: "enable", id: "tiny" })).ok,
    ).toBe(false);
    const saved = await registry(bundle);
    const tiny = saved.packages.tiny;
    if (!tiny) throw new Error("Missing fixture package");
    tiny.reviewedLocal["workflows/review.md"] = extensionHash(adapted);
    await saveRegistry(bundle, saved);
    current = await readExtensions(bundle);
    expect(current.packages[0]?.availability).toBe("available");
    expect(current.packages[0]?.adaptedPaths).toEqual(["workflows/review.md"]);
    await writeFile(path, `${adapted}\nAnother change.\n`);
    expect((await readExtensions(bundle)).packages[0]?.availability).toBe(
      "review-required",
    );
    expect(
      (await mutateExtension(bundle, { kind: "remove", id: "tiny" })).ok,
    ).toBe(true);
    expect(await readFile(path, "utf8")).toContain("Another change.");
  });

  test("unknown base, missing active source, unowned source and incompatible engine fail closed", async () => {
    const { source, bundle } = await fixture();
    await mutateExtension(bundle, { kind: "install", source, enable: true });
    const known = await registry(bundle);
    const corrupt = structuredClone(known);
    const tiny = corrupt.packages.tiny;
    if (!tiny) throw new Error("Missing fixture package");
    tiny.base["workflows/review.md"] += "Corrupt base\n";
    await saveRegistry(bundle, corrupt);
    expect((await readExtensions(bundle)).packages[0]?.availability).toBe(
      "invalid",
    );
    expect(
      (await mutateExtension(bundle, { kind: "enable", id: "tiny" })).ok,
    ).toBe(false);
    await saveRegistry(bundle, known);
    const incompatible = await readExtensions(bundle, {
      engineVersion: "1.0.0",
    });
    expect(incompatible.packages[0]?.availability).toBe("incompatible");
    expect(incompatible.workflows).toEqual([]);
    await writeFile(join(bundle, "extensions/tiny/notes.md"), "Unowned\n");
    expect((await readExtensions(bundle)).packages[0]?.availability).toBe(
      "invalid",
    );
    await rm(join(bundle, "extensions/tiny/notes.md"));
    await rm(join(bundle, "extensions/tiny/workflows/review.md"));
    expect((await readExtensions(bundle)).packages[0]?.availability).toBe(
      "invalid",
    );
  });

  test("republished content and unowned byte-identical destinations are inert failures", async () => {
    const { source, bundle } = await fixture();
    await mkdir(join(bundle, "extensions"));
    await cp(source, join(bundle, "extensions/tiny"), { recursive: true });
    const collision = await snapshot(bundle);
    expect(
      (await mutateExtension(bundle, { kind: "install", source })).ok,
    ).toBe(false);
    expect(await snapshot(bundle)).toEqual(collision);
    await rm(join(bundle, "extensions/tiny"), { recursive: true });
    expect(
      (await mutateExtension(bundle, { kind: "install", source })).ok,
    ).toBe(true);
    const installed = await snapshot(bundle);
    await writeFile(
      join(source, "workflows/review.md"),
      `${vector.files["workflows/review.md"]}\nChanged publication\n`,
    );
    const republished = await mutateExtension(bundle, {
      kind: "install",
      source,
    });
    expect(
      republished.diagnostics.some(
        (entry) => entry.code === "republished-version",
      ),
    ).toBe(true);
    expect(await snapshot(bundle)).toEqual(installed);
  });
});

describe("malformed packages and safe path boundaries", () => {
  test("BOM-prefixed sources are rejected without silently dropping exact UTF-8 bytes", async () => {
    const { source, bundle } = await fixture();
    const exact = `\uFEFF${vector.files["workflows/review.md"]}`;
    await writeFile(join(source, "workflows/review.md"), exact);
    const inspection = await inspectExtensionPackage(source, {
      bundleRoot: bundle,
    });
    expect(inspection.ok).toBe(false);
    expect(inspection.files["workflows/review.md"]).toBe(exact);
    expect(
      inspection.diagnostics.some((entry) => entry.code === "unsupported-bom"),
    ).toBe(true);
    expect(
      (await mutateExtension(bundle, { kind: "install", source })).ok,
    ).toBe(false);
    expect(await readdir(bundle)).toEqual([]);
    expect(await readFile(join(source, "workflows/review.md"), "utf8")).toBe(
      exact,
    );
  });
  test("rejects unknown format/keys, unsupported IDs/versions, malformed concepts and undeclared content before writes", async () => {
    for (const patch of [
      { formatVersion: 2 },
      { scripts: { install: "touch should-not-exist" } },
      { id: "docket-anything" },
      { version: "1.0.0-beta" },
      { engine: { min: "9.0.0", maxExclusive: "10.0.0" } },
    ]) {
      const { source, bundle, manifest } = await fixture();
      await writeFile(
        join(source, "extension.json"),
        JSON.stringify({ ...manifest, ...patch }),
      );
      if ("formatVersion" in patch)
        expect(
          (await inspectExtensionPackage(source, { bundleRoot: bundle }))
            .compatibility,
        ).toBe("incompatible");
      expect(
        (
          await mutateExtension(bundle, {
            kind: "install",
            source,
            enable: true,
          })
        ).ok,
      ).toBe(false);
      expect(await readdir(bundle)).toEqual([]);
    }
    const { source, bundle } = await fixture();
    for (const sourceText of [
      "No frontmatter\n",
      vector.files["workflows/review.md"].replace(
        "type: Workflow",
        "type: Task\nid: BEC-2\nstatus: done",
      ),
      vector.files["workflows/review.md"].replace("title: Review\n", ""),
      vector.files["workflows/review.md"].replace(
        "type: Workflow",
        "type: Workflow\ntags: 42",
      ),
      vector.files["workflows/review.md"].replace(
        "type: Workflow",
        "type: Workflow\naliases: false",
      ),
      `${vector.files["workflows/review.md"]}\n<!-- >>> docket@0.4.0 >>>\n`,
    ]) {
      await writeFile(join(source, "workflows/review.md"), sourceText);
      expect(
        (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
      ).toBe(false);
    }
    await writeFile(
      join(source, "workflows/review.md"),
      vector.files["workflows/review.md"],
    );
    await writeFile(join(source, "run.sh"), "touch never-executed\n");
    expect(
      (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
    ).toBe(false);
    expect(await readdir(bundle)).toEqual([]);
  });

  test("rejects escaping/hidden/reserved/case-colliding paths, executable content, invalid UTF-8 and limits", async () => {
    for (const path of [
      "../outside.md",
      "/workflows/read.md",
      "workflows/../read.md",
      "workflows/.hidden.md",
      "workflows\\read.md",
      "workflows/index.md",
      "workflows/log.md",
      "workflows/overview.md",
    ]) {
      const { source, bundle, manifest } = await fixture();
      manifest.files = [path];
      manifest.workflows[0] = {
        id: "review",
        title: "Review",
        description: "Review",
        path,
      };
      await writeFile(join(source, "extension.json"), JSON.stringify(manifest));
      expect(
        (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
      ).toBe(false);
    }
    const { source, bundle, manifest } = await fixture();
    manifest.files.push("workflows/REVIEW.md");
    await writeFile(join(source, "extension.json"), JSON.stringify(manifest));
    expect(
      (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
    ).toBe(false);
    manifest.files.pop();
    await writeFile(join(source, "extension.json"), JSON.stringify(manifest));
    await chmod(join(source, "workflows/review.md"), 0o755);
    expect(
      (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
    ).toBe(false);
    await chmod(join(source, "workflows/review.md"), 0o644);
    await writeFile(
      join(source, "workflows/review.md"),
      Buffer.from([0xc3, 0x28]),
    );
    expect(
      (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
    ).toBe(false);
    await writeFile(
      join(source, "workflows/review.md"),
      "a".repeat(256 * 1024 + 1),
    );
    expect(
      (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
    ).toBe(false);
  });

  test("validates relative/reference/image and bundle links without acquiring shared ownership", async () => {
    const { source, bundle } = await fixture();
    await mkdir(join(bundle, "reference"));
    await writeFile(
      join(bundle, "reference/shared.md"),
      "---\ntype: Reference\ntitle: Shared\ndescription: Project guidance\n---\nShared requirement.\n",
    );
    const valid = `${vector.files["workflows/review.md"]}\n[Shared](/reference/shared.md) [self](review.md#step) [external](https://example.invalid/no-network)\n`;
    await writeFile(join(source, "workflows/review.md"), valid);
    expect(
      (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
    ).toBe(true);
    const shared = await readFile(join(bundle, "reference/shared.md"), "utf8");
    for (const link of [
      "[missing](absent.md)",
      "![image](missing.png)",
      "[missing][ref]\n\n[ref]: /reference/absent.md",
      "[escape](../../reference/shared.md)",
      "[encoded](%2e%2e/%2e%2e/outside.md)",
    ]) {
      await writeFile(
        join(source, "workflows/review.md"),
        `${valid}\n${link}\n`,
      );
      expect(
        (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
      ).toBe(false);
    }
    expect(await readFile(join(bundle, "reference/shared.md"), "utf8")).toBe(
      shared,
    );
  });

  test("symlink source, target, registry and link ancestors are never followed for writes", async () => {
    const { source, bundle, root } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(
      join(outside, "review.md"),
      vector.files["workflows/review.md"],
    );
    await rm(join(source, "workflows/review.md"));
    await symlink(
      join(outside, "review.md"),
      join(source, "workflows/review.md"),
    );
    expect(
      (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
    ).toBe(false);
    await rm(join(source, "workflows/review.md"));
    await writeFile(
      join(source, "workflows/review.md"),
      vector.files["workflows/review.md"],
    );
    await symlink(outside, join(bundle, "extensions"));
    const initial = await snapshot(outside);
    expect(
      (await mutateExtension(bundle, { kind: "install", source })).ok,
    ).toBe(false);
    expect(await snapshot(outside)).toEqual(initial);
    await rm(join(bundle, "extensions"));
    await symlink(outside, join(bundle, "reference"));
    await writeFile(
      join(source, "workflows/review.md"),
      `${vector.files["workflows/review.md"]}\n[Linked](/reference/review.md)\n`,
    );
    expect(
      (await inspectExtensionPackage(source, { bundleRoot: bundle })).ok,
    ).toBe(false);
  });

  test("native concatenation collisions retain both valid canonical workflows", async () => {
    const a = structuredClone(vector.manifest) as ExtensionManifest;
    a.id = "alpha-beta";
    if (a.workflows[0]) a.workflows[0].id = "gamma";
    const first = await fixture(a);
    expect(
      (
        await mutateExtension(first.bundle, {
          kind: "install",
          source: first.source,
          enable: true,
        })
      ).ok,
    ).toBe(true);
    const b = structuredClone(a);
    b.id = "alpha";
    if (b.workflows[0]) b.workflows[0].id = "beta-gamma";
    const second = await fixture(b);
    const result = await mutateExtension(first.bundle, {
      kind: "install",
      source: second.source,
      enable: true,
    });
    expect(result.ok).toBe(true);
    expect(result.inventory.workflows.map((entry) => entry.identity)).toEqual([
      "alpha:beta-gamma",
      "alpha-beta:gamma",
    ]);
    expect(
      result.inventory.diagnostics.some(
        (entry) => entry.code === "native-name-collision",
      ),
    ).toBe(true);
  });
});

describe("serialized publication and validated recovery", () => {
  test("dry-run and publication reject the same unknown provenance without reporting a change", async () => {
    const { source, bundle } = await fixture();
    await mutateExtension(bundle, { kind: "install", source, enable: true });
    const corrupt = await registry(bundle);
    if (!corrupt.packages.tiny) throw new Error("Missing package");
    corrupt.packages.tiny.digest = "0".repeat(64);
    await saveRegistry(bundle, corrupt);
    const before = await snapshot(bundle);
    const operations: Parameters<typeof mutateExtension>[1][] = [
      { kind: "disable", id: "tiny" },
      { kind: "remove", id: "tiny" },
      { kind: "configure", id: "tiny", set: { reviewer: "changed" } },
    ];
    for (const operation of operations)
      for (const dryRun of [true, false]) {
        const result = await mutateExtension(bundle, operation, { dryRun });
        expect(result.ok).toBe(false);
        expect(result.changed).toBe(false);
        expect(
          result.diagnostics.some((entry) => entry.code === "unknown-base"),
        ).toBe(true);
        expect(await snapshot(bundle)).toEqual(before);
      }
  });

  test("a concurrent registry edit cannot be adopted as the prior bytes of a stale configuration plan", async () => {
    const manifest = structuredClone(vector.manifest) as ExtensionManifest;
    manifest.defaults.testCommand = "bun test";
    const { source, bundle } = await fixture(manifest);
    await mutateExtension(bundle, { kind: "install", source });
    const originalText = await readFile(
      join(bundle, EXTENSION_REGISTRY_PATH),
      "utf8",
    );
    const original = await registry(bundle);
    const planned = structuredClone(original);
    if (!planned.packages.tiny) throw new Error("Missing package");
    planned.packages.tiny.config.reviewer = "new owner";
    const journal: ExtensionJournal = {
      formatVersion: 1,
      kind: "configure",
      id: "tiny",
      entries: [
        {
          path: EXTENSION_REGISTRY_PATH,
          before: originalText,
          after: JSON.stringify(planned),
        },
      ],
    };
    if (!original.packages.tiny) throw new Error("Missing package");
    original.packages.tiny.config.testCommand = "bun run verify";
    await saveRegistry(bundle, original);
    const before = await snapshot(bundle);
    const applied = await applyExtensionTransaction(bundle, journal);
    expect(applied.ok).toBe(false);
    expect(applied.rollback).toBeUndefined();
    expect(
      applied.diagnostics.some((entry) => entry.code === "recovery-conflict"),
    ).toBe(true);
    expect(await snapshot(bundle)).toEqual(before);
  });

  test("absolute owned links cannot escape validation of malformed retained content", async () => {
    const { source, bundle } = await fixture();
    await mutateExtension(bundle, { kind: "install", source, enable: true });
    const saved = await registry(bundle);
    const tiny = saved.packages.tiny;
    if (!tiny) throw new Error("Missing package");
    const invalid =
      "---\ntype: Task\ntitle: Invalid package history\ndescription: Has lifecycle state\nid: DKT-9\nstatus: done\n---\nOwned historical bytes\n";
    tiny.retainedFiles["templates/old.md"] = {
      base: invalid,
      baseHash: extensionHash(invalid),
      sourceVersion: "0.9.0",
      sourceDigest: "a".repeat(64),
    };
    await mkdir(join(bundle, "extensions/tiny/templates"));
    await writeFile(join(bundle, "extensions/tiny/templates/old.md"), invalid);
    const active = `${vector.files["workflows/review.md"]}\n[Historical template](/extensions/tiny/templates/old.md)\n`;
    await writeFile(
      join(bundle, "extensions/tiny/workflows/review.md"),
      active,
    );
    tiny.reviewedLocal["workflows/review.md"] = extensionHash(active);
    await saveRegistry(bundle, saved);
    const current = await readExtensions(bundle);
    expect(current.packages[0]?.availability).toBe("invalid");
    expect(current.workflows).toEqual([]);
    expect(
      current.packages[0]?.diagnostics.some(
        (entry) => entry.code === "broken-link" && entry.severity === "error",
      ),
    ).toBe(true);
    await writeFile(
      join(bundle, "extensions/tiny/templates/old.md"),
      "---\ntype: Reference\ntitle: Historical source\ndescription: Broken historical dependency\n---\n[Missing](absent.md)\n",
    );
    expect((await readExtensions(bundle)).packages[0]?.availability).toBe(
      "invalid",
    );
  });

  test("ordinary disk failure restores all prior bytes and permits a clean retry", async () => {
    const { source, bundle } = await fixture();
    const journal = await installationJournal(source, bundle);
    let writes = 0;
    const result = await applyExtensionTransaction(
      bundle,
      journal,
      async (root, path, text) => {
        writes += 1;
        if (writes === 3)
          throw new Error("Injected registry publication failure");
        await publishExtensionText(root, path, text);
      },
    );
    expect(result.ok).toBe(false);
    expect(result.rollback).toBe("complete");
    expect(await snapshot(bundle)).toEqual({});
    expect(
      await lstat(join(bundle, "extensions/tiny")).catch(() => null),
    ).toBeNull();
    expect(
      (await mutateExtension(bundle, { kind: "install", source, enable: true }))
        .ok,
    ).toBe(true);
  });

  test("interrupted transaction makes availability pending; dry-run predicts and recovery rolls back", async () => {
    const { source, bundle } = await fixture();
    const journal = await installationJournal(source, bundle);
    await publishExtensionText(
      bundle,
      EXTENSION_JOURNAL_PATH,
      JSON.stringify(journal),
    );
    for (const entry of journal.entries)
      await publishExtensionText(bundle, entry.path, entry.after as string);
    const pending = await readExtensions(bundle);
    expect(pending.pendingTransaction).toBe(true);
    expect(pending.packages[0]?.availability).toBe("pending-recovery");
    expect(pending.workflows).toEqual([]);
    const initial = await snapshot(bundle);
    expect(
      (await mutateExtension(bundle, { kind: "disable", id: "tiny" })).ok,
    ).toBe(false);
    const dry = await mutateExtension(
      bundle,
      { kind: "recover" },
      { dryRun: true },
    );
    expect(dry.ok).toBe(true);
    expect(dry.inventory.packages).toEqual([]);
    expect(await snapshot(bundle)).toEqual(initial);
    expect((await mutateExtension(bundle, { kind: "recover" })).ok).toBe(true);
    expect(await snapshot(bundle)).toEqual({});
    expect((await mutateExtension(bundle, { kind: "recover" })).changed).toBe(
      false,
    );
  });

  test("unexpected edits block every rollback write and ordinary failure preserves a recovery journal", async () => {
    const { source, bundle } = await fixture();
    const journal = await installationJournal(source, bundle);
    const content = journal.entries[0];
    if (!content) throw new Error("No content entry");
    let writes = 0;
    const result = await applyExtensionTransaction(
      bundle,
      journal,
      async (root, path, text) => {
        writes += 1;
        if (writes === 3) {
          await writeFile(
            join(root, content.path),
            "Concurrent authored edit\n",
          );
          throw new Error("Injected concurrent failure");
        }
        await publishExtensionText(root, path, text);
      },
    );
    expect(result.rollback).toBe("pending");
    const before = await snapshot(bundle);
    expect((await mutateExtension(bundle, { kind: "recover" })).ok).toBe(false);
    expect(await snapshot(bundle)).toEqual(before);
    await writeFile(join(bundle, content.path), content.after as string);
    expect((await mutateExtension(bundle, { kind: "recover" })).ok).toBe(true);
  });

  test("tampered journal ownership, unknown bytes and symlink targets cannot authorize rollback", async () => {
    const { source, bundle, root } = await fixture();
    const original = await installationJournal(source, bundle);
    await writeFile(join(root, "unrelated.md"), "Keep me\n");
    for (const replacement of [
      "../unrelated.md",
      "extensions/other/workflows/review.md",
      "extensions/tiny/workflows/../review.md",
    ]) {
      const journal = structuredClone(original);
      if (journal.entries[0]) journal.entries[0].path = replacement;
      await publishExtensionText(
        bundle,
        EXTENSION_JOURNAL_PATH,
        JSON.stringify(journal),
      );
      const before = await snapshot(bundle);
      expect((await mutateExtension(bundle, { kind: "recover" })).ok).toBe(
        false,
      );
      expect(await snapshot(bundle)).toEqual(before);
    }
    await publishExtensionText(
      bundle,
      EXTENSION_JOURNAL_PATH,
      JSON.stringify(original),
    );
    await mkdir(join(bundle, "extensions/tiny"));
    await symlink(root, join(bundle, "extensions/tiny/workflows"));
    expect((await mutateExtension(bundle, { kind: "recover" })).ok).toBe(false);
    expect(await readFile(join(root, "unrelated.md"), "utf8")).toBe(
      "Keep me\n",
    );
  });

  test("shared mutation lock covers preflight and no-op operations", async () => {
    const { source, bundle } = await fixture();
    const store = new LocalFileStore(bundle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holding = store.withMutation(async () => {
      locked();
      await gate;
    });
    await acquired;
    let finished = false;
    const installing = mutateExtension(bundle, {
      kind: "install",
      source,
    }).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    release();
    await holding;
    expect((await installing).ok).toBe(true);
  });

  test("retained history remains owned while missing inactive sources do not hide active workflows", async () => {
    const { source, bundle } = await fixture();
    await mutateExtension(bundle, { kind: "install", source, enable: true });
    const saved = await registry(bundle);
    const tiny = saved.packages.tiny;
    if (!tiny) throw new Error("Missing package");
    tiny.retainedFiles["templates/retired.md"] = {
      base: "---\ntype: Reference\ntitle: Old\ndescription: Historical record instructions\n---\nOld body\n",
      baseHash: extensionHash(
        "---\ntype: Reference\ntitle: Old\ndescription: Historical record instructions\n---\nOld body\n",
      ),
      sourceVersion: "0.9.0",
      sourceDigest: "a".repeat(64),
    };
    await saveRegistry(bundle, saved);
    let current = await readExtensions(bundle);
    expect(current.packages[0]?.availability).toBe("available");
    expect(
      current.packages[0]?.diagnostics.some(
        (entry) =>
          entry.code === "source-unreadable" && entry.severity === "warning",
      ),
    ).toBe(true);
    const active = `${vector.files["workflows/review.md"]}\n[retired](../templates/retired.md)\n`;
    await writeFile(
      join(bundle, "extensions/tiny/workflows/review.md"),
      active,
    );
    tiny.reviewedLocal["workflows/review.md"] = extensionHash(active);
    await saveRegistry(bundle, saved);
    current = await readExtensions(bundle);
    expect(current.packages[0]?.availability).toBe("invalid");
  });
});
