import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalFileStore, parseConfig } from "@gitdocket/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createDocketServer } from "../../mcp/src/server";
import { createApp } from "./app";
import { ProgressBadge } from "./client/App";
import { createRepoContext } from "./state";

function git(root: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
function write(root: string, id: string, status: string) {
  writeFileSync(
    join(root, "docket", `${id}.md`),
    `---\ntype: Task\nid: ${id}\ntitle: ${id}\nstatus: ${status}\nepic: /epic.md\n${id === "DKT-2" ? "depends_on: [DKT-1]\n" : ""}---\n`,
  );
}

test("browser, CLI and MCP expose pre-commit progress while edits and readiness stay local", async () => {
  const parent = mkdtempSync(join(tmpdir(), "docket-progress-surfaces-"));
  const root = join(parent, "main");
  mkdirSync(join(root, "docket"), { recursive: true });
  writeFileSync(join(root, "docket.yaml"), "project: DKT\nbundle: docket/\n");
  writeFileSync(
    join(root, "docket/epic.md"),
    "---\ntype: Epic\nid: DKT-10\ntitle: Example epic\nstatus: todo\n---\n",
  );
  write(root, "DKT-1", "todo");
  write(root, "DKT-2", "todo");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  const worker = join(parent, "worker");
  git(root, "worktree", "add", "-qb", "feature", worker);
  write(worker, "DKT-1", "done");
  write(worker, "DKT-3", "in-progress");
  mkdirSync(join(worker, ".docket"));
  writeFileSync(join(worker, ".docket/active-task"), "DKT-1");
  const config = parseConfig("project: DKT\nbundle: docket/");
  const ctx = createRepoContext(root, config);
  const app = createApp(ctx);
  const client = new Client({ name: "qualification", version: "1" });
  const server = createDocketServer(
    new LocalFileStore(join(root, "docket")),
    config,
    root,
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(ct), server.connect(st)]);
    const get = async (path: string) =>
      (await app.request(`/api/${path}`)).json();
    const observed = await get("task-progress?epic=DKT-10");
    expect(observed.complete).toBe(true);
    expect(observed.tasks.map((p: { id: string }) => p.id)).toEqual([
      "DKT-1",
      "DKT-3",
    ]);
    const items = (await get("tasks")).items;
    expect(items.find((t: { id: string }) => t.id === "DKT-1")).toMatchObject({
      status: "todo",
      ready: true,
      progress: { pickedUpElsewhere: true },
    });
    expect(items.find((t: { id: string }) => t.id === "DKT-2").ready).toBe(
      false,
    );
    expect((await get("epics")).epics[0]).toMatchObject({
      done: 0,
      total: 2,
      observedChildren: 2,
    });
    expect(
      (await get("concept/DKT-1.md")).progress.observations[0].task.status,
    ).toBe("done");
    const cli = Bun.spawnSync(
      [
        process.execPath,
        resolve(import.meta.dir, "../../cli/src/index.ts"),
        "task",
        "progress",
        "--json",
      ],
      { cwd: root },
    );
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout.toString()).tasks).toEqual(observed.tasks);
    const call = async (name: string, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).not.toBe(true);
      return JSON.parse((r.content as { text: string }[])[0]?.text ?? "null");
    };
    expect((await call("task_progress")).tasks).toEqual(observed.tasks);
    expect(await call("task_get", { id: "DKT-3" })).toMatchObject({
      foreignOnly: true,
      status: null,
    });
    expect((await call("ready")).map((t: { id: string }) => t.id)).toEqual([
      "DKT-1",
    ]);
    const html = renderToStaticMarkup(
      <ProgressBadge progress={observed.tasks[0]} />,
    );
    expect(html).toContain("awaiting integration");
    expect(html).toContain("feature");
    expect(html).toContain("uncommitted");
    expect(
      (
        await app.request("/api/tasks/DKT-3/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "done" }),
        })
      ).status,
    ).not.toBe(200);
    expect(git(root, "status", "--porcelain")).toBe("");
    write(worker, "DKT-1", "blocked");
    ctx.invalidateGit();
    expect(
      (await get("task-progress?id=DKT-1")).tasks[0].observations[0].task
        .status,
    ).toBe("blocked");
  } finally {
    ctx.close();
    await client.close();
    await server.close();
    rmSync(parent, { recursive: true, force: true });
  }
}, 15000);

test("browser assets build with the pure progress presentation module", async () => {
  // Bun 1.3.14 cannot reliably repeat Bun.build in the shared test process.
  // Keep this real build isolated so Serve's integration build remains valid.
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'import { buildAssets } from "./packages/web/src/serve"; const assets = await buildAssets(); console.log(JSON.stringify({ progress: assets.js.includes("awaiting integration"), css: assets.css.includes("worktree-progress") }));',
    ],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ progress: true, css: true });
}, 15000);
