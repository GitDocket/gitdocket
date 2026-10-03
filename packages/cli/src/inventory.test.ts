import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("open epic inventory includes workstreams absent from even full overview and supports complete paging", async () => {
  root = await mkdtemp(join(tmpdir(), "docket-inventory-"));
  await mkdir(join(root, "docket/work/epics"), { recursive: true });
  await writeFile(join(root, "docket.yaml"), "project: INV\nbundle: docket/\n");
  const sources = new Map<string, string>();
  for (const [id, status] of [
    ["INV-1", "todo"],
    ["INV-2", "blocked"],
    ["INV-3", "in-progress"],
    ["INV-4", "done"],
    ["INV-5", "closed"],
  ]) {
    const path = join(root, `docket/work/epics/${id}.md`);
    const source = `---\ntype: Epic\nid: ${id}\ntitle: ${id}\nstatus: ${status}\n---\n\n# Context\n\nChildless or idle epic.\n`;
    sources.set(path, source);
    await writeFile(path, source);
  }
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, CLI, ...args, "--json"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  expect(run("overview", "--full").workstreams).toEqual({
    current: [],
    recentOnly: [],
  });
  const open = run("task", "list", "--type", "Epic");
  expect(open.map((item: { id: string }) => item.id)).toEqual([
    "INV-1",
    "INV-2",
    "INV-3",
  ]);
  expect(run("task", "list", "--type", "Epic", "--all")).toHaveLength(5);
  const paged = [];
  for (let offset = 0; ; offset += 2) {
    const page = run(
      "task",
      "list",
      "--type",
      "Epic",
      "--limit",
      "2",
      "--offset",
      String(offset),
    );
    paged.push(...page);
    if (page.length < 2) break;
  }
  expect(paged).toEqual(open);
  for (const [path, source] of sources)
    expect(await readFile(path, "utf8")).toBe(source);
});
