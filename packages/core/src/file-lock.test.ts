import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate builtin-module fault injection from the rest of the test process.
async function probe(body: string): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "docket-lock-probe-"));
  try {
    const script = `import { mock } from "bun:test"; import { hostname } from "node:os"; import { join } from "node:path"; const real = { ...await import("node:fs/promises") }; const root = ${JSON.stringify(root)}; const modulePath = ${JSON.stringify(join(import.meta.dir, "file-lock.ts"))}; const options = {lockTimeoutMs: 2000, staleLockMs: 100, retryDelayMs: 1}; ${body}`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5000);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`lock probe exited ${code}: ${stderr}`);
    return JSON.parse(stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("two stale recoverers cannot remove a newly acquired live lock", async () => {
  const result = await probe(`
    const directory = join(root, "lock"); const oldOwner = join(directory, "owner.json");
    await real.mkdir(directory); await real.writeFile(oldOwner, JSON.stringify({pid: 2147483647, host: hostname()}));
    let observed = 0, removals = 0, active = 0, maxActive = 0;
    let releaseObservations, firstAcquired;
    const bothObserved = new Promise(resolve => releaseObservations = resolve);
    const acquired = new Promise(resolve => firstAcquired = resolve);
    const beforeRemoval = async () => { if (++removals === 2) await acquired; };
    mock.module("node:fs/promises", () => ({ ...real,
      readFile: async (path, ...args) => { const source = await real.readFile(path, ...args); if (path === oldOwner) { if (++observed === 2) releaseObservations(); await bothObserved; } return source; },
      unlink: async path => { if (path === oldOwner) await beforeRemoval(); return real.unlink(path); },
      rename: async (from, to) => { if (from === directory) await beforeRemoval(); return real.rename(from, to); },
    }));
    const { acquireFileLock } = await import(modulePath);
    const operation = async () => { const lock = await acquireFileLock(directory, options); active++; maxActive = Math.max(maxActive, active); firstAcquired(); await Bun.sleep(20); active--; await lock.release(); };
    await Promise.all([operation(), operation()]);
    console.log(JSON.stringify({maxActive, remaining: await real.readdir(root)}));
  `);
  expect(result).toEqual({ maxActive: 1, remaining: [] });
});

test("owner publication failure cleans its candidate and cannot strand the shared lock", async () => {
  const result = await probe(`
    let fail = true;
    mock.module("node:fs/promises", () => ({ ...real, writeFile: async (...args) => { if (fail) throw new Error("injected owner publication failure"); return real.writeFile(...args); } }));
    const { acquireFileLock } = await import(modulePath);
    let message; try { await acquireFileLock(join(root, "lock"), options); } catch (error) { message = error.message; }
    const afterFailure = await real.readdir(root);
    fail = false; const lock = await acquireFileLock(join(root, "lock"), options); await lock.release();
    console.log(JSON.stringify({message, afterFailure, remaining: await real.readdir(root)}));
  `);
  expect(result).toEqual({
    message: "injected owner publication failure",
    afterFailure: [],
    remaining: [],
  });
});

test("a delayed release cannot remove replacement ownership", async () => {
  const result = await probe(`
    const { acquireFileLock } = await import(modulePath);
    const directory = join(root, "lock"); const old = await acquireFileLock(directory, options);
    const [ownerName] = await real.readdir(directory);
    await real.writeFile(join(directory, ownerName), JSON.stringify({pid: 2147483647, host: hostname()}));
    const current = await acquireFileLock(directory, options); await old.release();
    const present = (await real.readdir(directory)).length;
    await current.release(); console.log(JSON.stringify({present, remaining: await real.readdir(root)}));
  `);
  expect(result).toEqual({ present: 1, remaining: [] });
});
