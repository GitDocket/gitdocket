import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalFileStore, parseConfig } from "@gitdocket/core";
import { TelemetryStore } from "@gitdocket/core/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createDocketServer } from "./server";
import { type RootProvider, TargetRouter } from "./target";

const config = "project: JOB\nbundle: docket\n";
const task =
  "---\ntype: Task\nid: JOB-1\ntitle: Shared ID\nstatus: todo\n---\nBody.\n";
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "docket-target-")));
  const main = join(base, "main");
  const worker = join(base, "worker");
  for (const root of [main, worker]) {
    await mkdir(join(root, "docket/work/tasks"), { recursive: true });
    await mkdir(join(root, ".docket"));
    await writeFile(join(root, "docket.yaml"), config);
    await writeFile(join(root, "docket/work/tasks/JOB-1-shared.md"), task);
    await writeFile(
      join(root, ".docket/active-task"),
      root === main ? "JOB-91\n" : "JOB-92\n",
    );
    await writeFile(join(root, "dirty.txt"), "Unrelated dirty source");
  }
  return { base, main, worker };
}
async function connect(
  main: string,
  roots?: { uri: string }[],
  pin?: string,
  notifications = true,
) {
  const client = new Client(
    { name: "routing fixture", version: "1" },
    {
      capabilities:
        roots === undefined ? {} : { roots: { listChanged: notifications } },
    },
  );
  let current = roots;
  let requests = 0;
  if (roots !== undefined)
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      requests++;
      return { roots: current ?? [] };
    });
  const server = createDocketServer(
    new LocalFileStore(join(main, "docket")),
    parseConfig(config),
    main,
    undefined,
    { pin },
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (
    name: string,
    args: Record<string, unknown>,
    target?: unknown,
  ) => {
    const result = await client.callTool({
      name,
      arguments: args,
      ...(target === undefined ? {} : { _meta: { "docket/target": target } }),
    });
    const text = (result.content as { text: string }[])
      .map((item) => item.text)
      .join("");
    return {
      isError: result.isError === true,
      data: JSON.parse(text),
      bytes: Buffer.byteLength(text),
    };
  };
  return {
    client,
    server,
    call,
    requests: () => requests,
    switch: async (next: { uri: string }[]) => {
      current = next;
      if (notifications)
        await client.notification({
          method: "notifications/roots/list_changed",
        });
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
const roots = (path: string) => [{ uri: pathToFileURL(path).href }];
const none: RootProvider = {
  supported: false,
  notifications: false,
  list: async () => ({ roots: [] }),
};

test("a server launched on main follows a linked-worktree client, caches roots and returns versions/target in two continuation calls", async () => {
  const f = await fixture();
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", ...args], {
      cwd: f.main,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    if (code) throw new Error(err);
    return out;
  };
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "user.name", "Fixture");
    await writeFile(join(f.main, ".gitignore"), ".docket/\n");
    await git("add", ".");
    await git("commit", "-m", "Seed");
    await rm(f.worker, { recursive: true });
    await git("worktree", "add", "-b", "worker", f.worker);
    await mkdir(join(f.worker, ".docket"));
    await writeFile(join(f.worker, ".docket/active-task"), "JOB-92\n");
    connection = await connect(f.main, roots(f.worker));
    const made = await connection.call("task_create", {
      title: "Worktree-only",
      response: "compact",
    });
    expect(made.isError).toBe(false);
    expect(made.data.checkout.root).toBe(f.worker);
    expect(made.data.checkout.selectedBy).toBe("client-roots");
    expect(made.data.checkout.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(made.bytes).toBeLessThan(1500);
    const saved = await connection.call("document_edit", {
      path: made.data.path,
      expectedVersion: made.data.version,
      patch: { body: "Complete worktree draft." },
      response: "compact",
    });
    expect(saved.isError).toBe(false);
    expect(saved.data.checkout.identity).toBe(made.data.checkout.identity);
    expect(connection.requests()).toBe(1);
    expect(
      await readFile(join(f.worker, "docket", made.data.path), "utf8"),
    ).toContain("Complete worktree draft.");
    expect((await readdir(join(f.main, "docket/work/tasks"))).length).toBe(1);
    expect(await readFile(join(f.main, ".docket/active-task"), "utf8")).toBe(
      "JOB-91\n",
    );
    expect(await readFile(join(f.worker, ".docket/active-task"), "utf8")).toBe(
      "JOB-92\n",
    );
    const other = await connection.call(
      "task_create",
      { title: "Shared allocator", response: "compact" },
      { root: f.main },
    );
    expect(other.data.id).not.toBe(made.data.id);
    expect(await readFile(join(f.main, "dirty.txt"), "utf8")).toBe(
      "Unrelated dirty source",
    );
  } finally {
    await connection?.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("request targets disambiguate roots, pins reject contradictions, and unsupported clients keep explicit launch fallback", async () => {
  const f = await fixture();
  const connections: Awaited<ReturnType<typeof connect>>[] = [];
  try {
    const multiple = await connect(f.main, [
      ...roots(f.main),
      ...roots(f.worker),
    ]);
    connections.push(multiple);
    expect(
      (await multiple.call("set_status", { id: "JOB-1", to: "in-progress" }))
        .data,
    ).toMatchObject({
      error: { code: "ambiguous-target" },
      mutation: "unchanged",
    });
    const explicit = await multiple.call(
      "set_status",
      { id: "JOB-1", to: "in-progress", response: "compact" },
      { root: f.worker },
    );
    expect(explicit.isError).toBe(false);
    expect(explicit.data.checkout.selectedBy).toBe("request");
    expect(
      await readFile(join(f.main, "docket/work/tasks/JOB-1-shared.md"), "utf8"),
    ).toBe(task);
    const pinned = await connect(f.main, roots(f.worker), f.main);
    connections.push(pinned);
    expect(
      (await pinned.call("task_create", { title: "Refused" })).data,
    ).toMatchObject({
      error: { code: "target-mismatch" },
      mutation: "unchanged",
    });
    expect(
      (
        await pinned.call(
          "task_create",
          { title: "Refused" },
          { root: f.worker },
        )
      ).data,
    ).toMatchObject({
      error: { code: "target-mismatch" },
      mutation: "unchanged",
    });
    const deliberate = await pinned.call(
      "task_create",
      { title: "Pinned", response: "compact" },
      { root: f.main },
    );
    expect(deliberate.isError).toBe(false);
    expect(deliberate.data.checkout.root).toBe(f.main);
    const legacy = await connect(f.main);
    connections.push(legacy);
    const fallback = await legacy.call("append_log", {
      id: "JOB-1",
      entry: "Legacy",
      response: "compact",
    });
    expect(fallback.isError).toBe(false);
    expect(fallback.data.checkout).toMatchObject({
      selectedBy: "launch",
      rootsSupported: false,
      supported: true,
      intentConfirmed: false,
    });
  } finally {
    await Promise.all(connections.map((c) => c.close()));
    await rm(f.base, { recursive: true, force: true });
  }
});

test("roots changes during selection fail closed; clients without change notifications refresh each request", async () => {
  const f = await fixture();
  const c = await connect(f.main, roots(f.worker));
  const fresh = await connect(f.main, roots(f.worker), undefined, false);
  try {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    c.client.setRequestHandler(ListRootsRequestSchema, async () => {
      entered();
      await resumed;
      return { roots: roots(f.worker) };
    });
    const pending = c.call("append_log", {
      id: "JOB-1",
      entry: "No write during roots switch",
      response: "compact",
    });
    await started;
    await c.switch(roots(f.main));
    await Bun.sleep(5);
    release();
    expect((await pending).data).toMatchObject({
      error: { code: "target-changed" },
      mutation: "unchanged",
    });
    expect(
      await readFile(
        join(f.worker, "docket/work/tasks/JOB-1-shared.md"),
        "utf8",
      ),
    ).toBe(task);
    const initial = await fresh.call("append_log", {
      id: "JOB-1",
      entry: "Fresh worker",
      response: "compact",
    });
    expect(initial.data.checkout.root).toBe(f.worker);
    await fresh.switch(roots(f.main));
    const later = await fresh.call("append_log", {
      id: "JOB-1",
      entry: "Fresh main",
      response: "compact",
    });
    expect(later.data.checkout.root).toBe(f.main);
    expect(fresh.requests()).toBe(2);
  } finally {
    await c.close();
    await fresh.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("an explicit unconfigured child never falls back to its parent and a removed bound target cannot be redirected", async () => {
  const f = await fixture();
  const c = await connect(f.main);
  const router = new TargetRouter(
    new LocalFileStore(join(f.main, "docket")),
    parseConfig(config),
    f.main,
  );
  try {
    const child = join(f.main, "unconfigured");
    await mkdir(child);
    expect(
      (
        await c.call(
          "task_create",
          { title: "Must not reach parent" },
          { root: child },
        )
      ).data,
    ).toMatchObject({
      error: { code: "target-unavailable" },
      mutation: "unchanged",
    });
    const replaced = await router.bind(
      { "docket/target": { root: f.worker } },
      none,
      true,
    );
    await rename(join(f.worker, "docket"), join(f.worker, "old-docket"));
    await mkdir(join(f.worker, "docket"));
    await router.run(replaced, async () => {
      await expect(
        replaced.owner.mutate(({ store }) =>
          store.write("a.md", "Wrong replacement bundle"),
        ),
      ).rejects.toMatchObject({
        code: "target-changed",
        mutation: "unchanged",
      });
    });
    await rm(join(f.worker, "docket"), { recursive: true });
    await rename(join(f.worker, "old-docket"), join(f.worker, "docket"));
    const bound = await router.bind(
      { "docket/target": { root: f.worker } },
      none,
      true,
    );
    await router.run(bound, async () => {
      await rm(f.worker, { recursive: true });
      await expect(
        bound.owner.mutate(({ store }) => store.write("a.md", "Wrong target")),
      ).rejects.toMatchObject({
        code: "target-changed",
        mutation: "unchanged",
      });
    });
    expect(
      await readFile(join(f.main, "docket/work/tasks/JOB-1-shared.md"), "utf8"),
    ).toBe(task);
    expect((await readdir(join(f.main, "docket/work/tasks"))).length).toBe(1);
  } finally {
    router.close();
    await c.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("empty/inaccessible roots, stale identities, missing targets and escaping bundle configuration fail without changing source", async () => {
  const f = await fixture();
  const connections: Awaited<ReturnType<typeof connect>>[] = [];
  try {
    for (const inventory of [
      [],
      roots(join(f.base, "absent")),
      Array.from({ length: 17 }, () => ({ uri: pathToFileURL(f.worker).href })),
      [{ uri: "https://example.invalid/workspace" }],
    ]) {
      const c = await connect(f.main, inventory);
      connections.push(c);
      const result = await c.call("set_status", {
        id: "JOB-1",
        to: "in-progress",
      });
      expect(result.isError).toBe(true);
      expect(result.data.mutation).toBe("unchanged");
      expect(result.data.checkout.matched).toBe(false);
    }
    const c = await connect(f.main);
    connections.push(c);
    expect(
      (
        await c.call(
          "set_status",
          { id: "JOB-1", to: "in-progress" },
          { root: f.worker, identity: "0".repeat(64) },
        )
      ).data.error.code,
    ).toBe("target-mismatch");
    await writeFile(
      join(f.worker, "docket.yaml"),
      "project: JOB\nbundle: ../main/docket\n",
    );
    expect(
      (await c.call("task_create", { title: "Outside" }, { root: f.worker }))
        .data.error.code,
    ).toBe("target-unavailable");
    await rm(f.worker, { recursive: true });
    expect(
      (await c.call("task_create", { title: "Removed" }, { root: f.worker }))
        .data.error.code,
    ).toBe("target-unavailable");
    expect(
      await readFile(join(f.main, "docket/work/tasks/JOB-1-shared.md"), "utf8"),
    ).toBe(task);
  } finally {
    await Promise.all(connections.map((c) => c.close()));
    await rm(f.base, { recursive: true, force: true });
  }
});

test("workspace notifications and concurrent requests cannot redirect a leased target, including configuration changes after preparation", async () => {
  const f = await fixture();
  const c = await connect(f.main, roots(f.worker));
  const router = new TargetRouter(
    new LocalFileStore(join(f.main, "docket")),
    parseConfig(config),
    f.main,
  );
  try {
    const first = await c.call("append_log", {
      id: "JOB-1",
      entry: "Worker only",
      response: "compact",
    });
    expect(first.data.checkout.root).toBe(f.worker);
    await c.switch(roots(f.main));
    const second = await c.call("append_log", {
      id: "JOB-1",
      entry: "Main only",
      response: "compact",
    });
    expect(second.data.checkout.root).toBe(f.main);
    expect(c.requests()).toBe(2);
    const concurrent = await Promise.all(
      [f.main, f.worker].map((root) =>
        c.call(
          "append_log",
          {
            id: "JOB-1",
            entry: root === f.main ? "Concurrent main" : "Concurrent worker",
            response: "compact",
          },
          { root },
        ),
      ),
    );
    expect(concurrent.map((r) => r.data.checkout.root)).toEqual([
      f.main,
      f.worker,
    ]);
    expect(
      await readFile(join(f.main, "docket/work/tasks/JOB-1-shared.md"), "utf8"),
    ).not.toContain("Concurrent worker");
    const bound = await router.bind(
      { "docket/target": { root: f.worker } },
      none,
      true,
    );
    await router.run(bound, async () => {
      await bound.owner.mutate(async ({ store }) => {
        await store.read("work/tasks/JOB-1-shared.md");
        await writeFile(
          join(f.worker, "docket.yaml"),
          `${config}# changed after preparation\n`,
        );
        await expect(
          store.write("work/tasks/JOB-1-shared.md", "Wrong replacement"),
        ).rejects.toMatchObject({
          code: "target-changed",
          mutation: "unchanged",
        });
      });
    });
    expect(
      await readFile(
        join(f.worker, "docket/work/tasks/JOB-1-shared.md"),
        "utf8",
      ),
    ).not.toContain("Wrong replacement");
    await writeFile(join(f.worker, "docket.yaml"), config);
    const partial = await router.bind(
      { "docket/target": { root: f.worker } },
      none,
      true,
    );
    await router.run(partial, async () => {
      await partial.owner.mutate(async ({ store }) => {
        await store.write("reference/one.md", "Already saved.");
        await writeFile(
          join(f.worker, "docket.yaml"),
          `${config}# changed after first write\n`,
        );
        await expect(
          store.write("reference/two.md", "Refused."),
        ).rejects.toMatchObject({
          code: "target-changed",
          mutation: "partial",
        });
      });
    });
    expect(
      await readFile(join(f.worker, "docket/reference/one.md"), "utf8"),
    ).toBe("Already saved.");
  } finally {
    router.close();
    await c.close();
    await rm(f.base, { recursive: true, force: true });
  }
});

test("routed telemetry uses the selected checkout and excludes root paths, identities, arguments and authored content", async () => {
  const f = await fixture();
  const old = process.env.DOCKET_TELEMETRY_DIR;
  process.env.DOCKET_TELEMETRY_DIR = join(f.base, "usage");
  const main = new TelemetryStore(f.main);
  const worker = new TelemetryStore(f.worker);
  main.enable();
  worker.enable();
  const c = await connect(f.main, roots(f.worker));
  try {
    const result = await c.call("append_log", {
      id: "JOB-1",
      entry: "PRIVATE_CONTENT",
      response: "compact",
    });
    const events = worker
      .events()
      .filter((event) => event.kind === "operation");
    expect(events.length).toBe(1);
    expect(
      main.events().filter((event) => event.kind === "operation").length,
    ).toBe(0);
    expect(events[0]?.responseBytes).toBe(result.bytes);
    expect(JSON.stringify(events)).not.toContain(f.base);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_CONTENT|JOB-1/);
    expect(JSON.stringify(events)).not.toContain(result.data.checkout.identity);
    await symlink(
      join(f.main, "dirty.txt"),
      join(f.worker, "docket/escape.md"),
    );
    const router = new TargetRouter(
      new LocalFileStore(join(f.main, "docket")),
      parseConfig(config),
      f.main,
    );
    try {
      const bound = await router.bind(
        { "docket/target": { root: f.worker } },
        none,
        true,
      );
      await router.run(bound, async () => {
        await bound.owner.mutate(async ({ store }) => {
          await expect(
            store.write("escape.md", "Overwrite"),
          ).rejects.toMatchObject({
            code: "target-containment",
            mutation: "unchanged",
          });
          await store.write("retained.md", "First successful write");
          await expect(
            store.write("escape.md", "Overwrite"),
          ).rejects.toMatchObject({
            code: "target-containment",
            mutation: "partial",
          });
        });
        expect(bound.targetFailure?.mutation).toBe("partial");
      });
      expect(await readFile(join(f.worker, "docket/retained.md"), "utf8")).toBe(
        "First successful write",
      );
    } finally {
      router.close();
    }
    expect(await readFile(join(f.main, "dirty.txt"), "utf8")).toBe(
      "Unrelated dirty source",
    );
  } finally {
    await c.close();
    if (old === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = old;
    await rm(f.base, { recursive: true, force: true });
  }
});
