#!/usr/bin/env bun

// docket-mcp — stdio entry point. Repo discovery mirrors the CLI: walk up
// from cwd to docket.yaml, root the FileStore at the bundle.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIG_FILENAME,
  findRepoRoot,
  LocalFileStore,
  parseConfig,
} from "@gitdocket/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDocketServer } from "./server";

const root = await findRepoRoot(process.cwd());
if (!root) {
  console.error(
    "docket-mcp: no docket.yaml found here or in any parent directory",
  );
  process.exit(1);
}

let store: LocalFileStore | undefined;
const resolve = async () => {
  const config = parseConfig(
    await readFile(join(root, CONFIG_FILENAME), "utf8"),
  );
  const path = join(root, config.bundle);
  if (store?.root !== path) store = new LocalFileStore(path);
  return { config, store };
};
const initial = await resolve();
const server = createDocketServer(initial.store, initial.config, root, resolve);
let closing: Promise<void> | undefined;
const close = () => {
  closing ??= server.close();
  void closing.catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
};
process.stdin.once("end", close);
process.once("SIGINT", close);
process.once("SIGTERM", close);
await server.connect(new StdioServerTransport());
