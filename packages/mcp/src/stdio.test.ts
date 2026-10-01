import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("the actual stdio --repo pin targets that checkout and rejects a conflicting request before writing", async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "docket-mcp-pin-")));
  const main = join(temp, "main");
  const worker = join(temp, "worker");
  const source = "---\ntype: Task\nid: DKT-1\nstatus: todo\n---\nBody.\n";
  const client = new Client({ name: "pin fixture", version: "1" });
  try {
    for (const root of [main, worker]) {
      await mkdir(join(root, "docket"), { recursive: true });
      await writeFile(
        join(root, "docket.yaml"),
        "project: DKT\nbundle: docket\n",
      );
      await writeFile(join(root, "docket/task.md"), source);
    }
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, "index.ts"), "--repo", worker],
        cwd: main,
        stderr: "pipe",
      }),
    );
    const result = await client.callTool({
      name: "set_status",
      arguments: { id: "DKT-1", to: "in-progress", response: "compact" },
    });
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(
      (result.content as { text: string }[])[0]?.text ?? "null",
    );
    expect(data.checkout.root).toBe(worker);
    expect(data.checkout.selectedBy).toBe("pin");
    const refused = await client.callTool({
      name: "append_log",
      arguments: { id: "DKT-1", entry: "Must not reach main" },
      _meta: { "docket/target": { root: main } },
    });
    expect(refused.isError).toBe(true);
    expect(
      JSON.parse((refused.content as { text: string }[])[0]?.text ?? "null"),
    ).toMatchObject({
      error: { code: "target-mismatch" },
      mutation: "unchanged",
    });
    expect(await readFile(join(main, "docket/task.md"), "utf8")).toBe(source);
    expect(await readFile(join(worker, "docket/task.md"), "utf8")).toContain(
      "status: in-progress",
    );
  } finally {
    await client.close();
    await rm(temp, { recursive: true, force: true });
  }
}, 15000);

test("a retained stdio session observes CLI writes and changed bundle configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-mcp-live-"));
  const client = new Client({ name: "live-test", version: "1" });
  try {
    for (const [name, id] of [
      ["docket", 1],
      ["alternate", 9],
    ] as const) {
      await mkdir(join(root, name));
      await writeFile(
        join(root, name, "a.md"),
        `---\ntype: Task\nid: DKT-${id}\nstatus: todo\n---\n`,
      );
    }
    const config = join(root, "docket.yaml");
    await writeFile(config, "project: DKT\nbundle: docket\n");
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, "index.ts")],
        cwd: root,
        stderr: "pipe",
      }),
    );
    const ready = async () => {
      const result = await client.callTool({ name: "ready", arguments: {} });
      return JSON.parse(
        (result.content as { text: string }[])[0]?.text ?? "null",
      ) as { id: string }[];
    };
    expect((await ready()).map((item) => item.id)).toEqual(["DKT-1"]);
    const cli = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../cli/src/index.ts"),
        "task",
        "create",
        "--title",
        "External CLI write",
        "--json",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, output] = await Promise.all([
      cli.exited,
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect((await ready()).map((item) => item.id)).toContain(
      JSON.parse(output).id,
    );
    await writeFile(config, "project: DKT\nbundle: alternate\n");
    expect((await ready()).map((item) => item.id)).toEqual(["DKT-9"]);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("the stdio entry exits on EOF without a retained transport or repository owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-mcp-eof-"));
  try {
    await mkdir(join(root, "docket"));
    await writeFile(
      join(root, "docket.yaml"),
      "project: DKT\nbundle: docket\n",
    );
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts")],
      { cwd: root, stdin: new Blob([]), stdout: "pipe", stderr: "pipe" },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 3000);
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    clearTimeout(timer);
    expect(timedOut).toBe(false);
    expect(code).toBe(0);
    expect(stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brief and full overviews agree across actual CLI and stdio MCP without repository writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-overview-parity-"));
  const client = new Client({ name: "overview-parity", version: "1" });
  try {
    await mkdir(join(root, "docket"));
    await writeFile(
      join(root, "docket.yaml"),
      "project: DKT\nbundle: docket\n",
    );
    for (let id = 1; id <= 60; id++)
      await writeFile(
        join(root, `docket/${id}.md`),
        `---\ntype: Task\nid: DKT-${id}\ntitle: Work ${id}\nstatus: ${id === 1 ? "todo" : id % 2 ? "in-review" : "in-progress"}\n---\n`,
      );
    const readFiles = async () => {
      const result: Record<string, string> = {};
      const glob = new Bun.Glob("**/*");
      for await (const path of glob.scan({
        cwd: root,
        dot: true,
        onlyFiles: true,
      }))
        result[path] = await Bun.file(join(root, path)).text();
      return result;
    };
    const before = await readFiles();
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, "index.ts")],
        cwd: root,
        stderr: "pipe",
      }),
    );
    const mcp = async (view?: "brief" | "full") => {
      const result = await client.callTool({
        name: "overview",
        arguments: view ? { view } : {},
      });
      expect(result.isError).not.toBe(true);
      return JSON.parse(
        (result.content as { text: string }[])[0]?.text ?? "null",
      );
    };
    const cli = async (full = false) => {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../../cli/src/index.ts"),
          "overview",
          "--json",
          ...(full ? ["--full"] : []),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      return JSON.parse(out);
    };
    const brief = await cli();
    expect(brief.format).toBe("agent-overview/v1");
    expect(brief.loose.active.total).toBe(59);
    expect(brief.loose.active.items).toHaveLength(3);
    expect(brief.contextProblem).toBe("missing");
    expect(await mcp()).toEqual(brief);
    expect(await mcp("brief")).toEqual(brief);
    const full = await cli(true);
    const mcpFull = await mcp("full");
    // Both calls compute the moving fortnight boundary at request time.
    if (
      full.execution.scope.after !== null &&
      mcpFull.execution.scope.after !== null
    ) {
      expect(
        Math.abs(
          Date.parse(full.execution.scope.after) -
            Date.parse(mcpFull.execution.scope.after),
        ),
      ).toBeLessThan(5000);
      mcpFull.execution.scope.after = full.execution.scope.after;
    }
    expect(mcpFull).toEqual(full);
    expect(full.loose.now).toHaveLength(30);
    expect(full).not.toHaveProperty("format");
    expect(await readFiles()).toEqual(before);
    await writeFile(join(root, "docket/overview.md"), "bad note");
    expect((await mcp()).contextProblem).toBe("malformed");
    expect((await cli()).contextProblem).toBe("malformed");
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
