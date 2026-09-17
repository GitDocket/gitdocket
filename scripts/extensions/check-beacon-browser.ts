#!/usr/bin/env bun
// Real Chromium download verification through CDP, without an automation dependency.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Json = Record<string, unknown>;
type RequestObservation = { event: string; url: string; sessionId?: string };
type Download = {
  guid: string;
  url: string;
  suggestedFilename: string;
  state?: string;
};
type CaseResult = {
  name: string;
  status: "pass" | "fail";
  error?: string;
  requests: RequestObservation[];
  serverRequests: string[];
  observationMs?: number;
  download?: Json;
};
const args = new Map(
  Bun.argv.slice(2).map((arg) => {
    const split = arg.indexOf("=");
    return [arg.slice(0, split), arg.slice(split + 1)];
  }),
);
for (const arg of Bun.argv.slice(2)) {
  if (!/^--(root|chrome|output|observation-ms)=.+/.test(arg))
    throw new Error(`Unknown argument: ${arg}`);
}
const root = resolve(args.get("--root") ?? ".");
const observationMs = Number(args.get("--observation-ms") ?? 1000);
if (
  !Number.isFinite(observationMs) ||
  observationMs < 500 ||
  observationMs > 30_000
)
  throw new Error("--observation-ms must be between 500 and 30000");
const output = args.get("--output");
const results: CaseResult[] = [];
const pending = new Map<
  number,
  {
    resolve: (value: Json) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const downloads = new Map<string, Download>();
const protocolErrors: string[] = [];
let active: CaseResult | undefined;
let socket: WebSocket | undefined;
let chrome: ReturnType<typeof Bun.spawn> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let temporary: string | undefined;
let pageSession = "";
let sequence = 0;
let stderrTail = "";
let browserVersion: Json | undefined;
let unsupported = false;
let failure: string | undefined;

function cdp(
  method: string,
  params: Json = {},
  sessionId?: string,
): Promise<Json> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    socket?.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
}
const page = (method: string, params: Json = {}) =>
  cdp(method, params, pageSession);
