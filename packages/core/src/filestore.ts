// FileStore abstracts where a bundle's files live. Local filesystem now;
// a GitHub Git Data API implementation later lets the hosted App operate
// without ever cloning a repo.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireFileLock } from "./file-lock";

export interface FileStore {
  /** Relative paths (posix separators) of every .md file under the root, sorted. */
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** Optional cheap change token. Must change on replacement and rapid rewrites. */
  version?(path: string): Promise<string>;
  /** Serialize a complete engine read/validate/write operation, across clients. */
  withMutation?<T>(operation: () => Promise<T>): Promise<T>;
}

export class LocalFileStore implements FileStore {
  constructor(readonly root: string) {}

  async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    // A failed write must not silently create a misconfigured bundle root.
    const root = await stat(this.root);
    if (!root.isDirectory())
      throw new Error(`bundle root is not a directory: ${this.root}`);
    const lock = await acquireFileLock(
      join(this.root, ".docket-mutation.lock"),
      {
        lockTimeoutMs: 10000,
        staleLockMs: 300000,
        retryDelayMs: 25,
      },
      "Docket mutation",
    );
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      const entries = await readdir(join(this.root, rel), {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(relPath);
        else if (entry.name.endsWith(".md")) out.push(relPath);
      }
    };
    await walk("");
    return out.sort();
  }

  read(path: string): Promise<string> {
    return readFile(join(this.root, path), "utf8");
  }

  async version(path: string): Promise<string> {
    const info = await stat(join(this.root, path), { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  }

  async write(path: string, content: string): Promise<void> {
    const abs = join(this.root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

/** Test double and future in-process cache seed. */
export class InMemoryFileStore implements FileStore {
  constructor(readonly files = new Map<string, string>()) {}

  async list(): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.endsWith(".md")).sort();
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`not found: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}
