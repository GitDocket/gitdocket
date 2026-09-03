// Serve wiring for production bundle refresh and the separate
// source-rebuild watch mode.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@docket/core";
import type { Assets } from "./app";
import { buildAssets, startServe } from "./serve";

let root: string;
let server: Awaited<ReturnType<typeof startServe>> | undefined;
let assets: Assets;

// Production performs one client build per Serve process. Bun 1.3.14 can
// corrupt later Bun.build calls inside one test process, so the integration
// cases share one real build and continue exercising every server behavior.
beforeAll(async () => {
  assets = await buildAssets();
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

const start = async (watch?: boolean) => {
  root = await mkdtemp(join(tmpdir(), "docket-serve-"));
  await mkdir(join(root, "docs", "work", "tasks"), { recursive: true });
  await writeFile(join(root, "docs", "index.md"), "# Fixture\n");
  await writeFile(
    join(root, "docs", "work", "tasks", "DKT-1-live.md"),
    "---\ntype: Task\ntitle: Live task\nid: DKT-1\nstatus: todo\n---\n\n# Context\n",
  );
  server = await startServe(
    root,
    parseConfig("bundle: docs/"),
    {
      port: 0,
      watch,
    },
    assets,
  );
  return server;
};

type EventReader = ReadableStreamDefaultReader<Uint8Array>;

const eventReader = async (server: Awaited<ReturnType<typeof startServe>>) => {
  const response = await fetch(new URL("/api/events", server.url));
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body stream");
  return reader;
};

const readEvent = async (reader: EventReader): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out waiting for event")),
          3000,
        );
      }),
    ]);
    if (!result.value) throw new Error("event stream ended");
    return new TextDecoder().decode(result.value);
  } finally {
    clearTimeout(timer);
  }
};

describe("serve", () => {
  test("binds to IPv4 loopback only", async () => {
    const server = await start();
    expect(server.url.hostname).toBe("127.0.0.1");
  });

  test("default serve has live data but no dev-reload endpoint", async () => {
    const server = await start();
    const js = await (
      await fetch(new URL("/assets/app.js", server.url))
    ).text();
    expect(js).toContain("/api/events");
    expect(js).not.toContain("/dev/reload");
    // /dev/reload falls through to the SPA catch-all, not an event stream
    const res = await fetch(new URL("/dev/reload", server.url));
    expect(res.headers.get("content-type")).not.toContain("event-stream");
    expect(await res.text()).toContain('<div id="root">');
  });

  test("external bundle mutation invalidates API state and notifies every tab", async () => {
    const server = await start();
    const before = (await (
      await fetch(new URL("/api/tasks", server.url))
    ).json()) as { items: { id: string; status: string }[] };
    expect(before.items.find((item) => item.id === "DKT-1")?.status).toBe(
      "todo",
    );

    const first = await eventReader(server);
    const second = await eventReader(server);
    expect(await readEvent(first)).toContain("id: 0");
    expect(await readEvent(second)).toContain("id: 0");

    // Two files in one filesystem burst still produce one coalesced revision.
    await Promise.all([
      writeFile(
        join(root, "docs", "work", "tasks", "DKT-1-live.md"),
        "---\ntype: Task\ntitle: Live task\nid: DKT-1\nstatus: in-progress\n---\n\n# Context\n",
      ),
      writeFile(join(root, "docs", "index.md"), "# Fixture updated\n"),
    ]);

    const changes = await Promise.all([readEvent(first), readEvent(second)]);
    expect(changes).toEqual([
      expect.stringContaining("id: 1"),
      expect.stringContaining("id: 1"),
    ]);
    const after = (await (
      await fetch(new URL("/api/tasks", server.url))
    ).json()) as { items: { id: string; status: string }[] };
    expect(after.items.find((item) => item.id === "DKT-1")?.status).toBe(
      "in-progress",
    );
    await first.cancel();
    await second.cancel();
  });

  test("a reconnect receives the current revision after a missed change", async () => {
    const server = await start();
    const first = await eventReader(server);
    expect(await readEvent(first)).toContain("id: 0");
    await first.cancel();

    await writeFile(join(root, "docs", "index.md"), "# Changed offline\n");
    const response = await fetch(new URL("/api/events", server.url), {
      headers: { "Last-Event-ID": "0" },
    });
    const reconnected = response.body?.getReader();
    if (!reconnected) throw new Error("no body stream");
    let event = await readEvent(reconnected);
    if (event.includes("id: 0")) event = await readEvent(reconnected);
    expect(event).toContain("id: 1");
    await reconnected.cancel();
  });

  test("watch mode injects the reload client and serves SSE", async () => {
    const server = await start(true);
    const js = await (
      await fetch(new URL("/assets/app.js", server.url))
    ).text();
    expect(js).toContain('new EventSource("/dev/reload")');

    const res = await fetch(new URL("/dev/reload", server.url));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body stream");
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain(": watching");
    await reader.cancel();
  });
});
