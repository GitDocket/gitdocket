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
