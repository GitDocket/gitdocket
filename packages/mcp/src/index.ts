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
} from "@docket/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDocketServer } from "./server";

const root = await findRepoRoot(process.cwd());
if (!root) {
  console.error(
    "docket-mcp: no docket.yaml found here or in any parent directory",
  );
  process.exit(1);
}

const config = parseConfig(await readFile(join(root, CONFIG_FILENAME), "utf8"));
const store = new LocalFileStore(join(root, config.bundle));
await createDocketServer(store, config, root).connect(
  new StdioServerTransport(),
);
