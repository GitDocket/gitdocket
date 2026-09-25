import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");
test("CLI direct guidance reads preserve tracker state and match tracked context", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-guidance-cli-"));
  const cli = (...args: string[]) => {
    const process = Bun.spawnSync(["bun", CLI, ...args], { cwd: root });
    expect(process.exitCode).toBe(0);
    return JSON.parse(process.stdout.toString());
  };
  try {
    await mkdir(join(root, "docket/reference"), { recursive: true });
    await mkdir(join(root, ".docket"), { recursive: true });
    await writeFile(
      join(root, "docket.yaml"),
      "project: FIX\nbundle: docket/\n",
    );
    await writeFile(join(root, ".docket/active-task"), "FIX-999\n");
    expect(cli("guidance", "--json").status).toBe("absent");
    expect(await Bun.file(join(root, "docket/index.md")).exists()).toBe(false);
    const source =
      "---\ntype: Reference\n---\nRequirement: use TDD for behavioral changes.\n";
    await writeFile(join(root, "docket/reference/project-guidance.md"), source);
    const guidance = cli("guidance", "--json");
    expect(guidance.source.text).toBe(source);
    expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
      "FIX-999\n",
    );
    expect(await Bun.file(join(root, "docket/index.md")).exists()).toBe(false);
    await rm(join(root, ".docket/active-task"));
    const { id } = cli(
      "task",
      "create",
      "--title",
      "Small behavior change",
      "--json",
    );
    const packet = cli("task", "start", id, "--json");
    expect(packet.guidance).toEqual(guidance);
    expect(packet.task.fm.id).toBe(id);
    expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
      `${id}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI wiki example uses a custom bundle and preserves unrelated active work", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-wiki-cli-"));
  const run = (...args: string[]) =>
    Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root });
  const cli = (...args: string[]) => {
    const result = run(...args);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  try {
    await mkdir(join(root, "knowledge"));
    await mkdir(join(root, ".docket"));
    await writeFile(
      join(root, "docket.yaml"),
      "project: FIX\nbundle: knowledge/\n",
    );
    await writeFile(join(root, ".docket/active-task"), "FIX-999\n");
    const input = join(root, "page.json");
    await writeFile(
      input,
      JSON.stringify({
        path: "reference/cache.md",
        type: "Reference",
        title: "Cache",
        description: "Cache behavior.",
        tags: ["architecture"],
        body: "# Cache\n\nKeys expire after five minutes.\n",
      }),
    );
    expect(cli("search", "cache", "--json")).toEqual([]);
    cli("document", "create", "--input", input, "--json");
    expect(
      run("document", "create", "--input", input, "--json").exitCode,
    ).not.toBe(0);
    const draft = cli("document", "read", "reference/cache.md", "--json");
    await writeFile(
      input,
      JSON.stringify({
        expectedVersion: draft.version,
        patch: { body: "# Cache\n\nKeys expire after ten minutes.\n" },
      }),
    );
    cli("document", "edit", "reference/cache.md", "--input", input, "--json");
    expect(
      run("document", "edit", "reference/cache.md", "--input", input, "--json")
        .exitCode,
    ).not.toBe(0);
    expect(run("index").exitCode).toBe(0);
    expect(cli("search", "cache", "--json").length).toBeGreaterThan(0);
    expect(cli("lint", "--json")).toEqual([]);
    expect(await readFile(join(root, "knowledge/index.md"), "utf8")).toContain(
      "reference/cache.md",
    );
    expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
      "FIX-999\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
