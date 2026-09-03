// Serve entry: bundle the client with Bun's bundler at startup (no build
// step, no dev server — the SPA is small enough to build in-process) and
// hand Bun.serve the Hono app. Bundle changes always publish a lightweight
// revision over SSE; `--watch` separately rebuilds client source and
// hard-reloads tabs during Docket development.

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocketConfig } from "@docket/core";
import { type Assets, createApp, localRequestBoundary } from "./app";
import { createCommitter } from "./commit";
import { createRepoContext } from "./state";

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
  /** Serve /dev/reload; undefined lets the request fall through to the app. */
  handle(req: Request): Response | undefined;
}

interface DataWatcher {
  /** Serve /api/events; undefined lets the request fall through to the app. */
  handle(req: Request): Response | undefined;
}

// Files remain the source of truth: the watcher carries only a monotonically
// increasing invalidation id. On every connection we send the current id, so
// EventSource reconnects catch up even if mutations happened while offline.
function startDataWatcher(
  root: string,
  config: DocketConfig,
  invalidate: () => void,
): DataWatcher {
  const encoder = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let revision = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const event = () => encoder.encode(`id: ${revision}\ndata: ${revision}\n\n`);
  const publish = () => {
    invalidate();
    revision++;
    const message = event();
    for (const client of clients) {
      try {
        client.enqueue(message);
      } catch {
        clients.delete(client);
      }
    }
  };

  watch(join(root, config.bundle), { recursive: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(publish, 80);
  }).unref();

  return {
    handle(req) {
      if (new URL(req.url).pathname !== "/api/events") return undefined;
      let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          opened = controller;
          clients.add(controller);
          controller.enqueue(event());
          heartbeat = setInterval(
            () => controller.enqueue(encoder.encode(": keepalive\n\n")),
            8000,
          );
          heartbeat.unref();
        },
        cancel() {
          if (opened) clients.delete(opened);
          clearInterval(heartbeat);
        },
      });
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

  const rebuild = async () => {
    try {
      const next = await buildAssets({ dev: true });
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
  watch(join(import.meta.dir, "client"), { recursive: true }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(rebuild, 80);
  }).unref(); // Bun.serve holds the process open; the watcher shouldn't.

  return {
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
        },
        cancel() {
          if (opened) clients.delete(opened);
          clearInterval(heartbeat);
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
    commit: opts.commit ? createCommitter(root, config.bundle) : undefined,
  });
  const data = startDataWatcher(root, config, () => ctx.invalidate());
  const dev = opts.watch ? startWatcher(assets) : undefined;
  return Bun.serve({
    // Docket serves a repository read/write API. The first public contract is
    // deliberately same-computer only; there is no host override.
    hostname: "127.0.0.1",
    port: opts.port ?? 4180,
    // Both SSE streams send keepalives below Bun's default idle timeout.
    fetch: (req) => {
      const boundaryError = localRequestBoundary(req);
      if (boundaryError)
        return Response.json({ error: boundaryError }, { status: 403 });
      return data.handle(req) ?? dev?.handle(req) ?? app.fetch(req);
    },
  });
}
