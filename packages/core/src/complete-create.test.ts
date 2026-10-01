import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDocketServer } from "../../mcp/src/server";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore, LocalFileStore } from "./filestore";
import type { WorkItemIdCoordinator } from "./id-allocation";
import { createWorkItem } from "./ops";

const body =
  "# Context\r\n\r\nA complete long paragraph with [a reference](/reference/guide.md) and intentional line breaks preserved.\r\n\r\n# Acceptance Criteria\r\n\r\n- [ ] Verify the accepted behavior.\r\n\r\n```text\r\nfirst\r\nsecond\r\n```\r\n";
class Counted extends InMemoryFileStore {
  publications = 0;
  writes = 0;
  override async createExclusive(path: string, source: string) {
    this.publications++;
    return super.createExclusive(path, source);
  }
  override async write(path: string, source: string) {
    this.writes++;
    return super.write(path, source);
  }
}
for (const type of ["Task", "Epic"] as const)
  test(`complete ${type} creation publishes exactly one final source with a usable version`, async () => {
    const store = new Counted(new Map()),
      config = parseConfig();
    const result = await createWorkItem(store, config, {
      title: "Complete authored work",
      type,
      body,
      tags: ["comma, tag", "bracket [tag]", "quoted: value"],
      dependsOn: ["DKT-2"],
      rank: 4,
    });
    const source = await store.read(result.path);
    expect(store.publications).toBe(1);
    expect(store.writes).toBe(0);
    expect(source.endsWith(body)).toBe(true);
    expect(source).not.toContain("(links to specs/docs here)");
    expect(result.version).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
    const item = (await loadBundle(store, config)).byId(result.id);
    expect(item?.fm).toMatchObject({
      type,
      status: "todo",
      tags: ["comma, tag", "bracket [tag]", "quoted: value"],
      depends_on: ["DKT-2"],
      rank: 4,
    });
  });
test("invalid complete bodies and metadata fail before allocation or publication", async () => {
  let allocations = 0;
  const coordinator: WorkItemIdCoordinator = {
    allocate: async (_prefix, create) => {
      allocations++;
      return create(new Set());
    },
  };
  const store = new Counted(new Map()),
    config = parseConfig();
  for (const input of [
    { title: "Bad", body: " " },
    { title: "Bad", body: "a\0b" },
    { title: "Bad", body: "🧾".repeat(20000) },
    { title: "Bad", body, rank: Infinity },
    { title: "Bad", body, priority: "p9" },
    { title: "Bad", body, extraField: true },
  ]) {
    await expect(
      createWorkItem(
        store,
        config,
        input as Parameters<typeof createWorkItem>[2],
        coordinator,
      ),
    ).rejects.toThrow();
  }
  expect(allocations).toBe(0);
  expect(store.publications).toBe(0);
  expect(await store.list()).toEqual([]);
});
test("exclusive collision refuses publication and retains the occupied source", async () => {
  class Colliding extends Counted {
    override async createExclusive(path: string) {
      await super.createExclusive(path, "occupied unrelated source");
      return false;
    }
  }
  const store = new Colliding(new Map());
  await expect(
    createWorkItem(store, parseConfig(), { title: "Collision", body }),
  ).rejects.toThrow("destination already exists");
  expect(await store.read((await store.list())[0] ?? "")).toBe(
    "occupied unrelated source",
  );
});
test("MCP complete creation returns compact source versions and leaves validation until the final batch", async () => {
  const store = new Counted(new Map()),
    server = createDocketServer(store, parseConfig());
  const client = new Client({ name: "complete-create", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(ct), server.connect(st)]);
    const result = await client.callTool({
      name: "task_create",
      arguments: {
        title: "Complete Epic",
        type: "Epic",
        body,
        response: "compact",
      },
    });
    expect(result.isError).not.toBe(true);
    const receipt = JSON.parse(
      (result.content as { text: string }[])[0]?.text ?? "",
    );
    expect(receipt.version).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.remaining).toContain(
      "refresh required discovery after the source batch",
    );
    expect(await store.read(receipt.path)).toEndWith(body);
    expect(store.publications).toBe(1);
    expect(store.writes).toBe(0);
    const invalid = await client.callTool({
      name: "task_create",
      arguments: { title: "Invalid", body: "\0", response: "compact" },
    });
    expect(invalid.isError).toBe(true);
    expect(store.publications).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});
test("structured CLI creation and legacy flags share linked-worktree reservations without selecting active work", async () => {
  const temp = await mkdtemp(join(tmpdir(), "docket-complete-create-")),
    root = join(temp, "main"),
    worker = join(temp, "worker");
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
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
  try {
    await mkdir(join(root, "docket/work/tasks"), { recursive: true });
    await writeFile(
      join(root, "docket.yaml"),
      "project: DKT\nbundle: docket\n",
    );
    await writeFile(
      join(root, "docket/guide.md"),
      "---\ntype: Reference\ntitle: Fixture guide\n---\n\nTracked bundle source.\n",
    );
    await git("init", "-q");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("worktree", "add", "-qb", "worker", worker);
    const marker = "DKT-777\n";
    await mkdir(join(root, ".docket"));
    await writeFile(join(root, ".docket/active-task"), marker);
    const input = join(temp, "create.json");
    await writeFile(
      input,
      JSON.stringify({ title: "Complete initial source", type: "Epic", body }),
    );
    const cli = async (cwd: string, args: string[], expected = 0) => {
      const p = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../cli/src/index.ts"),
          "task",
          "create",
          ...args,
          "--compact",
          "--json",
        ],
        { cwd, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (code !== expected) throw new Error(err || out);
      return JSON.parse(out);
    };
    const results = await Promise.all([
      cli(root, ["--input", input]),
      cli(worker, ["--title", "Legacy skeleton"]),
    ]);
    expect(new Set(results.map((result) => result.id)).size).toBe(2);
    expect(
      await new LocalFileStore(join(root, "docket")).read(results[0].path),
    ).toEndWith(body);
    expect(
      await new LocalFileStore(join(worker, "docket")).read(results[1].path),
    ).toContain("- [ ] …");
    expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
      marker,
    );
    const bad = await cli(
      root,
      ["--input", input, "--title", "Mixed flags"],
      1,
    );
    expect(bad).toMatchObject({
      mutation: "unchanged",
      error: { code: "invalid-request" },
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
