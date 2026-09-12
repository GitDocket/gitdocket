import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryFileStore, parseConfig } from "@gitdocket/core";
import { TelemetryStore } from "@gitdocket/core/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDocketServer } from "./server";

test("MCP observations preserve responses, catch validation, isolate concurrent workflows and exclude content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-mcp-telemetry-"));
  const old = process.env.DOCKET_TELEMETRY_DIR;
  process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
  const root = join(dir, "project");
  const observations = new TelemetryStore(root);
  const store = new InMemoryFileStore(
    new Map([
      [
        "work/tasks/DKT-1-secret.md",
        "---\ntype: Task\nid: DKT-1\ntitle: PRIVATE_TITLE\nstatus: todo\n---\nPRIVATE_BODY",
      ],
    ]),
  );
  const server = createDocketServer(store, parseConfig(), root);
  const client = new Client({ name: "private-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const disabled = await client.callTool({ name: "ready", arguments: {} });
    expect(observations.events()).toEqual([]);
    observations.enable();
    expect(await client.callTool({ name: "ready", arguments: {} })).toEqual(
      disabled,
    );
    await Promise.all([
      client.callTool({
        name: "search",
        arguments: { query: "PRIVATE_BODY" },
        _meta: { "docket/workflow": "PRIVATE_A" },
      }),
      client.callTool({
        name: "task_get",
        arguments: { id: "DKT-1" },
        _meta: { "docket/workflow": "PRIVATE_B" },
      }),
    ]);
    expect(
      (await client.callTool({ name: "ready", arguments: { limit: -1 } }))
        .isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "task_get",
          arguments: { id: "PRIVATE_MISSING" },
        })
      ).isError,
    ).toBe(true);
    await client.callTool({
      name: "set_status",
      arguments: { id: "DKT-1", to: "in-progress" },
    });
    const events = observations.events().filter((e) => e.kind === "operation");
    expect(events).toHaveLength(6);
    expect(events.find((e) => e.error === "validation")).toBeDefined();
    expect(events.find((e) => e.error === "not_found")).toBeDefined();
    const search = events.find((e) => e.operation === "search");
    expect(search?.before.indexState).toBe("metadata");
    expect(search?.after.indexState).toBe("search");
    expect(
      new Set(events.filter((e) => e.workflow).map((e) => e.workflow)).size,
    ).toBe(2);
    expect(
      events.every((e) => e.host === "unknown" && e.actor === "unknown"),
    ).toBe(true);
    expect(JSON.stringify(observations.events())).not.toMatch(
      /PRIVATE|private-client|DKT-1|secret\.md/,
    );
    observations.disable();
    await client.callTool({ name: "ready", arguments: {} });
    expect(
      observations.events().filter((e) => e.kind === "operation"),
    ).toHaveLength(6);
    await rm(join(dir, "usage"), { recursive: true, force: true });
    await writeFile(join(dir, "usage"), "unavailable");
    expect(
      (await client.callTool({ name: "ready", arguments: {} })).isError,
    ).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
    if (old === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
