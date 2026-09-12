import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@gitdocket/core";
import { watchGit } from "./git-watch";
import { startServe } from "./serve";

const cleanup: (() => unknown)[] = [];
const servers: Awaited<ReturnType<typeof startServe>>[] = [];
afterEach(async () => {
  // Bun 1.3.14 can leave stop's promise pending after closing multiple SSE
  // connections (also reproduced without Docket). Explicitly close resources
  // and clients; the Serve suite separately asserts server-initiated EOF.
  for (const server of servers.splice(0)) void server.stop(true);
  await Promise.all(cleanup.reverse().map((close) => close()));
  cleanup.length = 0;
});

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "docket-git-refresh-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  await mkdir(join(root, "docs"));
  await writeFile(
    join(root, "docs", "task.md"),
    "---\ntype: Task\ntitle: Test\nid: DKT-1\nstatus: todo\n---\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial bundle");
  return root;
}

async function event(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("missing Git event")), 3000);
      }),
    ]);
    return new TextDecoder().decode(result.value);
  } finally {
    clearTimeout(timer);
  }
}

async function serve(root: string) {
  const server = await startServe(
    root,
    parseConfig("bundle: docs/"),
    { port: 0, ttlMs: 60_000 },
    { js: "", css: "" },
  );
  servers.push(server);
  await fetch(new URL("/api/activity", server.url));
  const response = await fetch(new URL("/api/events", server.url));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing event stream");
  cleanup.push(() => reader.cancel().catch(() => {}));
  const initial = await event(reader);
  expect(initial).toMatch(/id: [\w-]+:\d+/);
  return { server, reader, initial };
}

describe("Git-triggered refresh", () => {
  test("over-limit inventory does not repeatedly supersede background captures", async () => {
    const root = await fixture();
    const head = `${git(root, "rev-parse", "HEAD")}\n`;
    const directory = join(root, ".git", "refs", "heads");
    for (let offset = 0; offset < 4100; offset += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          writeFile(join(directory, `overflow-${offset + i}`), head),
        ),
      );
    }
    let invalidations = 0;
    const close = await watchGit(root, () => invalidations++);
    cleanup.push(close);
    // More than two watcher cadences. The normal provider timer remains the
    // source of freshness; no synthetic change may invalidate its slow capture.
    await Bun.sleep(2400);
    expect(invalidations).toBe(0);
  });

  test("a Git-only commit notifies tabs and invalidates cached Activity", async () => {
    const root = await fixture();
    const { server, reader, initial } = await serve(root);
    const second = (
      await fetch(new URL("/api/events", server.url))
    ).body?.getReader();
    if (!second) throw new Error("missing event stream");
    cleanup.push(() => second.cancel().catch(() => {}));
    expect(await event(second)).toBe(initial);
    const activity = async () =>
      (await (await fetch(new URL("/api/activity", server.url))).json()) as {
        activity: { subject: string }[];
      };
    expect((await activity()).activity).toHaveLength(0);
    git(
      root,
      "commit",
      "--allow-empty",
      "-m",
      "Git-only update\n\nTask: DKT-1",
    );
    const changed = await event(reader);
    expect(changed).not.toBe(initial);
    expect(await event(second)).toBe(changed);
    expect((await activity()).activity[0]?.subject).toBe("Git-only update");
    await Bun.sleep(200);
    const reconnected = (
      await fetch(new URL("/api/events", server.url))
    ).body?.getReader();
    if (!reconnected) throw new Error("missing event stream");
    cleanup.push(() => reconnected.cancel().catch(() => {}));
    // Reading Git evidence must not cause another invalidation.
    expect(await event(reconnected)).toBe(changed);
  });

  test("linked worktrees watch their HEAD and shared refs, including packed refs", async () => {
    const root = await fixture();
    const linked = join(root, "linked");
    git(root, "worktree", "add", "-b", "feature", linked);
    const { reader, initial } = await serve(linked);
    let previous = initial;
    const changed = async () => {
      const next = await event(reader);
      expect(next).not.toBe(previous);
      previous = next;
    };
    git(root, "commit", "--allow-empty", "-m", "Common branch update");
    await changed();
    git(linked, "checkout", "--detach", "main");
    await changed();
    git(linked, "commit", "--allow-empty", "-m", "Detached update");
    await changed();
    git(root, "pack-refs", "--all", "--prune");
    await changed();
  });

  test("ignores index, object, and lock writes and releases watchers", async () => {
    const root = await fixture();
    let count = 0;
    const close = await watchGit(root, () => count++);
    cleanup.push(close);
    await writeFile(join(root, "unrelated.txt"), "staged data");
    git(root, "add", "unrelated.txt");
    await writeFile(join(root, ".git", "refs", "heads", "main.lock"), "lock");
    await Bun.sleep(1200);
    expect(count).toBe(0);
    close();
    git(root, "branch", "after-close");
    await Bun.sleep(1200);
    expect(count).toBe(0);
  });
});
