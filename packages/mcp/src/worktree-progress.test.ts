import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalFileStore, loadBundle, parseConfig } from "@gitdocket/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GitEvidenceIndex } from "../../core/src/git-evidence-index";
import { createDocketServer } from "./server";

test("custom-prefix API, CLI and MCP progress agree and preserve checkout state", async () => {
  const temp = await mkdtemp(join(tmpdir(), "docket-progress-surfaces-"));
  const root = join(temp, "main");
  const worker = join(temp, "worker");
  const exec = async (cwd: string, args: string[]) => {
    const p = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code) throw new Error(err);
    return out;
  };
  const git = (cwd: string, ...args: string[]) => exec(cwd, ["git", ...args]);
  const task = (status: string) =>
    `---\ntype: Task\nid: RS-292\ntitle: Synthetic prefix reproducer\nstatus: ${status}\n---\n\n# Context\n\nSynthetic fixture.\n`;
  await mkdir(join(root, "docket/work/tasks"), { recursive: true });
  await writeFile(join(root, "docket.yaml"), "project: RS\nbundle: docket\n");
  await writeFile(join(root, "docket/work/tasks/item.md"), task("todo"));
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  await git(root, "worktree", "add", "-qb", "worker", worker);
  await writeFile(
    join(worker, "docket/work/tasks/item.md"),
    task("in-progress"),
  );
  const before = await git(root, "status", "--porcelain");
  const foreignBefore = await readFile(
    join(worker, "docket/work/tasks/item.md"),
    "utf8",
  );
  const config = parseConfig("project: RS\nbundle: docket\n");
  const store = new LocalFileStore(join(root, "docket"));
  const owner = new GitEvidenceIndex(root, "Task", { ttlMs: 0 });
  const client = new Client({ name: "qualification", version: "1" });
  const server = createDocketServer(store, config, root);
  try {
    const api = (await owner.snapshot((await loadBundle(store, config)).byId))
      .git.taskProgress;
    const cli = JSON.parse(
      await exec(root, [
        process.execPath,
        resolve(import.meta.dir, "../../cli/src/index.ts"),
        "task",
        "progress",
        "--json",
      ]),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const result = await client.callTool({
      name: "task_progress",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const mcp = JSON.parse(
      (result.content as { text: string }[]).map((c) => c.text).join(""),
    );
    expect(api?.complete).toBe(true);
    expect(cli.complete).toBe(true);
    expect(mcp.complete).toBe(true);
    expect(cli.tasks).toEqual(api?.tasks);
    expect(mcp.tasks).toEqual(api?.tasks);
    expect(mcp.tasks[0]).toMatchObject({
      id: "RS-292",
      localStatus: "todo",
      observations: [
        {
          task: { status: "in-progress" },
          configuration: {
            source: { project: "RS" },
            baseline: { project: "RS" },
          },
        },
      ],
    });
    expect(await git(root, "status", "--porcelain")).toBe(before);
    expect(
      await readFile(join(worker, "docket/work/tasks/item.md"), "utf8"),
    ).toBe(foreignBefore);
  } finally {
    owner.close();
    await client.close();
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
}, 20000);
