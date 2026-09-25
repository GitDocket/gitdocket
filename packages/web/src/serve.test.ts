// Serve wiring for production bundle refresh and the separate
// source-rebuild watch mode.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@gitdocket/core";
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
  test("split diagram assets are served locally and missing modules return 404", async () => {
    const server = await start();
    const chunks = Object.entries(assets.chunks ?? {});
    expect(chunks.length).toBeGreaterThan(1);
    expect(assets.js).not.toContain("mermaid version");
    for (const [name, source] of chunks) {
      const response = await fetch(new URL(`/assets/${name}`, server.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/javascript");
      expect(await response.text()).toBe(source);
    }
    for (const name of ["missing.js", "constructor", "__proto__"]) {
      const response = await fetch(new URL(`/assets/${name}`, server.url));
      expect(response.status).toBe(404);
    }
  });
  test("reconciliation recovers a missing watched bundle and exposes stale data during failure", async () => {
    const server = await start();
    await fetch(new URL("/api/tasks", server.url));
    const reader = await eventReader(server);
    await readEvent(reader);
    await rename(join(root, "docs"), join(root, "temporarily-missing"));
    await readEvent(reader);
    const stale = await fetch(new URL("/api/tasks", server.url));
    expect(stale.headers.get("X-Docket-Freshness")).toBe("stale");
    expect(stale.status).toBe(200);
    await stale.text();
    await rename(join(root, "temporarily-missing"), join(root, "docs"));
    await writeFile(join(root, "docs", "index.md"), "# Recovered\n");
    await readEvent(reader);
    const recovered = await fetch(new URL("/api/nav", server.url));
    expect(recovered.headers.get("X-Docket-Freshness")).toBe("current");
    expect(((await recovered.json()) as { html: string }).html).toContain(
      "Recovered",
    );
    await reader.cancel();
  });

  test("configuration changes replace the live bundle watcher and source generation", async () => {
    const server = await start();
    await fetch(new URL("/api/tasks", server.url));
    await mkdir(join(root, "next"));
    await writeFile(
      join(root, "next", "task.md"),
      "---\ntype: Task\nid: DKT-9\ntitle: New root\nstatus: todo\n---\n",
    );
    const reader = await eventReader(server);
    await readEvent(reader);
    await writeFile(join(root, "docket.yaml"), "bundle: next/\n");
    await readEvent(reader);
    const tasks = (await (
      await fetch(new URL("/api/tasks", server.url))
    ).json()) as { items: { id: string }[] };
    expect(tasks.items.map((item) => item.id)).toEqual(["DKT-9"]);
    await writeFile(
      join(root, "next", "task.md"),
      "---\ntype: Task\nid: DKT-9\ntitle: Updated new root\nstatus: todo\n---\n",
    );
    await readEvent(reader);
    const detail = (await (
      await fetch(new URL("/api/concept/task.md", server.url))
    ).json()) as { fm: { title: string } };
    expect(detail.fm.title).toBe("Updated new root");
    await reader.cancel();
  });
  test("restart uses a new event identity and shutdown closes active streams", async () => {
    const first = await start();
    const firstReader = await eventReader(first);
    const before = await readEvent(firstReader);
    first.stop(true);
    const ended = await Promise.race([
      firstReader
        .read()
        .then((result) => result.done)
        .catch(() => true),
      Bun.sleep(1000).then(() => false),
    ]);
    expect(ended).toBeTrue();
    await firstReader.cancel().catch(() => {});
    server = await startServe(
      root,
      parseConfig("bundle: docs/"),
      { port: 0 },
      assets,
    );
    const secondReader = await eventReader(server);
    const after = await readEvent(secondReader);
    expect(after.split("\n")[0]?.split(":")[1]).not.toBe(
      before.split("\n")[0]?.split(":")[1],
    );
    await secondReader.cancel();
  });
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
    // Split ESM cannot execute in vm.runInNewContext. Load the exact module
    // graph in a disposable process with Node globals removed instead.
    const browserRoot = join(root, "browser-assets");
    await mkdir(browserRoot);
    await Promise.all(
      Object.entries({ "app.js": js, ...assets.chunks }).map(([name, source]) =>
        writeFile(join(browserRoot, name), source),
      ),
    );
    await writeFile(
      join(browserRoot, "check.mjs"),
      `globalThis.document = {
        createElement: () => ({}),
        getElementById: (id) => {
          if (id !== "root") throw new Error("unexpected mount");
          console.log("reached browser mount");
          return null;
        }
      };
      delete globalThis.process;
      delete globalThis.Buffer;
      await import("./app.js");`,
    );
    const child = Bun.spawn(
      [process.execPath, join(browserRoot, "check.mjs")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    expect(output).toContain("reached browser mount");
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
    const initial = await readEvent(first);
    expect(await readEvent(second)).toBe(initial);

    // Two files in one filesystem burst still produce one coalesced revision.
    await Promise.all([
      writeFile(
        join(root, "docs", "work", "tasks", "DKT-1-live.md"),
        "---\ntype: Task\ntitle: Live task\nid: DKT-1\nstatus: in-progress\n---\n\n# Context\n",
      ),
      writeFile(join(root, "docs", "index.md"), "# Fixture updated\n"),
    ]);

    const changes = await Promise.all([readEvent(first), readEvent(second)]);
    expect(changes[0]).toBe(changes[1]);
    expect(changes[0]).not.toBe(initial);
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
    const initial = await readEvent(first);
    await first.cancel();

    await writeFile(join(root, "docs", "index.md"), "# Changed offline\n");
    const response = await fetch(new URL("/api/events", server.url), {
      headers: { "Last-Event-ID": initial.split("\n")[0]?.slice(4) ?? "" },
    });
    const reconnected = response.body?.getReader();
    if (!reconnected) throw new Error("no body stream");
    let event = await readEvent(reconnected);
    if (event === initial) event = await readEvent(reconnected);
    expect(event).not.toBe(initial);
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

test("periodic reconciliation publishes saved foreign progress and later integration over SSE", async () => {
  const running = await start();
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
  };
  git(root, "init", "-q");
  git(root, "add", "docs");
  git(root, "commit", "-qm", "baseline");
  const worker = `${root}-worker`;
  git(root, "worktree", "add", "-qb", "feature", worker);
  const events = await eventReader(running);
  const firstEvent = await readEvent(events);
  const progress = async () =>
    (await (
      await fetch(new URL("/api/task-progress", running.url))
    ).json()) as {
      tasks: { id: string; observations: { task: { status: string } }[] }[];
    };
  const waitForProgress = async (status: string | null) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const p = await progress();
      if (
        status === null
          ? p.tasks.length === 0
          : p.tasks[0]?.observations[0]?.task.status === status
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Progress did not converge to ${status}`);
  };
  try {
    await progress();
    await writeFile(
      join(worker, "docs/work/tasks/DKT-1-live.md"),
      "---\ntype: Task\nid: DKT-1\ntitle: Live task\nstatus: in-progress\n---\n",
    );
    await waitForProgress("in-progress");
    expect(await readEvent(events)).not.toBe(firstEvent);
    const local = await (
      await fetch(new URL("/api/tasks", running.url))
    ).json();
    expect(local.items[0].status).toBe("todo");
    await writeFile(
      join(worker, "docs/work/tasks/DKT-1-live.md"),
      "---\ntype: Task\nid: DKT-1\ntitle: Live task\nstatus: done\n---\n",
    );
    await waitForProgress("done");
    git(worker, "add", "docs");
    git(worker, "commit", "-qm", "done");
    git(root, "merge", "--ff-only", "feature");
    await waitForProgress(null);
    expect(
      (await (await fetch(new URL("/api/tasks", running.url))).json()).items[0]
        .status,
    ).toBe("done");
  } finally {
    await events.cancel();
    await rm(worker, { recursive: true, force: true });
  }
}, 20000);
