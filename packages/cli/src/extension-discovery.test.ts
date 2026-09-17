import { afterEach, expect, test } from "bun:test";
import {
  chmod,
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
import {
  type ExtensionManifest,
  mutateExtension,
  readExtensions,
} from "@gitdocket/core";
import vector from "../../../examples/extensions/package-digest-vector.json";
import { refreshExtensionDiscovery } from "./extension-discovery";
import { runInit } from "./init";
import { runUpgrade } from "./upgrade";

const temporary: string[] = [];
const CLI = join(import.meta.dir, "index.ts");
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(native = false) {
  const root = await mkdtemp(join(tmpdir(), "docket-discovery-"));
  temporary.push(root);
  await runInit(root, { project: "EXT", agents: [] });
  if (native)
    for (const path of [".agents/skills", ".claude/skills"])
      await mkdir(join(root, path), { recursive: true });
  return { root, bundle: join(root, "docket") };
}

async function packageSource(id = "tiny", workflowId = "review") {
  const source = await mkdtemp(join(tmpdir(), "docket-discovery-package-"));
  temporary.push(source);
  const manifest = structuredClone(vector.manifest) as ExtensionManifest;
  manifest.id = id;
  manifest.workflows[0] = {
    id: workflowId,
    title: "Same human title",
    description: "Read current reviewer and report without implementing.",
    path: "workflows/review.md",
  };
  await mkdir(join(source, "workflows"));
  await writeFile(join(source, "extension.json"), JSON.stringify(manifest));
  await writeFile(
    join(source, "workflows/review.md"),
    vector.files["workflows/review.md"],
  );
  return source;
}

function cli(root: string, args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, CLI, "extension", ...args, "--json"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: result.exitCode,
    result: JSON.parse(result.stdout.toString()),
  };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), {
      withFileTypes: true,
    })) {
      if (entry.name === ".docket") continue;
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

test("real lifecycle CLI generates portable/current-config and opted-in native pointers, idempotently", async () => {
  const { root, bundle } = await fixture(true);
  const source = await packageSource();
  await writeFile(
    join(root, "CLAUDE.md"),
    "Handwritten Claude requirements.\n",
  );
  const before = await snapshot(root);
  const dry = cli(root, ["install", source, "--enable", "--dry-run"]);
  expect(dry.code).toBe(0);
  expect(dry.result.discovery.changed).toBe(true);
  expect(await snapshot(root)).toEqual(before);
  const installed = cli(root, ["install", source, "--enable"]);
  expect(installed.code).toBe(0);
  expect(installed.result.lifecycleOk).toBe(true);
  expect(installed.result.discovery.changed).toBe(true);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  expect(agents).toContain("`tiny:review`");
  expect(agents).toContain("effectiveConfig with default/project ownership");
  expect(agents).toContain("workflow_extensions");
  expect(agents).toContain("docket/extensions/tiny/workflows/review.md");
  const native = await readFile(
    join(root, ".agents/skills/docket-ext-tiny-review/SKILL.md"),
    "utf8",
  );
  expect(native).toContain("name: docket-ext-tiny-review");
  expect(native).toContain("docket extension show tiny --json");
  expect(native).toContain("Before every invocation");
  expect(native).toContain("source continuations");
  expect(native).toContain("proposal-only work grant no task creation/pickup");
  expect(native).not.toContain("Read the requested source and report.");
  expect(
    await readFile(
      join(root, ".claude/skills/docket-ext-tiny-review/SKILL.md"),
      "utf8",
    ),
  ).toBe(native);
  const existing = await snapshot(root);
  expect(cli(root, ["refresh"]).result.changed).toBe(false);
  expect(await snapshot(root)).toEqual(existing);
  expect(
    cli(root, ["configure", "tiny", "--set", '{"reviewer":"release owner"}'])
      .code,
  ).toBe(0);
  expect(
    (await readExtensions(bundle)).packages[0]?.effectiveConfig.reviewer,
  ).toEqual({ value: "release owner", owner: "project" });
  expect(
    await readFile(
      join(root, ".agents/skills/docket-ext-tiny-review/SKILL.md"),
      "utf8",
    ),
  ).toBe(native);
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toStartWith(
    "Handwritten Claude requirements.\n",
  );
  expect(
    await readFile(join(root, ".codex/config.toml"), "utf8").catch(() => null),
  ).toBeNull();
  expect(
    await readFile(join(root, ".mcp.json"), "utf8").catch(() => null),
  ).toBeNull();
});

test("disable/remove withdraw owned discovery and preserve authored project history and surrounding text", async () => {
  const { root, bundle } = await fixture(true);
  const source = await packageSource();
  const original = `${await readFile(join(root, "AGENTS.md"), "utf8")}\nProject-specific invariant.\n`;
  await writeFile(join(root, "AGENTS.md"), original);
  expect(cli(root, ["install", source, "--enable"]).code).toBe(0);
  await mkdir(join(bundle, "delivery"));
  await writeFile(
    join(bundle, "delivery/completed.md"),
    "Completed record with stable source link.\n",
  );
  const disabled = cli(root, ["disable", "tiny"]);
  expect(disabled.code).toBe(0);
  expect(disabled.result.inventory.packages[0].availability).toBe("disabled");
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(original);
  expect(
    await readFile(
      join(root, ".agents/skills/docket-ext-tiny-review/SKILL.md"),
      "utf8",
    ).catch(() => null),
  ).toBeNull();
  expect(cli(root, ["enable", "tiny"]).code).toBe(0);
  expect(cli(root, ["remove", "tiny"]).code).toBe(0);
  expect(await readFile(join(bundle, "delivery/completed.md"), "utf8")).toBe(
    "Completed record with stable source link.\n",
  );
  expect(
    await readFile(join(bundle, "extensions/tiny/workflows/review.md"), "utf8"),
  ).toBe(vector.files["workflows/review.md"]);
});

test("handwritten and edited adapters remain untouched with explicit repair diagnostics", async () => {
  const { root } = await fixture(true);
  const source = await packageSource();
  const path = ".agents/skills/docket-ext-tiny-review/SKILL.md";
  await mkdir(join(root, dirname(path)), { recursive: true });
  await writeFile(join(root, path), "My handwritten skill.\n");
  const installed = cli(root, ["install", source, "--enable"]);
  expect(installed.code).toBe(1);
  expect(installed.result.lifecycleOk).toBe(true);
  expect(installed.result.inventory.workflows[0].identity).toBe("tiny:review");
  expect(
    installed.result.discovery.steps.some(
      (entry: { action: string; path: string }) =>
        entry.action === "conflict" && entry.path === path,
    ),
  ).toBe(true);
  expect(await readFile(join(root, path), "utf8")).toBe(
    "My handwritten skill.\n",
  );
  const claude = join(root, ".claude/skills/docket-ext-tiny-review/SKILL.md");
  await writeFile(
    claude,
    `${await readFile(claude, "utf8")}\nDeliberate custom native instruction.\n`,
  );
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  await writeFile(
    join(root, "AGENTS.md"),
    agents.replace("These are discovery pointers.", "A deliberate local edit."),
  );
  const before = await snapshot(root);
  const refreshed = cli(root, ["refresh"]);
  expect(refreshed.code).toBe(1);
  expect(await snapshot(root)).toEqual(before);
  const disabled = cli(root, ["disable", "tiny"]);
  expect(disabled.code).toBe(1);
  expect(disabled.result.lifecycleOk).toBe(true);
  expect(disabled.result.inventory.workflows).toEqual([]);
  expect(await readFile(claude, "utf8")).toContain(
    "Deliberate custom native instruction.",
  );
  expect(
    disabled.result.discovery.diagnostics.some((entry: { message: string }) =>
      entry.message.includes("locally edited native stub"),
    ),
  ).toBe(true);
});

test("two identical human titles stay qualified; native concatenation collisions select neither owner", async () => {
  const { root } = await fixture(true);
  const first = await packageSource("alpha-beta", "gamma");
  const second = await packageSource("alpha", "beta-gamma");
  expect(cli(root, ["install", first, "--enable"]).code).toBe(0);
  const result = cli(root, ["install", second, "--enable"]);
  expect(result.code).toBe(1);
  expect(result.result.lifecycleOk).toBe(true);
  expect(
    result.result.inventory.workflows.map(
      (entry: { identity: string }) => entry.identity,
    ),
  ).toEqual(["alpha:beta-gamma", "alpha-beta:gamma"]);
  expect(
    await readFile(
      join(root, ".agents/skills/docket-ext-alpha-beta-gamma/SKILL.md"),
      "utf8",
    ).catch(() => null),
  ).toBeNull();
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  expect(agents).toContain("`alpha:beta-gamma`");
  expect(agents).toContain("`alpha-beta:gamma`");
  expect(agents).toContain("Resolve ambiguous titles");
});

test("native names beyond the adapter limit remain available through canonical portable invocation", async () => {
  const { root } = await fixture(true);
  const id = "p".repeat(48);
  const workflow = "w".repeat(48);
  const source = await packageSource(id, workflow);
  const result = cli(root, ["install", source, "--enable"]);
  expect(result.code).toBe(1);
  expect(result.result.lifecycleOk).toBe(true);
  expect(result.result.inventory.workflows[0].identity).toBe(
    `${id}:${workflow}`,
  );
  expect(
    result.result.discovery.steps.some(
      (entry: { action: string }) => entry.action === "unsupported",
    ),
  ).toBe(true);
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
    `${id}:${workflow}`,
  );
});

