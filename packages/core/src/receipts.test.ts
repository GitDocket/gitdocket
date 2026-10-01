import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig } from "./config";
import {
  createDocument,
  editDocument,
  readEditableDocument,
} from "./document-edit";
import { InMemoryFileStore } from "./filestore";
import { createDecision, createWorkItem } from "./ops";
import {
  compactWriteReceipt,
  errorReceipt,
  RECEIPT_MAX_BYTES,
} from "./receipts";

const config = parseConfig();
const body = `# Context\n\n${"Private authored paragraph. ".repeat(450)}\n`;

test("compact creation and save versions support continuation without another source read", async () => {
  const store = new InMemoryFileStore();
  for (const create of [createWorkItem, createDecision]) {
    const made = await create(store, config, { title: "Versioned source" });
    const receipt = compactWriteReceipt("task_create", made);
    const saved = await editDocument(store, config, made.path, {
      expectedVersion: receipt.version,
      patch: { body },
    });
    const compact = compactWriteReceipt("document_edit", saved);
    expect(compact).toMatchObject({
      discovery: {
        index: "pending-batch-assessment",
        bundleLog: "not-written",
        parentEpic: "not-written",
      },
    });
    expect(JSON.stringify(compact)).not.toContain("Private authored");
    expect(Buffer.byteLength(JSON.stringify(compact, null, 2))).toBeLessThan(
      1000,
    );
    expect(compact.version).toBe(
      (await readEditableDocument(store, config, made.path)).version,
    );
    const noop = await editDocument(store, config, made.path, {
      expectedVersion: compact.version,
      patch: { body },
    });
    expect(compactWriteReceipt("document_edit", noop)).toMatchObject({
      changed: false,
      mutation: "unchanged",
      paths: [],
      discovery: { index: "not-required-by-this-operation" },
    });
  }
});

test("interrupted authored saves report observed disposition rather than promise rollback", async () => {
  for (const mode of ["before", "after", "partial", "unreadable"] as const) {
    const store = new InMemoryFileStore();
    const made = await createDocument(store, config, {
      path: "reference/a.md",
      type: "Reference",
      title: "Source",
      body: "Original",
    });
    let attempted = false;
    const read = store.read.bind(store);
    store.write = async (path, content) => {
      attempted = true;
      if (mode === "after") store.files.set(path, content);
      if (mode === "partial") store.files.set(path, content.slice(0, 20));
      throw new Error("interrupted write");
    };
    store.read = async (path) => {
      if (attempted && mode === "unreadable") throw new Error("unreadable");
      return read(path);
    };
    const failed = await editDocument(store, config, made.document.path, {
      expectedVersion: made.document.version,
      patch: { body },
    }).catch((error) => error);
    expect(errorReceipt("document_edit", failed)).toMatchObject({
      ok: false,
      error: { code: "write-failed" },
      mutation:
        mode === "before"
          ? "unchanged"
          : mode === "after"
            ? "applied"
            : "unknown",
    });
  }
});

test("oversized receipt metadata is explicit and does not invent a source identity or repeat-write recovery", () => {
  const receipt = compactWriteReceipt("document_create", {
    document: { path: "x".repeat(20000), version: "a".repeat(64) },
    changed: true,
  });
  expect(receipt).toMatchObject({
    ok: true,
    mutation: "applied",
    error: { code: "receipt-details-required" },
    detail: { operation: "document_read", useOriginalRequestTarget: true },
  });
  expect(receipt).not.toHaveProperty("path");
  expect(Buffer.byteLength(JSON.stringify(receipt, null, 2))).toBeLessThan(
    RECEIPT_MAX_BYTES,
  );
  expect(
    Buffer.byteLength(
      JSON.stringify(
        errorReceipt("x".repeat(20000), new Error("雪".repeat(20000))),
        null,
        2,
      ),
    ),
  ).toBeLessThan(RECEIPT_MAX_BYTES);
});

