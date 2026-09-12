import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config";
import { LocalFileStore } from "./filestore";
import { appendLog, setPriority, setRank } from "./ops";

const source = "---\ntype: Task\nid: DKT-1\nstatus: todo\npriority: p2\n---\n";
test("separate stores and processes preserve every concurrent append and field edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-mutations-"));
  try {
    const bundle = join(root, "docket");
    await mkdir(bundle);
    await writeFile(
      join(root, "docket.yaml"),
      "project: DKT\nbundle: docket\n",
    );
    await writeFile(join(bundle, "a.md"), source);
    const config = parseConfig();
    const tokens = ["first", "second", "third", "fourth"];
    await Promise.all(
      tokens.map((token) =>
        appendLog(new LocalFileStore(bundle), config, "DKT-1", token),
      ),
    );
    await Promise.all([
      setPriority(new LocalFileStore(bundle), config, "DKT-1", "p0"),
      setRank(new LocalFileStore(bundle), config, "DKT-1", 17),
    ]);
    await Promise.all(
      tokens.map(async (token) => {
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "../../cli/src/index.ts"),
            "task",
            "log",
            "DKT-1",
            `process-${token}`,
          ],
          { cwd: root, stdout: "pipe", stderr: "pipe" },
        );
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]);
        expect(code).toBe(0);
        expect(stderr).toBe("");
      }),
    );
    const final = await readFile(join(bundle, "a.md"), "utf8");
    for (const token of tokens) {
      expect(final).toContain(`— ${token}`);
      expect(final).toContain(`— process-${token}`);
    }
    expect(final).toContain("priority: p0");
    expect(final).toContain("rank: 17");
    expect(
      await Bun.file(join(bundle, ".docket-mutation.lock/owner.json")).exists(),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("failed mutations release their lock, stale owners recover, and hidden locks are never concepts", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-mutation-recovery-"));
  try {
    const store = new LocalFileStore(root);
    await store.write("a.md", source);
    await expect(
      store.withMutation(async () => {
        expect(await store.list()).toEqual(["a.md"]);
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    const lock = join(root, ".docket-mutation.lock");
    expect(await Bun.file(join(lock, "owner.json")).exists()).toBe(false);
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        pid: 2147483647,
        host: hostname(),
        startedAt: new Date().toISOString(),
      }),
    );
    await appendLog(store, parseConfig(), "DKT-1", "Recovered entry");
    expect(await store.read("a.md")).toContain("Recovered entry");
    expect(await Bun.file(join(lock, "owner.json")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