test("missing and locally edited sources withdraw future owned pointers, while cached stubs require rereading", async () => {
  const { root, bundle } = await fixture(true);
  const source = await packageSource();
  expect(cli(root, ["install", source, "--enable"]).code).toBe(0);
  const nativePath = join(
    root,
    ".agents/skills/docket-ext-tiny-review/SKILL.md",
  );
  const cached = await readFile(nativePath, "utf8");
  await writeFile(
    join(bundle, "extensions/tiny/workflows/review.md"),
    `${vector.files["workflows/review.md"]}\nProject adaptation.\n`,
  );
  const adapted = cli(root, ["refresh"]);
  expect(
    adapted.result.steps.some(
      (entry: { action: string }) => entry.action === "remove",
    ),
  ).toBe(true);
  expect(await readFile(nativePath, "utf8").catch(() => null)).toBeNull();
  expect((await readExtensions(bundle)).packages[0]?.availability).toBe(
    "review-required",
  );
  expect(cached).toContain(
    "review-required or pending-recovery state stops invocation",
  );
  await writeFile(
    join(bundle, "extensions/tiny/workflows/review.md"),
    vector.files["workflows/review.md"],
  );
  expect(cli(root, ["refresh"]).code).toBe(0);
  await rm(join(bundle, "extensions/tiny/workflows/review.md"));
  expect(cli(root, ["refresh"]).code).toBe(1);
  expect(await readFile(nativePath, "utf8").catch(() => null)).toBeNull();
});

