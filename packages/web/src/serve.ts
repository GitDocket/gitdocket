// Serve entry: bundle the client with Bun's bundler at startup (no build
// step, no dev server — the SPA is small enough to build in-process) and
// hand Bun.serve the Hono app. Bundle changes always publish a lightweight
// revision over SSE; `--watch` separately rebuilds client source and
// hard-reloads tabs during Docket development.

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocketConfig } from "@gitdocket/core";
import { type Assets, createApp, localRequestBoundary } from "./app";
import { createCommitter } from "./commit";
import { watchGit } from "./git-watch";
import { createRepoContext, type RepoContext } from "./state";

// Replaced with prebuilt assets by the standalone release build. Source and
// npm development installs keep compiling their client as before.
declare const DOCKET_EMBEDDED_ASSETS: Assets | undefined;

export interface ServeOptions {
  port?: number;
  ttlMs?: number;
  watch?: boolean;
  /** Commit each UI write, pathspec-limited. */
  commit?: boolean;
}

export async function buildAssets(
  opts: { dev?: boolean } = {},
): Promise<Assets> {
  if (typeof DOCKET_EMBEDDED_ASSETS !== "undefined") {
    if (opts.dev) {
      throw new Error(
        "--watch requires a source installation; standalone releases contain prebuilt browser assets",
      );
    }
    return { ...DOCKET_EMBEDDED_ASSETS };
  }
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "client", "main.tsx")],
    target: "browser",
    minify: !opts.dev,
    define: {
      "process.env.NODE_ENV": opts.dev ? '"development"' : '"production"',
    },
    throw: false, // surface logs ourselves — watch mode must outlive bad builds
  });
  const entry = result.outputs[0];
  if (!result.success || !entry) {
    throw new Error(`client build failed:\n${result.logs.join("\n")}`);
  }
  return {
    js: await entry.text(),
    css: await readFile(join(import.meta.dir, "client", "styles.css"), "utf8"),
  };
}

// Appended to the bundle in watch mode only. EventSource auto-reconnects,
// so tabs survive a serve restart too.
const RELOAD_JS = `\n;new EventSource("/dev/reload").onmessage = () => location.reload();\n`;

interface DevWatcher {
  close(): void;
  /** Serve /dev/reload; undefined lets the request fall through to the app. */
  handle(req: Request): Response | undefined;
}

interface DataWatcher {
  close(): void;
  /** Serve /api/events; undefined lets the request fall through to the app. */
  handle(req: Request): Response | undefined;
}

// Files remain the source of truth: the watcher carries only a monotonically
// increasing invalidation id. On every connection we send the current id, so
// EventSource reconnects catch up even if mutations happened while offline.
async function startDataWatcher(
  root: string,
  ctx: RepoContext,
): Promise<DataWatcher> {
  const encoder = new TextEncoder();
  const clients = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    ReturnType<typeof setInterval>
  >();
  const instance = crypto.randomUUID();
  let revision = 0;
  let stopped = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bundleWatcher: ReturnType<typeof watch> | undefined;
  let watchedRoot: string | undefined;
  let signalRequested = false;
  const event = () =>
    encoder.encode(
      "id: " +
        instance +
        ":" +
        revision +
        "\ndata: " +
        instance +
        ":" +
        revision +
        "\n\n",
    );
  const end = (client: ReadableStreamDefaultController<Uint8Array>) => {
    clearInterval(clients.get(client));
    clients.delete(client);
    try {
      client.close();
    } catch {
      /* Already disconnected. */
    }
  };
  const send = (
    client: ReadableStreamDefaultController<Uint8Array>,
    message: Uint8Array,
  ) => {
    try {
      if ((client.desiredSize ?? 0) <= 0) {
        end(client);
        return;
      }
      client.enqueue(message);
    } catch {
      end(client);
    }
  };
  const publish = () => {
    if (stopped) return;
    revision++;
    signalRequested = false;
    attachBundleWatcher();
    for (const client of clients.keys()) send(client, event());
  };
  const schedule = (paths?: readonly string[]) => {
    if (stopped) return;
    ctx.invalidate(paths);
    signalRequested = true;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      void ctx
        .state()
        .then(() => {
          if (signalRequested) publish();
        })
        .catch(() => {});
    }, 25);
  };
  const attachBundleWatcher = () => {
    if (bundleWatcher && watchedRoot === ctx.store.root) return;
    bundleWatcher?.close();
    watchedRoot = ctx.store.root;
    try {
      bundleWatcher = watch(watchedRoot, { recursive: true }, () => {
        // Recursive watchers can omit nested changes while reporting a root
        // change from the same write burst. Reconcile metadata for every file;
        // the bundle index still reads and parses only changed versions.
        schedule();
      });
      bundleWatcher.on("error", () => {
        bundleWatcher?.close();
        bundleWatcher = undefined;
        schedule();
      });
      bundleWatcher.unref();
    } catch {
      bundleWatcher = undefined;
    }
  };
  attachBundleWatcher();
  let configWatcher: ReturnType<typeof watch> | undefined;
  try {
    configWatcher = watch(root, (_event, filename) => {
      if (!filename || String(filename) === "docket.yaml") schedule();
    });
    configWatcher.on("error", () => {
      configWatcher?.close();
      configWatcher = undefined;
      schedule();
    });
    configWatcher.unref();
  } catch {
    /* Periodic reconciliation remains authoritative. */
  }
  const unsubscribe = ctx.subscribe(publish);
  const closeGit = await watchGit(root, () => {
    ctx.invalidateGit();
    schedule([]);
  });
  const reconcile = async () => {
    try {
      attachBundleWatcher();
      await ctx.refresh({ background: true });
    } catch {
      /* Existing readers retain explicitly marked last-known data. */
    } finally {
      if (!stopped) {
        timer = setTimeout(reconcile, 500);
        timer.unref();
      }
    }
  };
  void reconcile();
  return {
    close() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      clearTimeout(timer);
      clearTimeout(debounce);
      bundleWatcher?.close();
      configWatcher?.close();
      closeGit();
      for (const client of [...clients.keys()]) end(client);
    },
    handle(req) {
      if (new URL(req.url).pathname !== "/api/events") return undefined;
      let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            opened = controller;
            const heartbeat = setInterval(
              () => send(controller, encoder.encode(": keepalive\n\n")),
              8000,
            );
            heartbeat.unref();
            clients.set(controller, heartbeat);
            send(controller, event());
          },
          cancel() {
            if (opened) end(opened);
          },
        },
        { highWaterMark: 8 },
      );
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    },
  };
}

