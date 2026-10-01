import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { lintBundle } from "./lint";
import {
  compareLintReports,
  lintSummary,
  makeLintReport,
  parseLintBaseline,
  readLintBaseline,
  writeLintReport,
} from "./lint-report";

const config = parseConfig("project: FIX\nbundle: docket\n");
const now = new Date("2026-10-01T00:00:00Z");
const reference = (body: string) =>
  `---\ntype: Reference\ntitle: Fixture\n---\n\n${body}\n`;
const task = (deps: string) =>
  `---\ntype: Task\ntitle: Fixture\nid: FIX-1\nstatus: todo\ndepends_on: [${deps}]\n---\n\n# Context\n\nQualified source.\n`;
async function report(
  files: Record<string, string>,
  scope = "fixture",
  inputs = { now },
) {
  const sources = new Map(Object.entries(files));
  const store = new InMemoryFileStore(sources);
  return makeLintReport(
    await lintBundle(store, await loadBundle(store, config), inputs),
    sources,
    config,
    inputs,
    scope,
    now,
  );
}
test("noisy warnings retain complete evidence and prioritized new errors/wraps below 8 KiB", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 110 }, (_, i) => [
      `reference/legacy-${i}.md`,
      reference(
        Array.from(
          { length: 10 },
          (_, j) => `Legacy paragraph ${i}/${j}\nis wrapped.`,
        ).join("\n\n"),
      ),
    ]),
  );
  const before = await report(files);
  const after = await report({
    ...files,
    "reference/new.md": reference("New paragraph\nis wrapped."),
    "work/tasks/FIX-1-new.md": task("FIX-999"),
  });
  const baseline = parseLintBaseline(JSON.stringify(before));
  expect(baseline.status).toBe("available");
  const summary = lintSummary(after, baseline, { paths: ["reference/new.md"] });
  expect(summary.global).toMatchObject({
    total: 1102,
    error: 1,
    warning: 1101,
  });
  expect(summary.delta).toMatchObject({
    preExisting: 1100,
    introduced: 2,
    resolved: 0,
    unknown: 0,
  });
  expect(summary.diagnostics.map((d) => d.code)).toEqual([
    "dependency.unresolved",
    "markdown.hard-wrap",
  ]);
  expect(summary.diagnostics.every((d) => d.state === "introduced")).toBe(true);
  expect(
    Buffer.byteLength(JSON.stringify(summary, null, 2)),
  ).toBeLessThanOrEqual(8192);
  expect(after.diagnostics).toHaveLength(1102);
  expect(summary.details.cli).toBe("docket lint --json");
});
test("full relationship validation remains visible when the changed source is another file", async () => {
  const before = await report({
    "reference/target.md": reference("Present."),
    "reference/link.md": reference("[Target](/reference/target.md)."),
  });
  const after = await report({
    "reference/link.md": reference("[Target](/reference/target.md)."),
    "work/tasks/FIX-1-new.md": task("FIX-999"),
  });
  const summary = lintSummary(
    after,
    { status: "available", report: before },
    { paths: ["reference/target.md"] },
  );
  expect(summary.diagnostics.map((d) => d.code)).toEqual([
    "dependency.unresolved",
    "link.unresolved",
  ]);
  expect(summary.global.error).toBe(1);
});
test("line movement preserves prose evidence; clean edits resolve rather than introduce warnings", async () => {
  const path = "reference/a.md";
  const before = await report({
    [path]: reference("Same paragraph\nis wrapped."),
  });
  const moved = await report({
    [path]: reference("# New heading\n\nSame paragraph\nis wrapped."),
  });
  expect(
    compareLintReports(moved, { status: "available", report: before }).counts,
  ).toMatchObject({ preExisting: 1, introduced: 0, resolved: 0 });
  const clean = await report({
    [path]: reference("Same paragraph is wrapped."),
  });
  expect(
    lintSummary(clean, { status: "available", report: before }).delta,
  ).toMatchObject({ preExisting: 0, introduced: 0, resolved: 1 });
});
test("unique identical-content relocation is explicit; ambiguous relocation remains unknown", async () => {
  const source = reference("Same paragraph\nis wrapped.");
  const before = await report({ "reference/old.md": source });
  const moved = await report({ "reference/new.md": source });
  const summary = lintSummary(moved, { status: "available", report: before });
  expect(summary.delta).toMatchObject({
    preExisting: 1,
    introduced: 0,
    resolved: 0,
  });
  expect(summary.relocations).toEqual([
    { from: "reference/old.md", to: "reference/new.md" },
  ]);
  const ambiguous = lintSummary(
    await report({ "reference/new.md": source, "reference/other.md": source }),
    { status: "available", report: before },
  );
  expect(ambiguous.delta).toMatchObject({
    preExisting: 0,
    introduced: 0,
    resolved: 0,
    unknown: 2,
    resolvedUnknown: 1,
  });
});
test("absent, tampered, legacy-array, wrong-scope and different coverage baselines never imply a clean change", async () => {
  const current = await report({
    "reference/a.md": reference("Wrap\nwarning."),
  });
  const tampered = structuredClone(current);
  tampered.diagnostics = [];
  for (const baseline of [
    undefined,
    parseLintBaseline("[]"),
    parseLintBaseline(JSON.stringify(tampered)),
    {
      status: "available" as const,
      report: await report(
        { "reference/a.md": reference("Wrap\nwarning.") },
        "other-checkout",
      ),
    },
  ]) {
    const summary = lintSummary(current, baseline);
    expect(summary.delta.introduced).toBeNull();
    expect(summary.delta.resolved).toBeNull();
    expect(summary.delta.unknown).toBe(1);
    expect(summary.resolved).toBeNull();
  }
  const covered = makeLintReport(
    current.diagnostics,
    new Map(),
    config,
    { now, trailerlessCommits: 1 },
    "fixture",
    now,
  );
  expect(
    lintSummary(current, { status: "available", report: covered }).baseline
      .status,
  ).toBe("partial");
});
test("pagination and omitted messages retain source references and complete routes", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [
      `reference/a-${i}.md`,
      reference(`${"Words ".repeat(200)}\nWrapped.`),
    ]),
  );
  const current = await report(files);
  const first = lintSummary(current, undefined, { limit: 3 });
  const second = lintSummary(current, undefined, {
    limit: 3,
    offset: first.selection.nextOffset as number,
  });
  expect(first.selection.shown).toBe(3);
  expect(first.selection.omitted).toBe(27);
  expect(first.diagnostics[0]?.messageOmitted).toBe(false);
  expect(
    new Set([...first.diagnostics, ...second.diagnostics].map((d) => d.path))
      .size,
  ).toBe(6);
  expect(() => lintSummary(current, undefined, { limit: 0 })).toThrow();
});
test("unobserved Git checks remain unknown while compatible source warnings still compare", async () => {
  const files = {
    "reference/a.md": reference("Wrap\nwarning."),
    "log.md": "**Freshness** — reviewed through abcdef0\n",
  };
  const sources = new Map(Object.entries(files)),
    store = new InMemoryFileStore(sources),
    bundle = await loadBundle(store, config);
  const oldInputs = { now, trailerlessCommits: 1 };
  const old = makeLintReport(
    await lintBundle(store, bundle, oldInputs),
    sources,
    config,
    oldInputs,
    "fixture",
    now,
  );
  const current = await report(files);
  const summary = lintSummary(current, { status: "available", report: old });
  expect(summary.baseline.status).toBe("partial");
  expect(summary.delta).toMatchObject({
    preExisting: 1,
    introduced: 0,
    resolved: 0,
    resolvedUnknown: 1,
  });
  expect(summary.resolved?.total).toBe(0);
});
test("saved artifacts retain integrity and checkout-contained reads refuse escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-lint-artifact-"));
  try {
    const current = await report({
      "reference/a.md": reference("Wrap\nwarning."),
    });
    const artifact = await writeLintReport(
      join(root, "reports/before.json"),
      current,
    );
    expect(artifact.bytes).toBe(
      Buffer.byteLength(await readFile(artifact.path, "utf8")),
    );
    expect((await readLintBaseline("reports/before.json", root)).status).toBe(
      "available",
    );
    expect((await readLintBaseline("../outside.json", root)).status).toBe(
      "unavailable",
    );
    expect(
      (await readLintBaseline(join(root, "reports/before.json"), root)).status,
    ).toBe("unavailable");
    await writeFile(join(root, "outside.md"), "Untouched");
    await symlink(join(root, "outside.md"), join(root, "report.json"));
    await expect(
      writeLintReport(join(root, "report.json"), current),
    ).rejects.toThrow();
    expect(await readFile(join(root, "outside.md"), "utf8")).toBe("Untouched");
    await mkdir(join(root, "directory.json"));
    await expect(
      writeLintReport(join(root, "directory.json"), current),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