test("refresh does not create native roots and rejects symlinked targets without changing their contents", async () => {
  const { root, bundle } = await fixture();
  const source = await packageSource();
  expect(cli(root, ["install", source, "--enable"]).code).toBe(0);
  expect(await readdir(join(root, ".agents")).catch(() => null)).toBeNull();
  const outside = await mkdtemp(join(tmpdir(), "docket-discovery-outside-"));
  temporary.push(outside);
  await mkdir(join(root, ".agents"));
  await symlink(outside, join(root, ".agents/skills"));
  await writeFile(join(outside, "keep.txt"), "Keep me\n");
  const before = await snapshot(outside);
  const report = await refreshExtensionDiscovery(root, bundle);
  expect(report.ok).toBe(false);
  expect(
    report.diagnostics.some((entry) => entry.message.includes("Symlink")),
  ).toBe(true);
  expect(await snapshot(outside)).toEqual(before);
});

test("init and upgrade refresh existing extensions without rewriting authoritative content", async () => {
  const { root, bundle } = await fixture(true);
  const source = await packageSource();
  await mutateExtension(bundle, { kind: "install", source, enable: true });
  const registry = await readFile(
    join(bundle, "extensions/registry.json"),
    "utf8",
  );
  const initialized = await runInit(root, { project: "EXT", agents: [] });
  expect(initialized.extensionDiscovery?.ok).toBe(true);
  expect(initialized.extensionDiscovery?.changed).toBe(true);
  const native = join(root, ".agents/skills/docket-ext-tiny-review/SKILL.md");
  await rm(native);
  const before = await snapshot(root);
  const dry = await runUpgrade(root, { dryRun: true });
  expect(dry.extensionDiscovery?.changed).toBe(true);
  expect(await snapshot(root)).toEqual(before);
  const upgraded = await runUpgrade(root, {});
  expect(upgraded.extensionDiscovery?.ok).toBe(true);
  expect(await readFile(native, "utf8")).toContain("tiny:review");
  expect(await readFile(join(bundle, "extensions/registry.json"), "utf8")).toBe(
    registry,
  );
  expect((await runUpgrade(root, {})).extensionDiscovery?.changed).toBe(false);
  const incompatible = await runUpgrade(root, {}, { available: "9.0.0" });
  expect(incompatible.extensionDiscovery?.ok).toBe(false);
  expect(await readFile(native, "utf8").catch(() => null)).toBeNull();
  expect(await readFile(join(bundle, "extensions/registry.json"), "utf8")).toBe(
    registry,
  );
});