// Watch client sources, rebuild into the shared assets object (the app reads
// it per request), and announce over SSE. A failed rebuild logs and keeps the
// last good build — the watcher and server stay up.
function startWatcher(assets: Assets): DevWatcher {
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const heartbeats = new Set<ReturnType<typeof setInterval>>();
  let stopped = false;

  const rebuild = async () => {
    try {
      const next = await buildAssets({ dev: true });
      if (stopped) return;
      assets.js = next.js + RELOAD_JS;
      assets.css = next.css;
      console.log("docket serve — client rebuilt, reloading tabs");
      for (const client of clients) {
        try {
          client.enqueue(encoder.encode("data: reload\n\n"));
        } catch {
          clients.delete(client);
        }
      }
    } catch (error) {
      console.error(
        `docket serve — rebuild failed, still serving the previous build\n${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  assets.js += RELOAD_JS;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(
    join(import.meta.dir, "client"),
    { recursive: true },
    () => {
      clearTimeout(debounce);
      debounce = setTimeout(rebuild, 80);
    },
  );
  watcher.unref();

  return {
    close() {
      stopped = true;
      watcher.close();
      clearTimeout(debounce);
      for (const heartbeat of heartbeats) clearInterval(heartbeat);
      heartbeats.clear();
      for (const client of clients) {
        try {
          client.close();
        } catch {
          /* Already disconnected. */
        }
      }
      clients.clear();
    },
    handle(req) {
      if (new URL(req.url).pathname !== "/dev/reload") return undefined;
      let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          opened = controller;
          clients.add(controller);
          controller.enqueue(encoder.encode(": watching\n\n"));
          heartbeat = setInterval(
            () => controller.enqueue(encoder.encode(": keepalive\n\n")),
            8000,
          );
          heartbeat.unref();
          heartbeats.add(heartbeat);
        },
        cancel() {
          if (opened) clients.delete(opened);
          clearInterval(heartbeat);
          if (heartbeat) heartbeats.delete(heartbeat);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },
  };
}

export async function startServe(
  root: string,
  config: DocketConfig,
  opts: ServeOptions = {},
  /** Reuse one real client build in integration tests; production omits this. */
  preparedAssets?: Assets,
): Promise<ReturnType<typeof Bun.serve>> {
  const assets = preparedAssets
    ? { ...preparedAssets }
    : await buildAssets({ dev: opts.watch });
  const ctx = createRepoContext(root, config, { ttlMs: opts.ttlMs });
  const app = createApp(ctx, assets, {
    committerFor: opts.commit
      ? (bundle) => createCommitter(root, bundle)
      : undefined,
  });
  let data: DataWatcher | undefined;
  let dev: DevWatcher | undefined;
  try {
    data = await startDataWatcher(root, ctx);
    dev = opts.watch ? startWatcher(assets) : undefined;
    const server = Bun.serve({
      // Docket serves a repository read/write API. The first public contract is
      // deliberately same-computer only; there is no host override.
      hostname: "127.0.0.1",
      port: opts.port ?? 4180,
      // Both SSE streams send keepalives below Bun's default idle timeout.
      fetch: (req) => {
        const boundaryError = localRequestBoundary(req);
        if (boundaryError)
          return Response.json({ error: boundaryError }, { status: 403 });
        return data?.handle(req) ?? dev?.handle(req) ?? app.fetch(req);
      },
    });
    const stop = server.stop.bind(server);
    server.stop = (...args) => {
      ctx.close();
      data?.close();
      dev?.close();
      return stop(...args);
    };
    return server;
  } catch (error) {
    ctx.close();
    data?.close();
    dev?.close();
    throw error;
  }
}
