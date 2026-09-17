import type { Dirent } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// Bun's native directory watcher does not reliably report .git changes.
// Compare only published refs and HEAD: never scan objects, logs, or indexes,
// and never run Git history/status queries on the timer. Linked worktrees
// share refs but have their own HEAD, so Git resolves both metadata paths.
export async function watchGit(
  root: string,
  changed: () => void,
): Promise<() => void> {
  let paths: string[];
  try {
    const result = Bun.spawn(
      ["git", "rev-parse", "--absolute-git-dir", "--git-common-dir"],
      {
        cwd: root,
        env: process.env,
        stdout: "pipe",
        stderr: "ignore",
        signal: AbortSignal.timeout(5000),
      },
    );
    const [output, exitCode] = await Promise.all([
      new Response(result.stdout).text(),
      result.exited,
    ]);
    if (exitCode !== 0) return () => {};
    paths = [
      ...new Set(
        output
          .trim()
          .split("\n")
          .map((path) => resolve(root, path)),
      ),
    ];
  } catch {
    // Serve also supports bundles without Git installed or initialized.
    return () => {};
  }

  const file = async (path: string): Promise<string> => {
    try {
      const info = await stat(path, { bigint: true });
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  };
  let visited = 0;
  let overflow = false;
  let deadline = 0;
  const refs = async (directory: string): Promise<string> => {
    const entries: Dirent[] = [];
    try {
      // Bun on Linux may defer ENOENT until directory iteration. A worktree's
      // private refs directory normally does not exist; still scan shared refs.
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (stopped) break;
        if (entry.name.endsWith(".lock")) continue;
        if (++visited > 4096 || Date.now() > deadline) {
          overflow = true;
          break;
        }
        entries.push(entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]";
      throw error;
    }
    const result: string[] = [];
    // Sequential reads bound open files even in repositories with many refs.
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.endsWith(".lock")) continue;
      if (stopped) break;
      if (Date.now() > deadline) {
        overflow = true;
        break;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) result.push(entry.name, await refs(path));
      else if (entry.isFile()) result.push(entry.name, await file(path));
    }
    return JSON.stringify(result);
  };
  const snapshot = async () => {
    visited = 0;
    overflow = false;
    deadline = Date.now() + 1000;
    const result: string[] = [];
    for (const directory of paths) {
      for (const name of ["HEAD", "packed-refs", "shallow"]) {
        result.push(await file(join(directory, name)));
      }
      result.push(await refs(join(directory, "refs")));
    }
    // An incomplete inventory cannot prove a change. The independent periodic
    // Git provider checks freshness without superseding its pending capture.
    // Synthetic changing fingerprints here could starve a slow capture forever.
    return overflow ? undefined : JSON.stringify(result);
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: string | undefined;
  const check = async () => {
    try {
      const next = await snapshot();
      if (
        !stopped &&
        previous !== undefined &&
        next !== undefined &&
        next !== previous
      )
        changed();
      previous = next;
    } catch {
      // Transient permission/deletion errors keep the last known snapshot.
    } finally {
      if (!stopped) {
        timer = setTimeout(check, 1000);
        timer.unref();
      }
    }
  };
  await check();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
