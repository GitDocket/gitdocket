import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "index.ts");
let root: string;
const reference = (body: string) =>
  `---\ntype: Reference\ntitle: Fixture\n---\n\n${body}\n`;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-lint-summary-"));
  await mkdir(join(root, "docket/reference"), { recursive: true });
  await writeFile(join(root, "docket.yaml"), "project: FIX\nbundle: docket\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));
const run = (...args: string[]) => {
  const p = Bun.spawnSync([process.execPath, cli, "lint", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
};
const json = (...args: string[]) => {
  const p = run(...args, "--json");
  return { ...p, data: JSON.parse(p.stdout) };
};
test("CLI keeps full arrays/exit policy while one bounded result saves all noisy evidence and highlights new findings", async () => {
  await writeFile(
    join(root, "docket/reference/legacy.md"),
    reference(
      Array.from(
        { length: 1100 },
        (_, i) => `Legacy paragraph ${i}\nis wrapped.`,
      ).join("\n\n"),
    ),
  );
  const full = json();
  expect(full.code).toBe(0);
  expect(Array.isArray(full.data)).toBe(true);
  expect(full.data).toHaveLength(1100);
  const before = json("--summary", "--report", ".docket/lint/before.json");
  expect(before.code).toBe(0);
  expect(before.data.global.warning).toBe(1100);
  expect(before.data.artifact.bytes).toBeGreaterThan(8192);
  await writeFile(
    join(root, "docket/reference/new.md"),
    reference("New paragraph\nis wrapped."),
  );
  await mkdir(join(root, "docket/work/tasks"), { recursive: true });
  await writeFile(
    join(root, "docket/work/tasks/FIX-1-new.md"),
    "---\ntype: Task\ntitle: New\nid: FIX-1\nstatus: todo\ndepends_on: [FIX-999]\n---\n\n# Context\n\nFixture.\n",
  );
  const result = json(
    "--baseline",
    ".docket/lint/before.json",
    "--changed-path",
    "reference/new.md",
    "--report",
    ".docket/lint/after.json",
  );
  expect(result.code).toBe(1);
  expect(result.data.delta).toMatchObject({
    introduced: 2,
    preExisting: 1100,
    resolved: 0,
  });
  expect(result.data.diagnostics.map((d: { code: string }) => d.code)).toEqual([
    "dependency.unresolved",
    "markdown.hard-wrap",
  ]);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8193);
  const saved = JSON.parse(
    await readFile(join(root, ".docket/lint/after.json"), "utf8"),
  );
  expect(saved.complete).toBe(true);
  expect(saved.diagnostics).toHaveLength(1102);
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(
    Buffer.byteLength(full.stdout) / 10,
  );
});
test("hidden legacy warnings still fail strict validation; unavailable baseline remains unknown", async () => {
  await writeFile(
    join(root, "docket/reference/legacy.md"),
    reference("Legacy\nwrap."),
  );
  const selected = json(
    "--summary",
    "--strict",
    "--changed-path",
    "reference/clean.md",
  );
  expect(selected.code).toBe(1);
  expect(selected.data.selection.total).toBe(0);
  expect(selected.data.global.warning).toBe(1);
  const unknown = json(
    "--baseline",
    "missing.json",
    "--changed-path",
    "reference/clean.md",
  );
  expect(unknown.code).toBe(0);
  expect(unknown.data.baseline.status).toBe("unavailable");
  expect(unknown.data.delta.introduced).toBeNull();
  expect(unknown.data.delta.resolved).toBeNull();
  const human = run("--summary", "--strict");
  expect(human.code).toBe(1);
  expect(human.stdout).toContain("1 warnings globally");
  expect(human.stdout).toContain("Delta: unknown introduced");
  expect(human.stdout).toContain("markdown.hard-wrap");
});
test("invalid selection or report destination cannot silently replace authored sources", async () => {
  const path = join(root, "docket/reference/source.md"),
    source = reference("Clean source.");
  await writeFile(path, source);
  expect(
    json("--summary", "--limit", "0", "--report", ".docket/unwritten.json")
      .code,
  ).toBe(1);
  expect(
    await readFile(join(root, ".docket/unwritten.json"), "utf8").catch(
      () => null,
    ),
  ).toBeNull();
  expect(json("--summary", "--report", "docket/reference/source.md").code).toBe(
    1,
  );
  expect(await readFile(path, "utf8")).toBe(source);
  await writeFile(join(root, "package.json"), '{"name":"owned-source"}\n');
  expect(json("--summary", "--report", "package.json").code).toBe(1);
  expect(await readFile(join(root, "package.json"), "utf8")).toBe(
    '{"name":"owned-source"}\n',
  );
});
