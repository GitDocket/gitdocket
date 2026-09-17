/** Real MCP transport and local canonical files; no simulated discovery response. */
import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  InMemoryFileStore,
  LocalFileStore,
  mutateExtension,
  parseConfig,
  readExtensions,
} from "@gitdocket/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDocketServer } from "./server";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const call = async (client: Client, name: string, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const text = (result.content as { text: string }[])[0]?.text;
  if (!text) throw new Error("MCP result omitted JSON text");
  return JSON.parse(text);
};
async function connect(server: ReturnType<typeof createDocketServer>) {
  const client = new Client({
    name: "extension-reader-test",
    version: "1.0.0",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "docket-mcp-extensions-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "knowledge");
  const source = join(root, "tiny");
  await mkdir(bundle);
  await mkdir(join(root, ".docket"));
  await writeFile(join(root, ".docket/active-task"), "DKT-99\n");
  await writeFile(join(bundle, "index.md"), "Handwritten index\n");
  await cp(
    resolve(import.meta.dir, "../../../examples/extensions/minimal"),
    source,
    { recursive: true },
  );
  const config = parseConfig("bundle: knowledge/\n");
  const store = new LocalFileStore(bundle);
  return { root, bundle, source, config, store };
}

test("live MCP discovery exposes canonical CLI/core ownership and source bytes without task reads or writes", async () => {
  const { root, bundle, source, config, store } = await fixture();
  store.list = async () => {
    throw new Error("Discovery must not scan unrelated documents");
  };
  const client = await connect(createDocketServer(store, config));
  expect((await call(client, "workflow_extensions")).packages).toEqual([]);
  expect(
    (await mutateExtension(bundle, { kind: "install", source, enable: true }))
      .ok,
  ).toBe(true);
  const first = await call(client, "workflow_extensions");
  const core = await readExtensions(bundle);
  expect(first.status).toBe("supported");
  expect(first.workflows).toEqual(core.workflows);
  expect(first.packages[0].effectiveConfig.reviewer).toEqual({
    value: "owner",
    owner: "default",
  });
  const path = first.workflows[0].path;
  expect(first.packages[0].sources["workflows/review.md"].text).toBeUndefined();
  store.list = LocalFileStore.prototype.list.bind(store);
  const page = await call(client, "source_page", { path });
  // CLI and MCP resolve the same nondefault bundle.
  await writeFile(join(root, "docket.yaml"), "bundle: knowledge/\n");
  const configuredCli = Bun.spawnSync(
    [
      "bun",
      resolve(import.meta.dir, "../../cli/src/index.ts"),
      "source",
      path,
      "--json",
    ],
    { cwd: root },
  );
  expect(configuredCli.exitCode).toBe(0);
  const cliPage = JSON.parse(configuredCli.stdout.toString());
  expect(page.text).toBe(await readFile(join(bundle, path), "utf8"));
  expect(page.text).toBe(cliPage.text);
  expect(page.sourceHash).toBe(cliPage.sourceHash);
  expect(page.sourceHash).toBe(
    core.packages[0]?.sources["workflows/review.md"]?.hash,
  );
  expect(
    (
      await mutateExtension(bundle, {
        kind: "configure",
        id: "tiny",
        set: { reviewer: "product-owner" },
      })
    ).ok,
  ).toBe(true);
  expect(
    (await call(client, "workflow_extensions", { id: "tiny" })).packages[0]
      .effectiveConfig.reviewer,
  ).toEqual({ value: "product-owner", owner: "project" });
  expect(
    (await call(client, "workflow_extensions", { id: "missing" }))
      .totalPackages,
  ).toBe(0);
  await mutateExtension(bundle, { kind: "disable", id: "tiny" });
  expect((await call(client, "workflow_extensions")).workflows).toEqual([]);
  expect((await call(client, "source_page", { path })).text).toBe(page.text);
  await mutateExtension(bundle, { kind: "enable", id: "tiny" });
  await rm(join(bundle, path));
  const missing = await call(client, "workflow_extensions");
  expect(missing.workflows).toEqual([]);
  expect(missing.packages[0].availability).toBe("invalid");
  expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
    "DKT-99\n",
  );
  expect(await readFile(join(bundle, "index.md"), "utf8")).toBe(
    "Handwritten index\n",
  );
});

test("discovery follows a changed repository resolver, and nonlocal stores report unsupported", async () => {
  const { bundle, source, config, store } = await fixture();
  await mutateExtension(bundle, { kind: "install", source, enable: true });
  let current = { store, config };
  const client = await connect(
    createDocketServer(store, config, undefined, async () => current),
  );
  expect((await call(client, "workflow_extensions")).workflows).toHaveLength(1);
  const other = await fixture();
  current = { store: other.store, config: other.config };
  expect((await call(client, "workflow_extensions")).packages).toEqual([]);
  const memory = await connect(
    createDocketServer(new InMemoryFileStore(), config),
  );
  expect((await call(memory, "workflow_extensions")).status).toBe(
    "unsupported",
  );
});

test("MCP pages diagnose selected packages independently and bound oversized configuration", async () => {
  const { root, bundle, source, config, store } = await fixture();
  await mutateExtension(bundle, { kind: "install", source, enable: true });
  const secondSource = join(root, "second-author");
  await cp(source, secondSource, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(secondSource, "extension.json"), "utf8"),
  );
  manifest.id = "zeta";
  await writeFile(
    join(secondSource, "extension.json"),
    JSON.stringify(manifest),
  );
  expect(
    (
      await mutateExtension(bundle, {
        kind: "install",
        source: secondSource,
        enable: true,
      })
    ).ok,
  ).toBe(true);
  await writeFile(
    join(bundle, "extensions/zeta/workflows/review.md"),
    "Unreviewed local text\n",
  );
  const client = await connect(createDocketServer(store, config));
  const first = await call(client, "workflow_extensions", { limit: 1 });
  expect(first.packages.map((entry: { id: string }) => entry.id)).toEqual([
    "tiny",
  ]);
  expect(first.ok).toBe(true);
  expect(first.inventoryOk).toBe(false);
  expect(first.unavailablePackagesInInventory).toBe(1);
  expect(first.nextOffset).toBe(1);
  expect((await call(client, "workflow_extensions", { id: "tiny" })).ok).toBe(
    true,
  );
  const second = await call(client, "workflow_extensions", {
    offset: first.nextOffset,
    limit: 1,
  });
  expect(second.packages[0].id).toBe("zeta");
  expect(second.ok).toBe(false);
  expect(second.packages[0].diagnostics.length).toBeGreaterThan(0);
  expect(second.nextOffset).toBeUndefined();
  await mutateExtension(bundle, {
    kind: "configure",
    id: "tiny",
    set: { reviewer: "Large project choice ".repeat(50_000) },
  });
  const large = await call(client, "workflow_extensions", {
    id: "tiny",
    limit: 1,
  });
  expect(Buffer.byteLength(JSON.stringify(large, null, 2))).toBeLessThan(
    24_000,
  );
  expect(large.outputLimited).toBe(true);
  expect(large.packages[0].remediation).toContain(
    "docket extension show tiny --json",
  );
  expect(large.workflows).toEqual([]);
});