async function evaluate(expression: string) {
  const result = await page("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return (result.result as { value: unknown }).value;
}
async function waitUntil(
  check: () => Promise<boolean> | boolean,
  label: string,
  timeout = 7000,
) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeout)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}
async function ready(expectedCount: number) {
  await waitUntil(async () => {
    try {
      return (
        (await evaluate(
          `document.readyState === 'complete' && document.documentElement.dataset.beaconReady === 'true' && document.querySelectorAll('#bookmarks [data-bookmark]').length === ${expectedCount}`,
        )) === true
      );
    } catch {
      return false;
    }
  }, "Beacon rendering");
  await Bun.sleep(150);
}
async function click(selector: string) {
  const bounds = (await evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return null; const box = el.getBoundingClientRect(); const style = getComputedStyle(el); if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') return null; el.scrollIntoView({block:'center'}); const visible = el.getBoundingClientRect(); return {x:visible.x + visible.width/2, y:visible.y + visible.height/2}; })()`,
  )) as { x: number; y: number } | null;
  assert.ok(bounds, `Missing visible enabled control: ${selector}`);
  await page("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...bounds,
  });
  await page("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...bounds,
  });
}
const isNetwork = (url: string) => !/^(blob|data|about):/.test(url);
async function appIdentity() {
  const appHashes: Record<string, string> = {};
  async function walk(directory: string, prefix = "") {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(prefix, entry.name);
      if (entry.isDirectory()) await walk(join(directory, entry.name), name);
      else if (entry.isFile())
        appHashes[name] = createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex");
    }
  }
  await walk(join(root, "app"));
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: root });
  const head = git("rev-parse", "HEAD");
  const diff = git("diff", "HEAD", "--");
  const status = git("status", "--porcelain");
  return {
    root,
    revision: head.exitCode === 0 ? head.stdout.toString().trim() : null,
    workingDiffSha256:
      diff.exitCode === 0
        ? createHash("sha256").update(diff.stdout).digest("hex")
        : null,
    gitStatus: status.exitCode === 0 ? status.stdout.toString().trim() : null,
    appHashes,
    checkerSha256: createHash("sha256")
      .update(await readFile(import.meta.path))
      .digest("hex"),
  };
}
const candidate = await appIdentity();
try {
  const explicitChrome = args.get("--chrome") ?? process.env.CHROME_PATH;
  const candidates = explicitChrome
    ? [explicitChrome]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
      ];
  let chromePath: string | undefined;
  for (const path of candidates)
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      chromePath = path;
      break;
    }
  if (!chromePath) {
    unsupported = true;
    throw new Error(
      "Chromium is unavailable; pass --chrome=/path/to/executable or CHROME_PATH",
    );
  }
  const fixtureModule = await import(
    pathToFileURL(join(root, "app/fixtures.js")).href
  );
  const fixtures = fixtureModule.bookmarkFixtures as Json[];
  assert.equal(fixtures.length, 2, "Fixture has ordinary and Unicode records");
  const { STORAGE_KEY } = await import(
    pathToFileURL(join(root, "app/bookmarks.js")).href
  );
  assert.equal(STORAGE_KEY, "beacon.bookmarks.v1");
  temporary = await mkdtemp(join(tmpdir(), "beacon-chromium-"));
  const profile = join(temporary, "profile");
  const downloadDirectory = join(temporary, "downloads");
  await mkdir(downloadDirectory);
  const allowed = new Set([
    "index.html",
    "app.js",
    "bookmarks.js",
    "fixtures.js",
    "style.css",
  ]);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (active) active.serverRequests.push(request.url);
      const name = new URL(request.url).pathname.slice(1) || "index.html";
      if (!allowed.has(name)) return new Response("Not found", { status: 404 });
      return new Response(Bun.file(join(root, "app", name)));
    },
  });
  chrome = Bun.spawn(
    [
      chromePath,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderrReader = (
    chrome.stderr as ReadableStream<Uint8Array>
  ).getReader();
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await stderrReader.read();
        if (done) break;
        stderrTail = (
          stderrTail + decoder.decode(value, { stream: true })
        ).slice(-4096);
      }
    } finally {
      stderrReader.releaseLock();
    }
  })();
  let port = "";
  await waitUntil(
    async () => {
      if (chrome?.exitCode !== null)
        throw new Error(`Chromium exited ${chrome?.exitCode}`);
      port =
        (
          await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(
            () => "",
          )
        ).split("\n")[0] ?? "";
      return Boolean(port);
    },
    "Chromium debugging port",
    10_000,
  );
  const version = (await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json()) as { webSocketDebuggerUrl: string };
  socket = new WebSocket(version.webSocketDebuggerUrl);
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error)
        waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const session = message.params.sessionId;
      void (async () => {
        await cdp("Network.enable", {}, session);
        await cdp(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
          session,
        );
        await cdp("Runtime.runIfWaitingForDebugger", {}, session);
      })().catch((error) => protocolErrors.push(String(error)));
    }
    if (
      active &&
      message.method === "Network.requestWillBeSent" &&
      isNetwork(message.params.request.url)
    )
      active.requests.push({
        event: message.method,
        url: message.params.request.url,
        sessionId: message.sessionId,
      });
    if (active && message.method === "Network.webSocketCreated")
      active.requests.push({
        event: message.method,
        url: message.params.url,
        sessionId: message.sessionId,
      });
    if (message.method === "Browser.downloadWillBegin")
      downloads.set(message.params.guid, message.params);
    if (message.method === "Browser.downloadProgress") {
      const download = downloads.get(message.params.guid);
      if (download) download.state = message.params.state;
    }
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Chromium CDP connection timed out")),
      10_000,
    );
    if (!socket) return reject(new Error("Missing socket"));
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Chromium CDP connection failed"));
    };
  });
  browserVersion = await cdp("Browser.getVersion");
  await cdp("Browser.setDownloadBehavior", {
    behavior: "allowAndName",
    downloadPath: downloadDirectory,
    eventsEnabled: true,
  });
  const target = await cdp("Target.createTarget", { url: "about:blank" });
  const attached = await cdp("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  pageSession = attached.sessionId as string;
  await page("Page.enable");
  await page("Network.enable");
  await page("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  await page("Page.navigate", { url: String(server.url) });
  await ready(fixtures.length);

  // Establish that this is a working app before checking the missing feature.
  const smoke: CaseResult = {
    name: "baseline browser rendering, add, persistence and remove",
    status: "pass",
    requests: [],
    serverRequests: [],
  };
  try {
    const added = {
      title: "A local addition",
      url: "https://example.invalid/added",
      tags: ["new", "local"],
    };
    await evaluate(
      `(() => { const f = document.querySelector('#add-bookmark'); f.elements.title.value = ${JSON.stringify(added.title)}; f.elements.url.value = ${JSON.stringify(added.url)}; f.elements.tags.value = 'new, local'; })()`,
    );
    await click("#add-bookmark button[type=submit]");
    await ready(fixtures.length + 1);
    const saved = await evaluate(
      `JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}))`,
    );
    assert.deepEqual(saved, [...fixtures, added]);
    await page("Page.reload");
    await ready(fixtures.length + 1);
    await click("#bookmarks [data-bookmark]:last-child button");
    await ready(fixtures.length);
    assert.deepEqual(
      await evaluate(
        `JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}))`,
      ),
      fixtures,
    );
  } catch (error) {
    smoke.status = "fail";
    smoke.error = error instanceof Error ? error.message : String(error);
  }
  results.push(smoke);

  for (const entry of [
    {
      name: "populated export retains version, titles, URLs, tags and Unicode",
      bookmarks: fixtures,
    },
    { name: "empty export downloads an empty array", bookmarks: [] },
  ]) {
    const result: CaseResult = {
      name: entry.name,
      status: "pass",
      requests: [],
      serverRequests: [],
    };
    let actionStarted: number | undefined;
    try {
      await evaluate(
        `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(entry.bookmarks))})`,
      );
      await page("Page.reload");
      await ready(entry.bookmarks.length);
      downloads.clear();
      active = result;
      actionStarted = Date.now();
      await click('button[data-action="export"]');
      await waitUntil(
        () =>
          Array.from(downloads.values()).some(
            (item) => item.state === "completed" || item.state === "canceled",
          ),
        "completed browser download",
      );
      const completed = Array.from(downloads.values());
      assert.equal(
        completed.length,
        1,
        "One export click creates one download",
      );
      const download = completed[0];
      assert.ok(download);
      assert.equal(
        download.state,
        "completed",
        "Browser reports completed download",
      );
      const text = await readFile(
        join(downloadDirectory, download.guid),
        "utf8",
      );
      result.download = {
        ...download,
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
      };
      assert.ok(
        !isNetwork(download.url),
        "The download artifact must use a local blob: or data: URL",
      );
      assert.match(
        download.suggestedFilename,
        /\.json$/i,
        "Download has a JSON filename",
      );
      assert.deepEqual(JSON.parse(text), {
        schemaVersion: 1,
        bookmarks: entry.bookmarks,
      });
      assert.deepEqual(
        await evaluate(
          `JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}))`,
        ),
        entry.bookmarks,
        "Export leaves saved records unchanged",
      );
    } catch (error) {
      result.status = "fail";
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (actionStarted !== undefined) {
        await Bun.sleep(observationMs);
        result.observationMs = Date.now() - actionStarted;
      }
      active = undefined;
      if (result.requests.length || result.serverRequests.length) {
        result.status = "fail";
        result.error = [result.error, "Export attempted network access"]
          .filter(Boolean)
          .join("; ");
      }
      if (protocolErrors.length) {
        result.status = "fail";
        result.error = [
          result.error,
          `Required CDP observation failed: ${protocolErrors.join("; ")}`,
        ]
          .filter(Boolean)
          .join("; ");
      }
      results.push(result);
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  socket?.close();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  chrome?.kill("SIGKILL");
  await chrome?.exited;
  server?.stop(true);
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
const status = unsupported
  ? "unsupported"
  : failure ||
      results.some((result) => result.status === "fail") ||
      results.length !== 3
    ? "fail"
    : "pass";
const receipt = {
  check: "beacon-real-chromium-download",
  status,
  candidate,
  browserVersion,
  observation:
    "Page and attached worker CDP request attempts, WebSockets, and loopback server requests from action through download completion plus the configured observation window. Local blob/data artifacts excluded. Browser-internal background requests and arbitrarily delayed requests after the window are outside this claim.",
  configuredObservationMs: observationMs,
  results,
  failure,
  ...(failure ? { chromiumStderrTail: stderrTail } : {}),
};
if (output) {
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify(receipt, null, 2));
if (status !== "pass") process.exitCode = unsupported ? 2 : 1;
