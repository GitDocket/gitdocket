// End-to-end over a linked in-memory transport pair: a real MCP client
// calling the real server, only the filesystem faked.

import { afterEach, describe, expect, test } from "bun:test";
import {
  InMemoryFileStore,
  parseConfig,
  READY_QUEUE_DESCRIPTION,
} from "@gitdocket/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDocketServer } from "./server";

const config = parseConfig();

const task = (id: string, status: string, deps = "") =>
  `---\ntype: Task\ntitle: t${id}\nid: ${id}\nstatus: ${status}\n${
    deps ? `depends_on: [${deps}]\n` : ""
  }timestamp: 2026-07-21T00:00:00Z\n---\n\n# Context\n\nidempotency keys\n`;

const seed = () =>
  new InMemoryFileStore(
    new Map([
      ["work/tasks/DKT-1-a.md", task("DKT-1", "done")],
      ["work/tasks/DKT-2-b.md", task("DKT-2", "todo", "DKT-1")],
      ["work/tasks/DKT-3-c.md", task("DKT-3", "todo", "DKT-2")],
    ]),
  );

const connections: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
});

async function connect(store = seed()) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createDocketServer(store, config);
  connections.push({
    close: async () => {
      await client.close();
      await server.close();
    },
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, store, server };
}

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])
    .map((c) => c.text)
    .join("");
  const isError = result.isError === true;
  // Error results carry the message as plain text, not JSON.
  return { isError, data: isError ? text : JSON.parse(text) };
};

describe("tool surface", () => {
  test("reads and writes are cleanly separated by readOnlyHint", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const hint = Object.fromEntries(
      tools.map((t) => [t.name, t.annotations?.readOnlyHint]),
    );
    expect(hint).toEqual({
      overview: true,
      ready: true,
      task_list: true,
      task_get: true,
      lint: true,
      search: true,
      source_page: true,
      task_create: false,
      set_status: false,
      append_log: false,
    });
    for (const tool of tools)
      expect(tool.annotations?.openWorldHint).toBe(false);
    expect(tools.find((tool) => tool.name === "ready")?.description).toBe(
      READY_QUEUE_DESCRIPTION,
    );
  });
});

describe("read tools", () => {
  test("bounded retrieval preserves defaults, complete source and changed-cursor errors", async () => {
    const { client, store } = await connect();
    const all = (await call(client, "task_list")).data;
    expect(all).toHaveLength(3);
    expect(
      (await call(client, "task_list", { limit: 1, offset: 1 })).data,
    ).toEqual(all.slice(1, 2));
    const source = "2026-09-11 DKT-123 complete history 😀\n".repeat(50);
    await store.write("log.md", source);
    let cursor: unknown;
    let assembled = "";
    do {
      const result = await call(client, "source_page", {
        path: "log.md",
        maxChars: 100,
        ...(cursor ? { cursor } : {}),
      });
      expect(result.isError).toBe(false);
      assembled += result.data.text;
      cursor = result.data.nextCursor;
    } while (cursor);
    expect(assembled).toBe(source);
    const first = (
      await call(client, "source_page", { path: "log.md", maxChars: 100 })
    ).data;
    await store.write("log.md", `${source}new`);
    expect(
      (
        await call(client, "source_page", {
          path: "log.md",
          cursor: first.nextCursor,
        })
      ).isError,
    ).toBe(true);
    expect(
      (await call(client, "source_page", { path: "../docket.yaml" })).isError,
    ).toBe(true);
  });
  test("overview returns the bounded shared selection without writes", async () => {
    const { client, store } = await connect();
    const before = new Map(store.files);
    const { data } = await call(client, "overview");
    expect(data.upNext.id).toBe("DKT-2");
    expect(store.files).toEqual(before);

    const { tools } = await client.listTools();
    const overview = tools.find((tool) => tool.name === "overview");
    expect(overview?.description).toContain("Read-only orientation");
  });

  test("ready derives from depends_on", async () => {
    const { client } = await connect();
    const { data } = await call(client, "ready");
    expect(data.map((w: { id: string }) => w.id)).toEqual(["DKT-2"]);
  });

  test("task_list filters by status", async () => {
    const { client } = await connect();
    const { data } = await call(client, "task_list", { status: "todo" });
    expect(data).toHaveLength(2);
  });

  test("task_get returns frontmatter and source; unknown id is an error", async () => {
    const { client } = await connect();
    const { data } = await call(client, "task_get", { id: "DKT-1" });
    expect(data.path).toBe("work/tasks/DKT-1-a.md");
    expect(data.frontmatter.status).toBe("done");
    expect(data.source).toContain("# Context");

    const missing = await call(client, "task_get", { id: "DKT-99" });
    expect(missing.isError).toBe(true);
  });

  test("lint reports diagnostics on a broken file, none on a clean bundle", async () => {
    const { client } = await connect();
    expect((await call(client, "lint")).data).toEqual([]);

    const store = seed();
    store.files.set("work/tasks/bad.md", "no frontmatter at all\n");
    const broken = await connect(store);
    const { data } = await call(broken.client, "lint");
    expect(data).toHaveLength(1);
    expect(data[0].severity).toBe("error");
  });

  test("search finds body text and tags hits with ids", async () => {
    const { client } = await connect();
    const { data } = await call(client, "search", { query: "Idempotency" });
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].id).toBe("DKT-1");
  });
});

describe("write tools", () => {
  test("task_create writes a conformant file with the next id", async () => {
    const { client, store } = await connect();
    const { data } = await call(client, "task_create", {
      title: "New thing",
      depends_on: ["DKT-2"],
      priority: "p1",
    });
    expect(data.id).toBe("DKT-4");
    expect(store.files.get(data.path)).toContain("status: todo");

    const invalid = await call(client, "task_create", {
      title: "bad",
      priority: "p9",
    });
    expect(invalid.isError).toBe(true);
  });

  test("set_status enforces the state machine and appends the note", async () => {
    const { client, store } = await connect();
    const ok = await call(client, "set_status", {
      id: "DKT-2",
      to: "in-progress",
      note: "picked up",
    });
    expect(ok.data).toMatchObject({ from: "todo", to: "in-progress" });
    expect(store.files.get("work/tasks/DKT-2-b.md")).toContain("— picked up");

    const bad = await call(client, "set_status", { id: "DKT-1", to: "todo" });
    expect(bad.isError).toBe(true); // done is terminal

    const missingDisposition = await call(client, "set_status", {
      id: "DKT-3",
      to: "closed",
    });
    expect(missingDisposition.isError).toBe(true);
    expect(missingDisposition.data).toContain("disposition note");

    const closed = await call(client, "set_status", {
      id: "DKT-3",
      to: "closed",
      note: "No longer aligned with the product direction.",
    });
    expect(closed.data).toMatchObject({ from: "todo", to: "closed" });
    expect(store.files.get("work/tasks/DKT-3-c.md")).toContain(
      "No longer aligned with the product direction.",
    );
    expect(
      (await call(client, "set_status", { id: "DKT-3", to: "todo" })).isError,
    ).toBe(true);
  });

  test("append_log inserts a dated entry", async () => {
    const { client, store } = await connect();
    await call(client, "append_log", { id: "DKT-3", entry: "hello" });
    expect(store.files.get("work/tasks/DKT-3-c.md")).toContain("# Log\n\n**");
  });
});
