// Synthetic collection-cost experiment, not pilot activity. Runs in a temp store.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStore, parseConfig } from "@gitdocket/core";
import { TelemetryStore } from "@gitdocket/core/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../../web/src/app";
import { createRepoContext } from "../../web/src/state";
import { createDocketServer } from "../src/server";

const dir = await mkdtemp(join(tmpdir(), "docket-overhead-"));
const root = join(dir, "project");
const old = process.env.DOCKET_TELEMETRY_DIR;
process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
await mkdir(join(root, "docs"), { recursive: true });
await writeFile(join(root, "docket.yaml"), "bundle: docs/\n");
for (let i = 1; i <= 50; i++)
  await writeFile(
    join(root, `docs/task-${i}.md`),
    `---\ntype: Task\nid: DKT-${i}\ntitle: Fixture ${i}\nstatus: todo\n---\nfixture body\n`,
  );
const config = parseConfig("bundle: docs/");
const telemetry = new TelemetryStore(root);
telemetry.enable();
const server = createDocketServer(
  new LocalFileStore(join(root, "docs")),
  config,
  root,
);
const client = new Client({ name: "overhead", version: "1.0.0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(ct), server.connect(st)]);
const context = createRepoContext(root, config);
const app = createApp(context);
const cli = join(import.meta.dir, "../../cli/src/index.ts");
const runCli = async () => {
  const p = Bun.spawn([process.execPath, cli, "ready", "--json"], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (exit) throw new Error("CLI failed");
};
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    meanMs: values.reduce((a, b) => a + b, 0) / values.length,
  };
};
try {
  const output: Record<string, unknown> = {
    at: new Date().toISOString(),
    runtime: Bun.version,
    platform: process.platform,
    arch: process.arch,
    fixtureConcepts: 50,
    scope:
      "Synthetic alternating enabled/disabled complete round trips; warm MCP/Serve and fresh CLI processes. Includes collection overhead. Not real usage.",
  };
  for (const [surface, run] of Object.entries({
    mcp: async () => {
      const r = await client.callTool({ name: "ready", arguments: {} });
      if (r.isError) throw new Error("MCP failed");
    },
    serve: async () => {
      const r = await app.request("/api/tasks");
      if (!r.ok) throw new Error("Serve failed");
      await r.text();
    },
    cli: runCli,
  })) {
    await run();
    const enabled: number[] = [];
    const disabled: number[] = [];
    for (let i = 0; i < 30; i++)
      for (const on of i % 2 ? [true, false] : [false, true]) {
        if (on) telemetry.enable();
        else telemetry.disable();
        const start = performance.now();
        await run();
        (on ? enabled : disabled).push(performance.now() - start);
      }
    output[surface] = {
      disabled: summary(disabled),
      enabled: summary(enabled),
      pairedMeanDeltaMs: summary(enabled).meanMs - summary(disabled).meanMs,
    };
  }
  console.log(JSON.stringify(output, null, 2));
} finally {
  context.close();
  await client.close();
  await server.close();
  if (old === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
  else process.env.DOCKET_TELEMETRY_DIR = old;
  await rm(dir, { recursive: true, force: true });
}
