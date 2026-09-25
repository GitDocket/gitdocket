// FileStore abstracts where a bundle's files live. Local filesystem now;
// a GitHub Git Data API implementation later lets the hosted App operate
// without ever cloning a repo.

import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireFileLock } from "./file-lock";

export interface FileStore {
  /** Relative paths (posix separators) of every .md file under the root, sorted. */
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  /** Explicit absence detection and removal for journaled source moves. */
  readOptional?(path: string): Promise<string | undefined>;
  remove?(path: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  /** Create without replacing an existing source; false means collision. */
  createExclusive?(path: string, content: string): Promise<boolean>;
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

  async readOptional(path: string): Promise<string | undefined> {
    try {
      return await this.read(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    await unlink(join(this.root, path));
  }

  async createExclusive(path: string, content: string): Promise<boolean> {
    const root = await realpath(this.root);
    let parent = root;
    // Do not follow directory links, including links within the bundle. The
    // caller validates the relative path; arbitrary external writers must still
    // cooperate with Docket's mutation lock during directory traversal.
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      await mkdir(parent).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(parent)).isDirectory())
        throw new Error("Document parent must be a real bundle directory.");
    }
    try {
      await writeFile(join(root, path), content, {
        encoding: "utf8",
        flag: "wx",
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
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

  async readOptional(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async createExclusive(path: string, content: string): Promise<boolean> {
    if (this.files.has(path)) return false;
    this.files.set(path, content);
    return true;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}