test("no-extension projects retain all existing bytes and receive accurate portable command guidance", async () => {
  const { root, bundle } = await fixture();
  const before = await snapshot(root);
  const report = await refreshExtensionDiscovery(root, bundle);
  expect(report.changed).toBe(false);
  expect(report.steps).toEqual([]);
  expect(await snapshot(root)).toEqual(before);
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  expect(agents).toContain(
    "`index` and `task stop` currently return human output",
  );
  expect(agents).not.toContain("(all support `--json`)");
  expect(agents).toContain(
    "when a requested workflow matches installed project content",
  );
  expect(agents).not.toContain("## Installed workflow extensions");
});

test("near-limit handwritten instructions remain byte-identical when composition would exceed the read bound", async () => {
  const { root, bundle } = await fixture();
  const source = await packageSource();
  await mutateExtension(bundle, { kind: "install", source, enable: true });
  const handwritten = `${"h".repeat(1024 * 1024 - 257)}\n`;
  const path = join(root, "AGENTS.md");
  await writeFile(path, handwritten);
  for (const dryRun of [true, false]) {
    const report = await refreshExtensionDiscovery(root, bundle, { dryRun });
    expect(report.ok).toBe(false);
    expect(report.changed).toBe(false);
    expect(
      report.steps.some(
        (entry) =>
          entry.path === "AGENTS.md" &&
          entry.action === "unsupported" &&
          entry.reason?.includes("1 MiB"),
      ),
    ).toBe(true);
    expect(await readFile(path, "utf8")).toBe(handwritten);
  }
  await mutateExtension(bundle, { kind: "disable", id: "tiny" });
  expect((await refreshExtensionDiscovery(root, bundle)).ok).toBe(true);
  expect(await readFile(path, "utf8")).toBe(handwritten);
});