test("real CLI JSON errors, compact writes and structured mechanics survive pipes without extra reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-receipts-"));
  try {
    await mkdir(join(root, "docket"));
    await writeFile(
      join(root, "docket.yaml"),
      "project: DKT\nbundle: docket\n",
    );
    const call = async (...args: string[]) => {
      const p = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../cli/src/index.ts"),
          ...args,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      expect(stderr).toBe("");
      return {
        code,
        data: JSON.parse(stdout),
        bytes: Buffer.byteLength(stdout),
      };
    };
    for (const args of [
      ["task", "start", "DKT-999", "--json"],
      ["task", "move", "DKT-999", "done", "--json"],
      ["document", "read", "missing.md", "--json"],
      ["task", "create", "--json"],
      ["task", "create", "--unknown", "--json"],
    ]) {
      expect(await call(...args)).toMatchObject({
        code: 1,
        data: {
          schema: "docket-receipt/v1",
          ok: false,
          operation: expect.any(String),
          error: { code: expect.any(String) },
        },
      });
    }
    const created = await call(
      "task",
      "create",
      "--title",
      "Compact continuation",
      "--compact",
    );
    expect(created).toMatchObject({
      code: 0,
      data: {
        operation: "task_create",
        changed: true,
        mutation: "applied",
      },
    });
    expect(created.data.version).toMatch(/^[a-f0-9]{64}$/);
    const input = join(root, "request.json");
    await writeFile(
      input,
      JSON.stringify({
        expectedVersion: created.data.version,
        patch: { body },
      }),
    );
    const saved = await call(
      "document",
      "edit",
      created.data.path,
      "--input",
      input,
      "--compact",
    );
    if (saved.code !== 0) throw new Error(JSON.stringify(saved.data));
    expect(saved.bytes).toBeLessThan(1500);
    expect(
      await readFile(join(root, "docket", created.data.path), "utf8"),
    ).toContain(body);
    await writeFile(
      input,
      JSON.stringify({ expectedVersion: saved.data.version, patch: { body } }),
    );
    expect(
      await call(
        "document",
        "edit",
        created.data.path,
        "--input",
        input,
        "--compact",
      ),
    ).toMatchObject({
      code: 0,
      data: {
        changed: false,
        mutation: "unchanged",
        version: saved.data.version,
      },
    });
    await writeFile(
      input,
      JSON.stringify({
        expectedVersion: created.data.version,
        patch: { body: "stale" },
      }),
    );
    expect(
      await call(
        "document",
        "edit",
        created.data.path,
        "--input",
        input,
        "--compact",
      ),
    ).toMatchObject({
      code: 1,
      data: { mutation: "unchanged", error: { code: "conflict" } },
    });
    expect(await call("index", "--json")).toMatchObject({
      code: 0,
      data: { operation: "index", cache: "rebuilt" },
    });
    expect(await call("index", "--check", "--json")).toMatchObject({
      code: 0,
      data: { stale: false, mutation: "unchanged" },
    });
    expect(await call("task", "stop", "--json")).toMatchObject({
      code: 0,
      data: { changed: false, statusChanged: false },
    });
    await call("task", "start", created.data.id, "--json");
    const other = await call("task", "create", "--title", "Other", "--compact");
    const conflict = await call("task", "start", other.data.id, "--json");
    expect(conflict).toMatchObject({
      code: 1,
      data: {
        error: {
          code: "active-task-conflict",
          activeTaskId: created.data.id,
          requestedTaskId: other.data.id,
        },
      },
    });
    expect(conflict.data.error.handoff).toBeDefined();
    expect(conflict.data.error.isolation).toBeDefined();
    expect(
      await call("task", "close", created.data.id, "--compact"),
    ).toMatchObject({
      code: 0,
      data: {
        operation: "task_close",
        to: "done",
        remaining: expect.arrayContaining([
          "run the returned matching cleanup after commit",
        ]),
      },
    });
    expect(await call("task", "stop", "--json")).toMatchObject({
      code: 0,
      data: {
        changed: true,
        activeTaskId: created.data.id,
        statusChanged: false,
      },
    });
    await writeFile(join(root, "docket.yaml"), "project: [\n");
    expect(await call("task", "list", "--json")).toMatchObject({
      code: 1,
      data: { schema: "docket-receipt/v1", ok: false },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
