import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryFileStore, parseConfig } from "@gitdocket/core";
import { TELEMETRY_COVERAGE, TelemetryStore } from "@gitdocket/core/telemetry";
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
    expect(search?.resultCount).toBeGreaterThan(0);
    expect(search?.responseBytes).toBeGreaterThan(0);
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

test("MCP launch defaults attribute agent/host; per-request meta overrides without mislabeling mixed callers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-mcp-attr-"));
  const previousDir = process.env.DOCKET_TELEMETRY_DIR;
  const previousActor = process.env.DOCKET_TELEMETRY_ACTOR;
  const previousHost = process.env.DOCKET_TELEMETRY_HOST;
  process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
  process.env.DOCKET_TELEMETRY_ACTOR = "agent";
  process.env.DOCKET_TELEMETRY_HOST = "cursor";
  const root = join(dir, "project");
  const observations = new TelemetryStore(root);
  const store = new InMemoryFileStore(new Map());
  const server = createDocketServer(store, parseConfig(), root);
  const client = new Client({ name: "attr-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    observations.enable();
    await client.callTool({ name: "ready", arguments: {} });
    await client.callTool({
      name: "ready",
      arguments: {},
      _meta: { "docket/actor": "human", "docket/host": "other" },
    });
    await client.callTool({
      name: "ready",
      arguments: {},
      _meta: { "docket/actor": "nope", "docket/host": "codex" },
    });
    const events = observations
      .events()
      .filter((event) => event.kind === "operation");
    expect(events.map((event) => [event.actor, event.host])).toEqual([
      ["agent", "cursor"],
      ["human", "other"],
      ["unknown", "codex"],
    ]);
  } finally {
    await client.close();
    await server.close();
    if (previousDir === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = previousDir;
    if (previousActor === undefined) delete process.env.DOCKET_TELEMETRY_ACTOR;
    else process.env.DOCKET_TELEMETRY_ACTOR = previousActor;
    if (previousHost === undefined) delete process.env.DOCKET_TELEMETRY_HOST;
    else process.env.DOCKET_TELEMETRY_HOST = previousHost;
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP ignores checkout workflow tokens so a long-lived server does not join unrelated work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-mcp-workflow-"));
  const previousDir = process.env.DOCKET_TELEMETRY_DIR;
  const previousWorkflow = process.env.DOCKET_TELEMETRY_WORKFLOW;
  process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
  process.env.DOCKET_TELEMETRY_WORKFLOW = "launch-wide";
  const root = join(dir, "project");
  await mkdir(join(root, ".docket"), { recursive: true });
  await writeFile(join(root, ".docket", "workflow-token"), "shared-checkout\n");
  const observations = new TelemetryStore(root);
  const store = new InMemoryFileStore(new Map());
  const server = createDocketServer(store, parseConfig(), root);
  const client = new Client({ name: "wf-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    observations.enable();
    await client.callTool({ name: "ready", arguments: {} });
    await client.callTool({
      name: "ready",
      arguments: {},
      _meta: { "docket/workflow": "explicit-a" },
    });
    await client.callTool({
      name: "ready",
      arguments: {},
      _meta: { "docket/workflow": "explicit-b" },
    });
    const events = observations
      .events()
      .filter((event) => event.kind === "operation");
    expect(events[0]?.workflow).toBeNull();
    expect(events[1]?.workflow).toBeTruthy();
    expect(events[2]?.workflow).toBeTruthy();
    expect(events[1]?.workflow).not.toBe(events[2]?.workflow);
  } finally {
    await client.close();
    await server.close();
    if (previousDir === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = previousDir;
    if (previousWorkflow === undefined)
      delete process.env.DOCKET_TELEMETRY_WORKFLOW;
    else process.env.DOCKET_TELEMETRY_WORKFLOW = previousWorkflow;
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP workflow_extensions discovery is observed without package names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-mcp-ext-"));
  const previousDir = process.env.DOCKET_TELEMETRY_DIR;
  process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
  const root = join(dir, "project");
  const observations = new TelemetryStore(root);
  const store = new InMemoryFileStore(new Map());
  const server = createDocketServer(store, parseConfig(), root);
  const client = new Client({ name: "ext-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    observations.enable();
    const listed = await client.callTool({
      name: "workflow_extensions",
      arguments: {},
    });
    expect(listed.isError).not.toBe(true);
    const again = await client.callTool({
      name: "workflow_extensions",
      arguments: {},
    });
    expect(again).toEqual(listed);
    const events = observations
      .events()
      .filter((event) => event.kind === "operation");
    expect(events.map((event) => event.operation)).toEqual([
      "workflow_extensions",
      "workflow_extensions",
    ]);
    expect(JSON.stringify(events)).not.toMatch(/tiny|ext-client/);
  } finally {
    await client.close();
    await server.close();
    if (previousDir === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP tools are inventoried so new tools cannot skip coverage review", async () => {
  const store = new InMemoryFileStore(new Map());
  const server = createDocketServer(store, parseConfig());
  const client = new Client({ name: "cov-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      TELEMETRY_COVERAGE.filter((entry) => entry.surface === "mcp")
        .map((entry) => entry.id)
        .sort(),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP records empty search counts and source-page truncation without content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-mcp-outcomes-"));
  const previousDir = process.env.DOCKET_TELEMETRY_DIR;
  process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
  const root = join(dir, "project");
  const observations = new TelemetryStore(root);
  const store = new InMemoryFileStore(
    new Map([
      [
        "work/tasks/DKT-1-secret.md",
        `${"---\ntype: Task\nid: DKT-1\ntitle: Title\nstatus: todo\n---\n"}${"PRIVATE_LINE\n".repeat(80)}`,
      ],
    ]),
  );
  const server = createDocketServer(store, parseConfig(), root);
  const client = new Client({ name: "out-client", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    observations.enable();
    await client.callTool({
      name: "search",
      arguments: { query: "zzz-no-such-term" },
    });
    await client.callTool({
      name: "source_page",
      arguments: { path: "work/tasks/DKT-1-secret.md", maxChars: 40 },
    });
    const events = observations
      .events()
      .filter((event) => event.kind === "operation");
    const search = events.find((event) => event.operation === "search");
    const page = events.find((event) => event.operation === "source_page");
    expect(search?.resultCount).toBe(0);
    expect(search?.truncated).toBe("none");
    expect(page?.truncated).toBe("response");
    expect(page?.responseBytes).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|secret\.md/);
  } finally {
    await client.close();
    await server.close();
    if (previousDir === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});