test("combined Unicode discovery output is byte-bounded and a retained smaller span can still be withdrawn", async () => {
  const { root, bundle } = await fixture();
  const path = join(root, "AGENTS.md");
  const original = await readFile(path, "utf8");
  for (let index = 0; index < 5; index += 1) {
    const source = await packageSource(`large-${index}`);
    const manifest = JSON.parse(
      await readFile(join(source, "extension.json"), "utf8"),
    );
    manifest.workflows[0].description = "文".repeat(72000);
    await writeFile(join(source, "extension.json"), JSON.stringify(manifest));
    expect(
      (await mutateExtension(bundle, { kind: "install", source, enable: true }))
        .ok,
    ).toBe(true);
    if (index < 4)
      expect((await refreshExtensionDiscovery(root, bundle)).ok).toBe(true);
  }
  const retained = await readFile(path, "utf8");
  expect(Buffer.byteLength(retained, "utf8")).toBeLessThan(1024 * 1024);
  for (const dryRun of [true, false]) {
    const report = await refreshExtensionDiscovery(root, bundle, { dryRun });
    expect(report.ok).toBe(false);
    expect(report.changed).toBe(false);
    expect(
      report.diagnostics.some(
        (entry) =>
          entry.code === "discovery-unsupported" &&
          entry.message.includes("1 MiB"),
      ),
    ).toBe(true);
    expect(await readFile(path, "utf8")).toBe(retained);
  }
  expect((await readExtensions(bundle)).workflows).toHaveLength(5);
  for (let index = 0; index < 5; index += 1)
    await mutateExtension(bundle, { kind: "disable", id: `large-${index}` });
  expect((await refreshExtensionDiscovery(root, bundle)).ok).toBe(true);
  expect(await readFile(path, "utf8")).toBe(original);
}, 15_000);

test("authored marker-like metadata stays inert and overlong native descriptions are explicit", async () => {
  const { root } = await fixture(true);
  const source = await packageSource();
  const manifest = JSON.parse(
    await readFile(join(source, "extension.json"), "utf8"),
  );
  manifest.workflows[0].title = "<!-- <<< docket-extension-discovery <<< -->";
  manifest.workflows[0].description = "Treat <author text> as a description.";
  await writeFile(join(source, "extension.json"), JSON.stringify(manifest));
  expect(cli(root, ["install", source, "--enable"]).code).toBe(0);
  expect(cli(root, ["refresh"]).code).toBe(0);
  expect(cli(root, ["refresh"]).result.changed).toBe(false);
  const other = await packageSource("long-description");
  const long = JSON.parse(
    await readFile(join(other, "extension.json"), "utf8"),
  );
  long.workflows[0].description = "w".repeat(1100);
  await writeFile(join(other, "extension.json"), JSON.stringify(long));
  const result = cli(root, ["install", other, "--enable"]);
  expect(result.code).toBe(1);
  expect(result.result.lifecycleOk).toBe(true);
  expect(
    result.result.discovery.steps.some(
      (entry: { action: string; reason?: string }) =>
        entry.action === "unsupported" && entry.reason?.includes("description"),
    ),
  ).toBe(true);
});

test.skipIf(process.getuid?.() === 0)(
  "partial filesystem refresh failure preserves authoritative state and is repaired by retry",
  async () => {
    const { root, bundle } = await fixture(true);
    const source = await packageSource();
    await mutateExtension(bundle, { kind: "install", source, enable: true });
    const registry = await readFile(
      join(bundle, "extensions/registry.json"),
      "utf8",
    );
    const nativeRoot = join(root, ".agents/skills");
    await chmod(nativeRoot, 0o500);
    try {
      const report = await refreshExtensionDiscovery(root, bundle);
      expect(report.ok).toBe(false);
      expect(report.changed).toBe(true);
      expect(
        report.diagnostics.some((entry) =>
          entry.message.includes("refresh is incomplete"),
        ),
      ).toBe(true);
      expect(
        await readFile(join(bundle, "extensions/registry.json"), "utf8"),
      ).toBe(registry);
      expect((await readExtensions(bundle)).workflows[0]?.identity).toBe(
        "tiny:review",
      );
      expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
        "read fresh",
      );
    } finally {
      await chmod(nativeRoot, 0o700);
    }
    expect((await refreshExtensionDiscovery(root, bundle)).ok).toBe(true);
    expect(
      await readFile(
        join(root, ".agents/skills/docket-ext-tiny-review/SKILL.md"),
        "utf8",
      ),
    ).toContain("Before every invocation");
  },
);
