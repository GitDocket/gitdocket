import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "index.ts");

test("large successful and failing JSON survives actual pipes and file redirection", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-output-"));
  try {
    await mkdir(join(root, "docket"));
    await writeFile(
      join(root, "docket.yaml"),
      "project: DKT\nbundle: docket\n",
    );
    for (let start = 1; start <= 1600; start += 32) {
      await Promise.all(
        Array.from({ length: 32 }, (_, n) => start + n).map((id) =>
          writeFile(
            join(root, "docket", `${id}.md`),
            `---\ntype: Task\nid: DKT-${id}\nstatus: todo\ntitle: ${"long title ".repeat(24)}${id}\n---\n\n[broken](/${"missing-target-".repeat(24)}${id}.md)\n`,
          ),
        ),
      );
    }
    const invoke = async (args: string[], file?: string) => {
      const child = Bun.spawn([process.execPath, cli, ...args, "--json"], {
        cwd: root,
        stdout: file ? Bun.file(file) : "pipe",
        stderr: "pipe",
      });
      const [pipe, stderr, code] = await Promise.all([
        typeof child.stdout === "number" || child.stdout === null
          ? Promise.resolve("")
          : new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const stdout = file ? await readFile(file, "utf8") : pipe;
      return { stdout, stderr, code, data: JSON.parse(stdout) };
    };
    for (const args of [
      ["task", "list", "--all"],
      ["ready"],
      ["lint", "--strict"],
    ]) {
      const pipe = await invoke(args);
      const file = await invoke(args, join(root, "output.json"));
      expect(pipe.stdout.length).toBeGreaterThan(500000);
      expect(file.stdout).toBe(pipe.stdout);
      expect(pipe.data.length).toBeGreaterThanOrEqual(1600);
      expect(pipe.code).toBe(args[0] === "lint" ? 1 : 0);
      expect(file.code).toBe(pipe.code);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
