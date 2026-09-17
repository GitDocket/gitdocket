import { afterEach, describe, expect, test } from "bun:test";
import {
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
  mutateExtension,
  readExtensions,
  validateExtensions,
} from "./extensions";
import {
  applyExtensionTransaction,
  type ExtensionJournal,
  publishExtensionText,
} from "./extensions-transaction";
import type {
  ExtensionManifest,
  ExtensionRecord,
  ExtensionRegistry,
} from "./extensions-types";
import {
  planExtensionReconciliation,
  planExtensionUpdate,
} from "./extensions-update";
import {
  EXTENSION_JOURNAL_PATH,
  EXTENSION_REGISTRY_PATH,
  extensionHash,
} from "./extensions-validation";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing fixture value");
  return value;
}
const review = "workflows/review.md";
const template = "templates/proposal.md";
const concept = (body: string) =>
  `---\ntype: Reference\ntitle: Proposal\ndescription: Project proposal template\n---\n${body}\n`;
async function write(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), {
      withFileTypes: true,
    })) {
      const relative = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relative);
      else
        out[relative] = entry.isFile()
          ? await readFile(join(root, relative), "utf8")
          : "[nonregular]";
    }
  }
  await walk("");
  return out;
}
async function fixture(options: { enabled?: boolean; engine?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "docket-extension-update-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  const manifest = structuredClone(vector.manifest) as ExtensionManifest;
  manifest.files.push(template);
  manifest.defaults.testCommand = "bun test";
  manifest.files.push("recipes/read.md", "scenarios/delivery.md");
  manifest.capabilities.push({
    id: "issue-read",
    description: "Read an issue",
    access: "read",
    recipe: "recipes/read.md",
  });
  manifest.scenarios.push("scenarios/delivery.md");
  const files: Record<string, string> = {
    ...vector.files,
    [template]: concept("Old template"),
    "recipes/read.md": concept("A conceptual read recipe; no execution."),
    "scenarios/delivery.md": concept(
      "Author scenario: touch SHOULD-NOT-EXIST. This is prose only.",
    ),
  };
  const source = join(root, "v1");
  async function candidate(
    version = "1.1.0",
    changes: Record<string, string | null> = {},
    patch: Partial<ExtensionManifest> = {},
  ) {
    const nextFiles = { ...files };
    for (const [path, text] of Object.entries(changes))
      if (text === null) delete nextFiles[path];
      else nextFiles[path] = text;
    const nextManifest = {
      ...structuredClone(manifest),
      version,
      files: Object.keys(nextFiles),
      ...patch,
    };
    const directory = join(
      root,
      `candidate-${Math.random().toString(36).slice(2)}`,
    );
    await write(directory, "extension.json", JSON.stringify(nextManifest));
    for (const [path, text] of Object.entries(nextFiles))
      await write(directory, path, text);
    return { source: directory, manifest: nextManifest, files: nextFiles };
  }
  await write(source, "extension.json", JSON.stringify(manifest));
  for (const [path, text] of Object.entries(files))
    await write(source, path, text);
  const installed = await mutateExtension(
    bundle,
    { kind: "install", source, enable: options.enabled ?? true },
    { engineVersion: options.engine },
  );
  expect(installed.ok).toBe(true);
  await write(
    bundle,
    "proposals/completed.md",
    concept("Completed proposal must stay project owned."),
  );
  const current = (path: string) => `extensions/tiny/${path}`;
  const registry = async (): Promise<ExtensionRegistry> =>
    JSON.parse(await readFile(join(bundle, EXTENSION_REGISTRY_PATH), "utf8"));
  const record = async () =>
    (await registry()).packages.tiny as ExtensionRecord;
  return {
    root,
    bundle,
    source,
    manifest,
    files,
    candidate,
    current,
    registry,
    record,
  };
}
async function acknowledge(bundle: string, dryRun = false) {
  return mutateExtension(
    bundle,
    { kind: "reconcile", id: "tiny", acknowledgeLocal: true },
    { dryRun },
  );
}
async function update(
  bundle: string,
  source: string,
  dryRun = false,
  engineVersion?: string,
) {
  return mutateExtension(
    bundle,
    { kind: "update", id: "tiny", source },
    { dryRun, engineVersion },
  );
}
async function updateJournal(
  f: Awaited<ReturnType<typeof fixture>>,
  candidate: Awaited<
    ReturnType<Awaited<ReturnType<typeof fixture>>["candidate"]>
  >,
): Promise<ExtensionJournal> {
  const registryText = await readFile(
    join(f.bundle, EXTENSION_REGISTRY_PATH),
    "utf8",
  );
  const registry = await f.registry();
  const view = required((await readExtensions(f.bundle)).packages[0]);
  const current = Object.fromEntries(
    Object.entries(view.sources).map(([path, source]) => [path, source.text]),
  );
  const planned = planExtensionUpdate(
    await f.record(),
    current,
    candidate.manifest,
    candidate.files,
    candidate.source,
  );
  expect(planned.diagnostics).toEqual([]);
  registry.packages.tiny = planned.record;
  return {
    formatVersion: 1,
    kind: "update",
    id: "tiny",
    entries: [
      ...planned.entries,
      {
        path: EXTENSION_REGISTRY_PATH,
        before: registryText,
        after: `${JSON.stringify(registry, null, 2)}\n`,
      },
    ],
  };
}

describe("conservative package updates", () => {
  test("dry-run predicts exact changed files; update preserves choices, project records and reviewed unchanged adaptations", async () => {
    const f = await fixture();
    await mutateExtension(f.bundle, {
      kind: "configure",
      id: "tiny",
      set: { reviewer: "project owner", testCommand: "bun run verify" },
      bindings: { "issue-read": "fixture.issue_read" },
    });
    const local = `${f.files[review]}\nLocal review requirement.\n`;
    await write(f.bundle, f.current(review), local);
    expect((await readExtensions(f.bundle)).packages[0]?.availability).toBe(
      "review-required",
    );
    const beforeAck = await snapshot(f.bundle);
    expect(
      (await acknowledge(f.bundle, true)).inventory.packages[0]?.availability,
    ).toBe("available");
    expect(await snapshot(f.bundle)).toEqual(beforeAck);
    expect((await acknowledge(f.bundle)).ok).toBe(true);
    const v2 = await f.candidate(
      "1.1.0",
      {
        [template]: concept("New upstream template"),
        "guidance/release.md": concept("Release guidance"),
      },
      {
        defaults: {
          reviewer: "new upstream default",
          testCommand: "new upstream command",
        },
      },
    );
    const before = await snapshot(f.bundle);
    const dry = await update(f.bundle, v2.source, true);
    expect(dry.ok).toBe(true);
    expect(dry.affectedPaths.sort()).toEqual(
      [
        EXTENSION_REGISTRY_PATH,
        f.current(template),
        f.current("guidance/release.md"),
      ].sort(),
    );
    expect(dry.inventory.packages[0]?.availability).toBe("available");
    expect(await snapshot(f.bundle)).toEqual(before);
    const applied = await update(f.bundle, v2.source);
    expect(applied.ok).toBe(true);
    expect(applied.inventory).toEqual(dry.inventory);
    const saved = await f.record();
    expect(saved.config).toEqual({
      reviewer: "project owner",
      testCommand: "bun run verify",
    });
    expect(saved.bindings).toEqual({ "issue-read": "fixture.issue_read" });
    expect(saved.reviewedLocal[review]).toBe(extensionHash(local));
    expect(saved.base[review]).toBe(f.files[review]);
    expect(await readFile(join(f.bundle, f.current(review)), "utf8")).toBe(
      local,
    );
    expect(
      await readFile(join(f.bundle, "proposals/completed.md"), "utf8"),
    ).toBe(required(before["proposals/completed.md"]));
    const installed = await snapshot(f.bundle);
    expect((await update(f.bundle, v2.source)).changed).toBe(false);
    expect(await snapshot(f.bundle)).toEqual(installed);
  });

  test("unacknowledged edits remain review-required across upstream changes and new edits revoke only their exact acknowledgement", async () => {
    const f = await fixture();
    const local = `${f.files[review]}\nLocal addition.\n`;
    await write(f.bundle, f.current(review), local);
    const v2 = await f.candidate("1.1.0", {
      [template]: concept("Changed template"),
    });
    expect(
      (await update(f.bundle, v2.source)).inventory.packages[0]?.availability,
    ).toBe("review-required");
    expect((await f.record()).requestedEnabled).toBe(true);
    expect((await acknowledge(f.bundle)).ok).toBe(true);
    expect((await acknowledge(f.bundle)).changed).toBe(false);
    await write(
      f.bundle,
      f.current(template),
      `${v2.files[template]}\nAnother local edit.\n`,
    );
    expect(
      (await readExtensions(f.bundle)).packages[0]?.reviewRequiredPaths,
    ).toEqual([template]);
    expect((await f.record()).reviewedLocal[review]).toBe(extensionHash(local));
    expect(
      (await acknowledge(f.bundle)).inventory.packages[0]?.availability,
    ).toBe("available");
  });

  test("both-changed and locally edited deletion conflicts reject the entire candidate in actual and dry runs", async () => {
    for (const replacement of [concept("Changed upstream"), null]) {
      const f = await fixture();
      await write(
        f.bundle,
        f.current(template),
        `${f.files[template]}\nLocal edit.\n`,
      );
      await acknowledge(f.bundle);
      const candidate = await f.candidate("1.1.0", {
        [template]: replacement,
        [review]: `${f.files[review]}\nUnrelated upstream change.\n`,
      });
      const before = await snapshot(f.bundle);
      for (const dryRun of [true, false]) {
        const result = await update(f.bundle, candidate.source, dryRun);
        expect(result.ok).toBe(false);
        expect(result.changed).toBe(false);
        expect(
          result.diagnostics.some((entry) => entry.code === "update-conflict"),
        ).toBe(true);
        expect(await snapshot(f.bundle)).toEqual(before);
      }
    }
  });

  test("removed unedited files stay owned with exact tombstones and may be reintroduced from base or identical candidate bytes", async () => {
    for (const alreadyCandidate of [false, true]) {
      const f = await fixture();
      const original = await f.record();
      const v2 = await f.candidate("1.1.0", {
        [template]: null,
        [review]: `${f.files[review]}\n[Prior template](../templates/proposal.md)\n`,
      });
      expect((await update(f.bundle, v2.source)).ok).toBe(true);
      const record = await f.record();
      expect(record.retainedFiles[template]).toEqual({
        base: required(f.files[template]),
        baseHash: extensionHash(required(f.files[template])),
        sourceVersion: "1.0.0",
        sourceDigest: original.digest,
      });
      expect(record.base[template]).toBeUndefined();
      expect(await readFile(join(f.bundle, f.current(template)), "utf8")).toBe(
        required(f.files[template]),
      );
      const v3 = await f.candidate("1.2.0", {
        [template]: concept("Reintroduced template"),
      });
      if (alreadyCandidate)
        await write(
          f.bundle,
          f.current(template),
          required(v3.files[template]),
        );
      expect((await update(f.bundle, v3.source)).ok).toBe(true);
      expect((await f.record()).retainedFiles).toEqual({});
      expect(await readFile(join(f.bundle, f.current(template)), "utf8")).toBe(
        required(v3.files[template]),
      );
    }
  });

  test("reintroduction never adopts divergent or missing retained bytes; missing inactive history alone remains warning-only", async () => {
    const f = await fixture();
    const v2 = await f.candidate("1.1.0", { [template]: null });
    expect((await update(f.bundle, v2.source)).ok).toBe(true);
    const v3 = await f.candidate("1.2.0", {
      [template]: concept("New version"),
    });
    for (const local of [concept("Local historical edit"), null]) {
      if (local === null) await rm(join(f.bundle, f.current(template)));
      else await write(f.bundle, f.current(template), local);
      const before = await snapshot(f.bundle);
      expect((await readExtensions(f.bundle)).packages[0]?.availability).toBe(
        "available",
      );
      expect((await update(f.bundle, v3.source)).ok).toBe(false);
      expect(await snapshot(f.bundle)).toEqual(before);
    }
    const noReintroduction = await f.candidate("1.2.0", {
      [template]: null,
      [review]: `${f.files[review]}\nUnrelated improvement.\n`,
    });
    expect((await update(f.bundle, noReintroduction.source)).ok).toBe(true);
    expect((await f.record()).retainedFiles[template]).toBeDefined();
  });

  test("invalid retained dependencies propagate through history and cannot be acknowledged into active availability", async () => {
    const f = await fixture();
    // Introduce two linked templates, retire them, then break the leaf locally.
    const v2 = await f.candidate("1.1.0", {
      "templates/intermediate.md": concept("[Leaf](proposal.md)"),
    });
    expect((await update(f.bundle, v2.source)).ok).toBe(true);
    const v3 = await f.candidate("1.2.0", { [template]: null });
    expect((await update(f.bundle, v3.source)).ok).toBe(true);
    await write(f.bundle, f.current(template), concept("[Missing](absent.md)"));
    expect((await readExtensions(f.bundle)).packages[0]?.availability).toBe(
      "available",
    );
    await write(
      f.bundle,
      f.current(review),
      `${f.files[review]}\n[Historical intermediary](/extensions/tiny/templates/intermediate.md)\n`,
    );
    const before = await snapshot(f.bundle);
    expect((await readExtensions(f.bundle)).packages[0]?.availability).toBe(
      "invalid",
    );
    expect((await acknowledge(f.bundle)).ok).toBe(false);
    expect(await snapshot(f.bundle)).toEqual(before);
  });

  test("removed/default type migration and removed bindings block until explicit reset and unbind", async () => {
    const f = await fixture();
    await mutateExtension(f.bundle, {
      kind: "configure",
      id: "tiny",
      set: { reviewer: "owner", testCommand: "verify" },
      bindings: { "issue-read": "fixture.read" },
    });
    const v2 = await f.candidate(
      "1.1.0",
      {},
      { defaults: { reviewer: false }, capabilities: [] },
    );
    const before = await snapshot(f.bundle);
    const failed = await update(f.bundle, v2.source);
    expect(failed.ok).toBe(false);
    expect(
      failed.diagnostics.filter(
        (entry) => entry.code === "invalid-configuration",
      ),
    ).toHaveLength(2);
    expect(
      failed.diagnostics.some((entry) => entry.code === "invalid-binding"),
    ).toBe(true);
    expect(await snapshot(f.bundle)).toEqual(before);
    expect(
      (
        await mutateExtension(f.bundle, {
          kind: "configure",
          id: "tiny",
          reset: ["reviewer", "testCommand"],
          unbind: ["issue-read"],
        })
      ).ok,
    ).toBe(true);
    expect((await update(f.bundle, v2.source)).ok).toBe(true);
    expect((await f.record()).config).toEqual({});
  });

  test("different IDs, republished versions, downgrades and incompatible candidates stay inert", async () => {
    const f = await fixture();
    for (const [version, patch, change] of [
      ["1.1.0", { id: "other" }, {}],
      ["1.0.0", {}, { [template]: concept("Republished") }],
      ["0.9.0", {}, {}],
      ["1.1.0", { engine: { min: "9.0.0", maxExclusive: "10.0.0" } }, {}],
    ] as [string, Partial<ExtensionManifest>, Record<string, string>][]) {
      const candidate = await f.candidate(version, change, patch);
      const before = await snapshot(f.bundle);
      for (const dryRun of [true, false]) {
        expect((await update(f.bundle, candidate.source, dryRun)).ok).toBe(
          false,
        );
        expect(await snapshot(f.bundle)).toEqual(before);
      }
    }
  });

  test("engine-first and package-first upgrades preserve current config and records, with explicit incompatible intervals", async () => {
    for (const engineFirst of [false, true]) {
      const f = await fixture({ engine: "0.4.0-dev.1" });
      await mutateExtension(f.bundle, {
        kind: "configure",
        id: "tiny",
        set: { reviewer: "project reviewer" },
      });
      const records = await readFile(
        join(f.bundle, "proposals/completed.md"),
        "utf8",
      );
      // Old package excludes 1.x. A bridge package supports both old/new engines.
      const bridge = await f.candidate(
        "1.1.0",
        { [template]: concept("Compatible bridge") },
        { engine: { min: "0.4.0", maxExclusive: "2.0.0" } },
      );
      const before = await snapshot(f.bundle);
      if (engineFirst) {
        expect(
          (await readExtensions(f.bundle, { engineVersion: "1.0.0" }))
            .packages[0]?.availability,
        ).toBe("incompatible");
        expect(await snapshot(f.bundle)).toEqual(before);
      }
      expect(
        (
          await update(
            f.bundle,
            bridge.source,
            false,
            engineFirst ? "1.0.0" : "0.4.0",
          )
        ).ok,
      ).toBe(true);
      const installed = await snapshot(f.bundle);
      expect(
        (await readExtensions(f.bundle, { engineVersion: "1.0.0" })).packages[0]
          ?.availability,
      ).toBe("available");
      expect(await snapshot(f.bundle)).toEqual(installed);
      expect((await f.record()).config).toEqual({
        reviewer: "project reviewer",
      });
      expect(
        await readFile(join(f.bundle, "proposals/completed.md"), "utf8"),
      ).toBe(records);
    }
  });

  test("disabled and removed requests stay inactive after valid updates", async () => {
    for (const kind of ["disable", "remove"] as const) {
      const f = await fixture();
      await mutateExtension(f.bundle, { kind, id: "tiny" });
      const v2 = await f.candidate();
      expect((await update(f.bundle, v2.source)).ok).toBe(true);
      expect((await f.record()).requestedEnabled).toBe(false);
      expect((await f.record()).status).toBe(
        kind === "remove" ? "removed" : "installed",
      );
    }
  });

  test("unknown provenance, malformed/missing current source and unsafe destinations cannot be reconciled or updated", async () => {
    for (const corrupt of [
      "base",
      "missing",
      "invalid",
      "symlink",
      "unowned",
    ] as const) {
      const f = await fixture();
      const v2 = await f.candidate("1.1.0", {
        "guidance/new.md": concept("New guidance"),
      });
      if (corrupt === "base") {
        const saved = await f.registry();
        required(saved.packages.tiny).digest = "0".repeat(64);
        await write(f.bundle, EXTENSION_REGISTRY_PATH, JSON.stringify(saved));
      } else if (corrupt === "missing")
        await rm(join(f.bundle, f.current(review)));
      else if (corrupt === "invalid")
        await write(f.bundle, f.current(review), "Not a concept\n");
      else if (corrupt === "symlink") {
        await rm(join(f.bundle, f.current(review)));
        await symlink(
          join(f.source, review),
          join(f.bundle, f.current(review)),
        );
      } else
        await write(
          f.bundle,
          f.current("guidance/new.md"),
          required(v2.files["guidance/new.md"]),
        );
      const before = await snapshot(f.bundle);
      for (const dryRun of [true, false]) {
        expect((await acknowledge(f.bundle, dryRun)).ok).toBe(false);
        expect((await update(f.bundle, v2.source, dryRun)).ok).toBe(false);
        expect(await snapshot(f.bundle)).toEqual(before);
      }
    }
  });
});

test("retained history is bounded without purging or writing a partial candidate", async () => {
  const f = await fixture();
  for (const [version, prefix] of [
    ["1.1.0", "first"],
    ["1.2.0", "second"],
  ]) {
    const changes = Object.fromEntries(
      Array.from({ length: 95 }, (_, index) => [
        `templates/${prefix}-${index}.md`,
        concept(`Historical ${prefix} ${index}`),
      ]),
    );
    const candidate = await f.candidate(version, changes);
    expect((await update(f.bundle, candidate.source)).ok).toBe(true);
  }
  expect(Object.keys((await f.record()).retainedFiles)).toHaveLength(95);
  const third = await f.candidate(
    "1.3.0",
    Object.fromEntries(
      Array.from({ length: 95 }, (_, index) => [
        `templates/third-${index}.md`,
        concept(`Third ${index}`),
      ]),
    ),
  );
  const before = await snapshot(f.bundle);
  for (const dryRun of [true, false]) {
    const failure = await update(f.bundle, third.source, dryRun);
    expect(failure.ok).toBe(false);
    expect(failure.changed).toBe(false);
    expect(
      failure.diagnostics.some(
        (entry) =>
          entry.code === "content-limit" && entry.remediation.includes("Git"),
      ),
    ).toBe(true);
    expect(await snapshot(f.bundle)).toEqual(before);
  }
});

test("history byte bounds and case-colliding reintroduction fail the shared transition validator", async () => {
  const f = await fixture();
  const previous = await f.record();
  const current: Record<string, string | null> = { ...f.files };
  const large = concept("x".repeat(250 * 1024));
  for (let index = 0; index < 16; index++) {
    const path = `templates/retained-${index}.md`;
    previous.retainedFiles[path] = {
      base: large,
      baseHash: extensionHash(large),
      sourceVersion: "0.9.0",
      sourceDigest: "a".repeat(64),
    };
    current[path] = large;
  }
  const candidate = await f.candidate("1.1.0", {
    "templates/addition.md": large,
  });
  const planned = planExtensionUpdate(
    previous,
    current,
    candidate.manifest,
    candidate.files,
  );
  expect(
    planned.diagnostics.some((entry) => entry.code === "content-limit"),
  ).toBe(true);
  const collision = await f.candidate("1.1.0", {
    [template]: null,
    "templates/PROPOSAL.md": concept("Case-only path replacement"),
  });
  const failed = await update(f.bundle, collision.source);
  expect(failed.ok).toBe(false);
  expect(
    failed.diagnostics.some(
      (entry) =>
        entry.code === "duplicate-name" || entry.code === "filesystem-failure",
    ),
  ).toBe(true);
});

describe("mechanical receipts and update recovery", () => {
  test("validation identifies exact inputs, current/candidate scenarios and unrun evidence without writes or script execution", async () => {
    const f = await fixture();
    await write(
      f.bundle,
      f.current(review),
      `${f.files[review]}\nLocal review input.\n`,
    );
    const before = await snapshot(f.bundle);
    const receipt = await validateExtensions(f.bundle, { id: "tiny" });
    expect(receipt.ok).toBe(true);
    expect([receipt.mechanical, receipt.protocol, receipt.behavioral]).toEqual([
      "pass",
      "not-run",
      "not-run",
    ]);
    expect(receipt.registryHash).toBe(
      extensionHash(required(before[EXTENSION_REGISTRY_PATH])),
    );
    expect(receipt.packages[0]?.sourceHashes[review]).toBe(
      extensionHash(required(before[f.current(review)])),
    );
    expect(receipt.packages[0]?.baseHashes[review]).toBe(
      extensionHash(required(f.files[review])),
    );
    expect(receipt.packages[0]?.configurationHash).toHaveLength(64);
    expect(receipt.packages[0]?.reviewRequiredPaths).toEqual([review]);
    expect(receipt.packages[0]?.scenarios).toEqual([
      f.current("scenarios/delivery.md"),
    ]);
    const v2 = await f.candidate("1.1.0", {
      [template]: concept("Updated template"),
    });
    const proposed = await validateExtensions(f.bundle, {
      candidate: v2.source,
    });
    expect(proposed.ok).toBe(true);
    expect(proposed.candidate?.manifest?.version).toBe("1.1.0");
    expect(proposed.packages[0]?.manifest.version).toBe("1.0.0");
    expect(proposed.update?.inventory.packages[0]?.manifest.version).toBe(
      "1.1.0",
    );
    expect(await snapshot(f.bundle)).toEqual(before);
    expect(
      (await validateExtensions(f.bundle, { id: "absent" })).mechanical,
    ).toBe("fail");
    const conflicting = await f.candidate("1.1.0", {
      [review]: `${f.files[review]}\nUpstream changed.\n`,
    });
    const rejected = await validateExtensions(f.bundle, {
      id: "tiny",
      candidate: conflicting.source,
    });
    expect([
      rejected.mechanical,
      rejected.protocol,
      rejected.behavioral,
    ]).toEqual(["fail", "not-run", "not-run"]);
    expect(await snapshot(f.bundle)).toEqual(before);
  });

  test("injected update failure restores exact content, base, config and registry, including interrupted recovery", async () => {
    const f = await fixture();
    const v2 = await f.candidate("1.1.0", {
      [template]: concept("New template"),
      [review]: `${f.files[review]}\nNew behavior.\n`,
      "guidance/new.md": concept("New addition must disappear in recovery"),
    });
    const journal = await updateJournal(f, v2);
    const before = await snapshot(f.bundle);
    const failed = await applyExtensionTransaction(
      f.bundle,
      journal,
      async (root, path, text, expected) => {
        if (path === EXTENSION_REGISTRY_PATH)
          throw new Error("Injected registry write failure");
        await publishExtensionText(root, path, text, expected);
      },
    );
    expect(failed.ok).toBe(false);
    expect(failed.rollback).toBe("complete");
    expect(await snapshot(f.bundle)).toEqual(before);
    await publishExtensionText(
      f.bundle,
      EXTENSION_JOURNAL_PATH,
      JSON.stringify(journal),
    );
    for (const entry of journal.entries)
      if (entry.after !== null)
        await publishExtensionText(f.bundle, entry.path, entry.after);
    const pending = await snapshot(f.bundle);
    const dry = await mutateExtension(
      f.bundle,
      { kind: "recover" },
      { dryRun: true },
    );
    expect(dry.ok).toBe(true);
    expect(dry.inventory.packages[0]?.manifest.version).toBe("1.0.0");
    expect(dry.inventory.packages[0]?.availability).toBe("available");
    expect(await snapshot(f.bundle)).toEqual(pending);
    expect((await mutateExtension(f.bundle, { kind: "recover" })).ok).toBe(
      true,
    );
    expect(await snapshot(f.bundle)).toEqual(before);
  });

  test("review and unchanged-source guards reject stale preflight and preserve unexpected edits during publication", async () => {
    const f = await fixture();
    const local = `${f.files[review]}\nReviewed local requirement.\n`;
    await write(f.bundle, f.current(review), local);
    await acknowledge(f.bundle);
    const v2 = await f.candidate("1.1.0", {
      [template]: concept("Upstream template"),
    });
    const journal = await updateJournal(f, v2);
    const unexpected = `${local}\nConcurrent local edit.\n`;
    await write(f.bundle, f.current(review), unexpected);
    const concurrent = await snapshot(f.bundle);
    expect((await applyExtensionTransaction(f.bundle, journal)).ok).toBe(false);
    expect(await snapshot(f.bundle)).toEqual(concurrent);
    await write(f.bundle, f.current(review), local);
    const result = await applyExtensionTransaction(
      f.bundle,
      journal,
      async (root, path, text, expected) => {
        await publishExtensionText(root, path, text, expected);
        if (path === f.current(template))
          await write(root, f.current(review), unexpected);
      },
    );
    expect(result.rollback).toBe("pending");
    expect(await readFile(join(f.bundle, f.current(review)), "utf8")).toBe(
      unexpected,
    );
    expect((await readExtensions(f.bundle)).pendingTransaction).toBe(true);
    const pending = await snapshot(f.bundle);
    expect((await mutateExtension(f.bundle, { kind: "recover" })).ok).toBe(
      false,
    );
    expect(await snapshot(f.bundle)).toEqual(pending);
    await write(f.bundle, f.current(review), local);
    expect((await mutateExtension(f.bundle, { kind: "recover" })).ok).toBe(
      true,
    );
    expect((await f.record()).manifest.version).toBe("1.0.0");
    // Reconciliation retains every exact source used to acknowledge review.
    await write(f.bundle, f.current(review), unexpected);
    const previous = await f.record();
    const saved = await f.registry();
    const views = required((await readExtensions(f.bundle)).packages[0]);
    const planned = planExtensionReconciliation(
      previous,
      Object.fromEntries(
        Object.entries(views.sources).map(([path, source]) => [
          path,
          source.text,
        ]),
      ),
    );
    const registryBefore = await readFile(
      join(f.bundle, EXTENSION_REGISTRY_PATH),
      "utf8",
    );
    saved.packages.tiny = planned.record;
    const reviewJournal: ExtensionJournal = {
      formatVersion: 1,
      kind: "reconcile",
      id: "tiny",
      entries: [
        ...planned.entries,
        {
          path: EXTENSION_REGISTRY_PATH,
          before: registryBefore,
          after: JSON.stringify(saved),
        },
      ],
    };
    await write(f.bundle, f.current(review), local);
    const fresh = await snapshot(f.bundle);
    expect((await applyExtensionTransaction(f.bundle, reviewJournal)).ok).toBe(
      false,
    );
    expect(await snapshot(f.bundle)).toEqual(fresh);
  });

  test("tampered update journals cannot delete historical ownership, change choices, bypass conflicts or omit exact-before guards", async () => {
    const f = await fixture();
    const v2 = await f.candidate("1.1.0", { [template]: null });
    const original = await updateJournal(f, v2);
    for (const tamper of ["history", "config", "content", "guard"] as const) {
      const journal = structuredClone(original);
      if (tamper === "guard")
        journal.entries = journal.entries.filter(
          (entry) => entry.path !== f.current(review),
        );
      else if (tamper === "content")
        required(
          journal.entries.find((entry) => entry.path === f.current(template)),
        ).after = concept("Unexpected clobber");
      else {
        const saved = JSON.parse(
          required(required(journal.entries.at(-1)).after),
        ) as ExtensionRegistry;
        if (tamper === "history")
          required(saved.packages.tiny).retainedFiles = {};
        else
          required(saved.packages.tiny).config.reviewer =
            "Journal changed project choice";
        required(journal.entries.at(-1)).after = JSON.stringify(saved);
      }
      await publishExtensionText(
        f.bundle,
        EXTENSION_JOURNAL_PATH,
        JSON.stringify(journal),
      );
      const before = await snapshot(f.bundle);
      expect((await mutateExtension(f.bundle, { kind: "recover" })).ok).toBe(
        false,
      );
      expect(await snapshot(f.bundle)).toEqual(before);
    }
  });
});

test("altering only retained base bytes or removing their independent hash cannot authorize reintroduction, acknowledgment or recovery", async () => {
  for (const corruption of ["changed-base", "missing-hash"] as const) {
    const f = await fixture();
    const v2 = await f.candidate("1.1.0", { [template]: null });
    expect((await update(f.bundle, v2.source)).ok).toBe(true);
    const v3 = await f.candidate("1.2.0", {
      [template]: concept("Reintroduced upstream"),
    });
    const journal = await updateJournal(f, v3);
    const saved = await f.registry();
    const tombstone = required(
      required(saved.packages.tiny).retainedFiles[template],
    );
    const local = concept(
      "Preserve this project-authored historical adaptation",
    );
    if (corruption === "changed-base") {
      await write(f.bundle, f.current(template), local);
      tombstone.base = local;
    } else delete (tombstone as { baseHash?: string }).baseHash;
    const corruptText = JSON.stringify(saved);
    await write(f.bundle, EXTENSION_REGISTRY_PATH, corruptText);
    const before = await snapshot(f.bundle);
    const view = (await readExtensions(f.bundle)).packages[0];
    expect(view?.availability).toBe("invalid");
    expect(
      view?.diagnostics.some((entry) => entry.code === "unknown-base"),
    ).toBe(true);
    expect(
      (await validateExtensions(f.bundle, { id: "tiny", candidate: v3.source }))
        .mechanical,
    ).toBe("fail");
    for (const dryRun of [true, false]) {
      expect((await acknowledge(f.bundle, dryRun)).ok).toBe(false);
      expect((await update(f.bundle, v3.source, dryRun)).ok).toBe(false);
      expect(await snapshot(f.bundle)).toEqual(before);
    }
    const planner = planExtensionUpdate(
      required(saved.packages.tiny),
      Object.fromEntries(
        Object.entries(required(view).sources).map(([path, source]) => [
          path,
          source.text,
        ]),
      ),
      v3.manifest,
      v3.files,
    );
    expect(
      planner.diagnostics.some((entry) => entry.code === "unknown-base"),
    ).toBe(true);
    required(journal.entries.at(-1)).before = corruptText;
    if (corruption === "changed-base")
      required(
        journal.entries.find((entry) => entry.path === f.current(template)),
      ).before = local;
    await write(f.bundle, EXTENSION_JOURNAL_PATH, JSON.stringify(journal));
    const pending = await snapshot(f.bundle);
    expect((await mutateExtension(f.bundle, { kind: "recover" })).ok).toBe(
      false,
    );
    expect(await snapshot(f.bundle)).toEqual(pending);
  }
});

test("validation rejects inter-read changes to unowned tree entries or linked project concepts", async () => {
  for (const change of ["unowned", "linked"] as const) {
    const f = await fixture();
    if (change === "linked") {
      await write(
        f.bundle,
        "reference/shared.md",
        concept("Shared project guidance"),
      );
      await write(
        f.bundle,
        f.current(review),
        `${f.files[review]}\n[Shared](/reference/shared.md)\n`,
      );
      await acknowledge(f.bundle);
    }
    const { spyOn } = await import("bun:test");
    const filesystem = await import("node:fs/promises");
    const originalRead = filesystem.readFile;
    let registryReads = 0;
    // readExtensions reads registry before and after each inventory. Inject at
    // the second inventory's first read, leaving tracked source/registry bytes
    // identical while changing authoritative link/tree validation.
    const spy = spyOn(filesystem, "readFile").mockImplementation((async (
      ...args: Parameters<typeof originalRead>
    ) => {
      if (
        String(args[0]) === join(f.bundle, EXTENSION_REGISTRY_PATH) &&
        ++registryReads === 3
      ) {
        if (change === "unowned")
          await write(
            f.bundle,
            f.current("templates/unowned.md"),
            concept("Concurrent unowned file"),
          );
        else await rm(join(f.bundle, "reference/shared.md"));
      }
      return originalRead(...args);
    }) as typeof originalRead);
    try {
      const receipt = await validateExtensions(f.bundle, { id: "tiny" });
      expect(registryReads).toBeGreaterThanOrEqual(4);
      expect(receipt.mechanical).toBe("fail");
      expect(
        receipt.diagnostics.some((entry) => entry.code === "state-changed"),
      ).toBe(true);
      expect(receipt.protocol).toBe("not-run");
      expect(receipt.behavioral).toBe("not-run");
    } finally {
      spy.mockRestore();
    }
  }
});

test("updating one of two packages with colliding native names preserves both canonical owners and the unrelated record", async () => {
  const f = await fixture();
  const second = await f.candidate("1.0.0", {}, { id: "tiny-a" });
  expect(
    (
      await mutateExtension(f.bundle, {
        kind: "install",
        source: second.source,
        enable: true,
      })
    ).ok,
  ).toBe(true);
  await mutateExtension(f.bundle, {
    kind: "configure",
    id: "tiny-a",
    set: { reviewer: "other project owner" },
  });
  const otherBefore = JSON.stringify((await f.registry()).packages["tiny-a"]);
  const candidate = await f.candidate(
    "1.1.0",
    { [template]: concept("Updated first package") },
    { workflows: [{ ...required(f.manifest.workflows[0]), id: "a-review" }] },
  );
  const updated = await update(f.bundle, candidate.source);
  expect(updated.ok).toBe(true);
  expect(
    updated.inventory.workflows.map((entry) => entry.identity).sort(),
  ).toEqual(["tiny-a:review", "tiny:a-review"].sort());
  expect(
    updated.inventory.diagnostics.some(
      (entry) => entry.code === "native-name-collision",
    ),
  ).toBe(true);
  expect(JSON.stringify((await f.registry()).packages["tiny-a"])).toBe(
    otherBefore,
  );
  expect(
    await readFile(
      join(f.bundle, "extensions/tiny-a/templates/proposal.md"),
      "utf8",
    ),
  ).toBe(required(f.files[template]));
});
