import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
