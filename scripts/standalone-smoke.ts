import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { shippedHistory } from "../packages/core/src/shipped";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { verifyUpgradeCompatibility } from "./upgrade-compatibility";

/** The test harness uses Bun; every product subprocess has only Git and Docket on PATH. */
export async function smokeStandalone(
  directory: string,
  options: { node?: boolean; onTools?: (names: string[]) => void } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "gitdocket-standalone-smoke-"));
  const bin = join(root, "bin");
  const project = join(root, "project");
  await mkdir(bin);
  await mkdir(project);
  const git = Bun.which("git");
  assert(git, "Git is required for product upgrade verification");
  await symlink(git, join(bin, "git"));
  if (options.node) {
    const node = Bun.which("node");
    assert(node, "Node is required by the npm launchers");
    await symlink(node, join(bin, "node"));
  }
  for (const name of ["docket", "docket-mcp"]) {
    if (options.node) await symlink(join(directory, name), join(bin, name));
    else await copyFile(join(directory, name), join(bin, name));
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("BUN_"),
    ),
  ) as Record<string, string>;
  env.PATH = bin;
  for (const runtime of options.node
    ? ["bun", "npm", "npx"]
    : ["bun", "node", "npm", "npx"]) {
    assert.equal(Bun.which(runtime, { PATH: bin }), null);
  }
  const cli = join(bin, "docket");
  const mcp = join(bin, "docket-mcp");
  const run = (args: string[], cwd = project, allowed = [0]) => {
    const result = Bun.spawnSync(args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    assert(
      allowed.includes(result.exitCode),
      `${args.join(" ")} failed: ${result.stderr}`,
    );
    return result.stdout.toString().trim();
  };
  try {
    assert.equal(run([cli, "--version"]), DOCKET_VERSION);
    assert.equal(run([mcp, "--version"]), DOCKET_VERSION);
    run([git, "init", "-q"]);
    const initialized = JSON.parse(
      run([
        cli,
        "init",
        "--project",
        "BIN",
        "--agent",
        "codex",
        "--agent",
        "claude",
        "--json",
      ]),
    );
    assert(
      initialized.steps.some(
        (step: { path: string; action: string }) =>
          step.path.includes("mcp") && step.action === "create",
      ),
    );
    const created = JSON.parse(
      run([
        cli,
        "task",
        "create",
        "--title",
        "Verify standalone installation",
        "--json",
      ]),
    );
    assert.equal(created.id, "BIN-1");
    assert(
      JSON.parse(run([cli, "ready", "--json"])).some(
        (task: { id: string }) => task.id === created.id,
      ),
    );
    run([cli, "index"]);
    run([cli, "index", "--check"]);
    const server = Bun.spawn([cli, "serve", "--port", "0"], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new Response(server.stderr).text();
    const timer = setTimeout(() => server.kill(), 15_000);
    try {
      let output = "";
      let url: string | undefined;
      const reader = server.stdout.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
        url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
        if (url) break;
      }
      if (!url)
        throw new Error(`standalone server failed to start: ${await stderr}`);
      const page = await fetch(url, { signal: AbortSignal.timeout(5000) });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert(html.includes("<style>") && html.includes("/assets/app.js"));
      const asset = await fetch(new URL("assets/app.js", url), {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(asset.status, 200);
      assert((await asset.text()).length > 10_000, "browser code is embedded");
    } finally {
      clearTimeout(timer);
      server.kill();
      await server.exited;
      await stderr;
    }
    const client = new Client({ name: "standalone-smoke", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: mcp,
          cwd: project,
          env,
          stderr: "pipe",
        }),
      );
      const tools = await client.listTools();
      options.onTools?.(tools.tools.map((tool) => tool.name).sort());
      assert(tools.tools.some((tool) => tool.name === "ready"));
      const result = await client.callTool({ name: "ready", arguments: {} });
      assert(!result.isError);
      assert(JSON.stringify(result).includes("BIN-1"));
    } finally {
      await client.close();
    }
    const watch = Bun.spawnSync([cli, "serve", "--watch"], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    assert.equal(watch.exitCode, 1);
    assert(
      watch.stderr
        .toString()
        .includes("--watch requires a source installation"),
    );
    await verifyUpgradeCompatibility({
      history: shippedHistory(),
      version: DOCKET_VERSION,
      upgrade: async (cwd, dryRun) => {
        const report = JSON.parse(
          run(
            [cli, "upgrade", ...(dryRun ? ["--dry-run"] : []), "--json"],
            cwd,
            [0, 1],
          ),
        );
        assert(Array.isArray(report.conflicts));
        return report;
      },
    });
    return {
      version: DOCKET_VERSION,
      platform: process.platform,
      arch: process.arch,
      runtimePath: options.node
        ? "Git, Node and npm launchers only"
        : "Git and standalone executables only",
      checks: [
        "CLI/MCP versions",
        "dual-agent initialization",
        "task create/ready/index",
        "embedded browser assets",
        "MCP ready tool",
        "source-only watch diagnostic",
        "historical/customized/stale upgrades",
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { bin: { type: "string" }, output: { type: "string" } },
  });
  assert(values.bin, "--bin DIR is required");
  const receipt = await smokeStandalone(resolve(values.bin));
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (values.output) await Bun.write(values.output, json);
  console.log(json);
}
