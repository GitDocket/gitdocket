// FileStore abstracts where a bundle's files live. Local filesystem now;
// a GitHub Git Data API implementation later lets the hosted App operate
// without ever cloning a repo.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FileStore {
  /** Relative paths (posix separators) of every .md file under the root, sorted. */
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export class LocalFileStore implements FileStore {
  constructor(readonly root: string) {}

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
