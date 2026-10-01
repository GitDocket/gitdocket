import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalFileStore,
  lintBundle,
  loadBundle,
  makeLintReport,
  parseConfig,
  writeLintReport,
} from "@gitdocket/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDocketServer } from "./server";

test("MCP summary is read-only, bounded, baseline-aware and preserves the full array route", async () => {
  const temp = await mkdtemp(join(tmpdir(), "docket-mcp-lint-"));
  const root = await realpath(temp);
  const config = parseConfig("project: FIX\nbundle: docket\n");
  const store = new LocalFileStore(join(root, "docket"));
  const reference = (body: string) =>
    `---\ntype: Reference\ntitle: Fixture\n---\n\n${body}\n`;
  const client = new Client({ name: "fixture", version: "0.0.0" });
  const server = createDocketServer(store, config, root);
  try {
    await mkdir(join(root, "docket/reference"), { recursive: true });
    await writeFile(
      join(root, "docket.yaml"),
      "project: FIX\nbundle: docket\n",
    );
    const sources = new Map([
      [
        "reference/legacy.md",
        reference(
          Array.from({ length: 50 }, (_, i) => `Legacy ${i}\nwrap.`).join(
            "\n\n",
          ),
        ),
      ],
    ]);
    await store.write(
      "reference/legacy.md",
      sources.get("reference/legacy.md") as string,
    );
    const now = new Date();
    const old = makeLintReport(
      await lintBundle(store, await loadBundle(store, config), { now }),
      sources,
      config,
      { now },
      root,
      now,
    );
    await writeLintReport(join(root, ".docket/lint-before.json"), old);
    await store.write("reference/new.md", reference("New\nwrap."));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "lint", arguments: args });
      expect(result.isError).not.toBe(true);
      const text = (result.content as { text: string }[])
        .map((c) => c.text)
        .join("");
      return { data: JSON.parse(text), bytes: Buffer.byteLength(text) };
    };
    const full = await call({});
    expect(Array.isArray(full.data)).toBe(true);
    expect(full.data).toHaveLength(51);
    const summary = await call({
      view: "summary",
      changed_paths: ["reference/new.md"],
      baseline_path: ".docket/lint-before.json",
    });
    expect(summary.data.delta).toMatchObject({
      introduced: 1,
      preExisting: 50,
      resolved: 0,
    });
    expect(summary.data.diagnostics[0].path).toBe("reference/new.md");
    expect(summary.bytes).toBeLessThanOrEqual(8192);
    const unknown = await call({
      view: "summary",
      baseline_path: "../outside.json",
    });
    expect(unknown.data.baseline.status).toBe("unavailable");
    expect(unknown.data.delta.introduced).toBeNull();
    expect((await store.list()).sort()).toEqual([
      "reference/legacy.md",
      "reference/new.md",
    ]);
    expect(summary.data).not.toHaveProperty("artifact");
    const tools = await client.listTools();
    expect(
      tools.tools.find((t) => t.name === "lint")?.annotations?.readOnlyHint,
    ).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
