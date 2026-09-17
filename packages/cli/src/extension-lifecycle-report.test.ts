import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const CLI = join(import.meta.dir, "index.ts");
const source = join(import.meta.dir, "../../../examples/extensions/minimal");
function cli(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root });
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

test("init and upgrade report extension refresh failures without hiding successful source state or filing an unrelated task", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-discovery-report-"));
  roots.push(root);
  expect(cli(root, "init", "--project", "EXT", "--json").code).toBe(0);
  await mkdir(join(root, ".agents/skills"), { recursive: true });
  expect(
    cli(root, "extension", "install", source, "--enable", "--json").code,
  ).toBe(0);
  const path = join(root, ".agents/skills/docket-ext-tiny-review/SKILL.md");
  const authored =
    "---\nname: docket-ext-tiny-review\n---\nHandwritten instruction.\n";
  await writeFile(path, authored);
  const registry = await readFile(
    join(root, "docket/extensions/registry.json"),
    "utf8",
  );
  for (const operation of ["init", "upgrade"]) {
    const result = cli(
      root,
      operation,
      "--json",
      ...(operation === "upgrade" ? ["--file-task"] : []),
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.extensionDiscovery.ok).toBe(false);
    expect(
      report.extensionDiscovery.diagnostics.some(
        (entry: { remediation: string }) =>
          entry.remediation.includes("extension refresh"),
      ),
    ).toBe(true);
    expect(report.filedTask).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(authored);
    expect(
      await readFile(join(root, "docket/extensions/registry.json"), "utf8"),
    ).toBe(registry);
    const human = cli(root, operation);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("extension error [discovery-conflict]");
    expect(human.stdout).toContain("docket extension refresh");
  }
  // A global inventory error is actionable even after the affected pointer is withdrawn.
  await rm(path);
  await rm(join(root, "docket/extensions/tiny/workflows/review.md"));
  const human = cli(root, "upgrade");
  expect(human.code).toBe(1);
  expect(human.stdout).toContain("extension error");
  expect(human.stdout).toContain("workflows/review.md");
  expect(JSON.parse(cli(root, "task", "list", "--json").stdout)).toEqual([]);
});