test("local edits and interrupted transactions revoke live discovery while canonical text stays readable", async () => {
  const { bundle, source, config, store } = await fixture();
  await mutateExtension(bundle, { kind: "install", source, enable: true });
  const client = await connect(createDocketServer(store, config));
  const first = await call(client, "workflow_extensions");
  const path = first.workflows[0].path;
  const edited = `${await readFile(join(bundle, path), "utf8")}\nA local adaptation.\n`;
  await writeFile(join(bundle, path), edited);
  const next = await call(client, "workflow_extensions");
  expect(next.workflows).toEqual([]);
  expect(next.packages[0].availability).toBe("review-required");
  const page = await call(client, "source_page", { path });
  expect(page.text).toBe(edited);
  expect(page.sourceHash).toBe(
    next.packages[0].sources["workflows/review.md"].hash,
  );
  expect(page.sourceHash).not.toBe(
    first.packages[0].sources["workflows/review.md"].hash,
  );
  await writeFile(join(bundle, "extensions/.transaction.json"), "{}\n");
  const interrupted = await call(client, "workflow_extensions");
  expect(interrupted.pendingTransaction).toBe(true);
  expect(interrupted.workflows).toEqual([]);
  expect(interrupted.diagnostics.length).toBeGreaterThan(0);
});

test("multibyte global diagnostics fit the serialized response budget and disclose omitted detail", async () => {
  const { extensionPage } = await import("./extensions");
  const result = extensionPage(
    {
      status: "supported",
      ok: false,
      engineVersion: "0.4.0",
      registryHash: null,
      pendingTransaction: false,
      packages: [],
      workflows: [],
      diagnostics: Array.from({ length: 8 }, () => ({
        code: "invalid-source",
        severity: "error" as const,
        message: "界".repeat(1024),
        remediation: "Read the complete source.",
      })),
    },
    undefined,
    0,
    20,
  );
  expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThan(
    24_000,
  );
  expect(result.ok).toBe(false);
  expect(result.diagnosticsLimited).toBe(true);
  expect(result.diagnosticsRemediation).toContain(
    "docket extension list --json",
  );
});
