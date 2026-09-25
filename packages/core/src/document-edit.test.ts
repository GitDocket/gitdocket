import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config";
import {
  createDocument,
  DOCUMENT_EDIT_MAX_BYTES,
  editDocument,
  readEditableDocument,
} from "./document-edit";
import { InMemoryFileStore, LocalFileStore } from "./filestore";
import { setPriority, setStatus } from "./ops";

const config = parseConfig();
const path = "reference/source.md";
const source = `---
type: Reference
title: 'Original' # title comment
description: > # description comment
  A long
  description
# keep this comment
origin: docket-guidance@0.2.1
timestamp: 2026-01-01T00:00:00Z
custom:
  unknown: [one, two] # exact
---

# Body

雪 👩🏽‍💻
`;
const seed = (text = source) => new InMemoryFileStore(new Map([[path, text]]));
async function save(store: InMemoryFileStore, patch: unknown) {
  const draft = await readEditableDocument(store, config, path);
  return editDocument(store, config, path, {
    expectedVersion: draft.version,
    patch,
  });
}
describe("versioned authored source editing", () => {
  test("body-only preserves frontmatter bytes; combined properties preserve comments and unknown fields", async () => {
    const store = seed();
    await save(store, { body: "\n# Updated\n" });
    expect(await store.read(path)).toBe(
      `${source.slice(0, source.indexOf("\n# Body"))}\n# Updated\n`,
    );
    const result = await save(store, {
      title: "Unicode 雪",
      description: "New description",
    });
    const updated = await store.read(path);
    expect(updated).toContain('title: "Unicode 雪" # title comment');
    expect(updated).toContain(
      'description: "New description" # description comment\n# keep this comment',
    );
    expect(updated).toContain("custom:\n  unknown: [one, two] # exact");
    expect(updated).toContain("timestamp: 2026-01-01T00:00:00Z");
    expect(result.paths).toEqual([path]);
    expect(result.taskId).toBeNull();
    expect(result.document.description).toBe("New description");
  });
  test("optional fields can be added or removed and no-ops do not write", async () => {
    const store = seed("---\ntype: Custom\n---\nbody");
    await save(store, { title: "Added", description: "" });
    expect((await readEditableDocument(store, config, path)).description).toBe(
      "",
    );
    await save(store, { title: null, description: null });
    const draft = await readEditableDocument(store, config, path);
    expect(draft.title).toBeNull();
    expect(draft.description).toBeNull();
    const result = await save(store, { title: null });
    expect(result.changed).toBe(false);
    expect(result.paths).toEqual([]);
  });
  test("CRLF and body content resembling frontmatter stay intact", async () => {
    const store = seed(source.replaceAll("\n", "\r\n"));
    await save(store, {
      title: 'A "quoted" title',
      body: "---\nstatus: done\n---\n",
    });
    expect(await store.read(path)).toContain(
      'title: "A \\"quoted\\" title"'.replaceAll("\\\\", "\\"),
    );
    expect(await store.read(path)).toContain(
      "custom:\r\n  unknown: [one, two] # exact\r\n",
    );
    expect((await readEditableDocument(store, config, path)).body).toBe(
      "---\nstatus: done\n---\n",
    );
  });
  test("stale versions and changes immediately before write never replace source", async () => {
    const store = seed();
    const draft = await readEditableDocument(store, config, path);
    await store.write(path, `${source}agent edit`);
    await expect(
      editDocument(store, config, path, {
        expectedVersion: draft.version,
        patch: { body: "browser" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await store.read(path)).toBe(`${source}agent edit`);
    const next = await readEditableDocument(store, config, path);
    const read = store.read.bind(store);
    let reads = 0;
    store.read = async (p) => (++reads === 2 ? `${source}new race` : read(p));
    await expect(
      editDocument(store, config, path, {
        expectedVersion: next.version,
        patch: { body: "browser" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await read(path)).toBe(`${source}agent edit`);
  });
  test("simultaneous engine edits serialize and lifecycle stays separate", async () => {
    const store = seed(
      "---\ntype: Task\nid: DKT-1\nstatus: todo\norigin: custom@1\ntimestamp: old\n---\n- [ ] Do it\n",
    );
    const draft = await readEditableDocument(store, config, path);
    const results = await Promise.allSettled(
      [1, 2].map((n) =>
        editDocument(store, config, path, {
          expectedVersion: draft.version,
          patch: { body: `- [x] ${n}` },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.read(path)).toContain(
      "status: todo\norigin: custom@1\ntimestamp: old",
    );
    await setPriority(store, config, "DKT-1", "p1");
    await setStatus(store, config, "DKT-1", "in-progress");
    expect(await store.read(path)).toContain("status: in-progress");
  });
  test("rejects generic identity/lifecycle properties and malformed requests without changes", async () => {
    for (const patch of [
      { status: "done" },
      { type: "Task" },
      { origin: "x" },
      { filename: "elsewhere" },
      { body: null },
      { title: "  " },
      { description: "x".repeat(4097) },
      { body: "\0" },
      [],
      null,
    ]) {
      const store = seed();
      await expect(save(store, patch)).rejects.toMatchObject({
        code: "invalid",
      });
      expect(await store.read(path)).toBe(source);
    }
    const store = seed();
    await expect(
      editDocument(store, config, path, {
        expectedVersion: "excerpt",
        patch: { body: "partial" },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await store.read(path)).toBe(source);
  });
  test("complete Unicode sources exceed reader pages but obey byte limits", async () => {
    const store = seed();
    const body = "雪".repeat(20_000);
    await save(store, { body });
    expect((await readEditableDocument(store, config, path)).body).toBe(body);
    const before = await store.read(path);
    await expect(
      save(store, { body: "雪".repeat(DOCUMENT_EDIT_MAX_BYTES) }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(await store.read(path)).toBe(before);
    store.files.set(path, before.repeat(10));
    await expect(
      readEditableDocument(store, config, path),
    ).rejects.toMatchObject({ code: "too_large" });
  });
  test("malformed and reserved sources have explicit errors and remain untouched", async () => {
    for (const text of [
      "no frontmatter",
      "---\ntype: Reference\ntitle: [bad\n---\nbody",
      "---\ntype: Reference\ntitle: a\ntitle: b\n---\n",
      "---\n{type: Reference}\n---\n",
    ]) {
      const store = seed(text);
      await expect(
        readEditableDocument(store, config, path),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(await store.read(path)).toBe(text);
    }
    for (const p of ["index.md", "nested/index.md", "overview.md", "log.md"]) {
      await expect(
        readEditableDocument(seed(), config, p),
      ).rejects.toMatchObject({ code: "unsupported" });
    }
    for (const p of [
      "../x.md",
      "/source.md",
      "a/../x.md",
      "a\\x.md",
      ".secret.md",
    ]) {
      await expect(
        readEditableDocument(seed(), config, p),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(
      readEditableDocument(seed(), config, "absent.md"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  test("anchored editable values cannot indirectly change unknown metadata", async () => {
    const store = seed(
      "---\ntype: Reference\ntitle: &name Original\ncustom: *name\n---\nbody",
    );
    const before = await store.read(path);
    await expect(save(store, { title: "New" })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(await store.read(path)).toBe(before);
    await save(store, { body: "Changed body" });
    expect(await store.read(path)).toContain(
      "title: &name Original\ncustom: *name",
    );
  });
  test("local stores reject symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "document-edit-"));
    try {
      await mkdir(join(root, "bundle"));
      await writeFile(join(root, "outside.md"), source);
      await symlink(
        join(root, "outside.md"),
        join(root, "bundle", "escape.md"),
      );
      await expect(
        readEditableDocument(
          new LocalFileStore(join(root, "bundle")),
          config,
          "escape.md",
        ),
      ).rejects.toMatchObject({ code: "invalid" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ordinary wiki creation", () => {
  const input = {
    path: "reference/cache.md",
    type: "Reference",
    title: "Cache",
    body: "# Cache\n\nA complete paragraph.\n",
  };
  test("creates all ordinary types, preserves collisions and versions subsequent edits", async () => {
    const store = new InMemoryFileStore();
    for (const type of ["Reference", "Spec", "Playbook"]) {
      const args = { ...input, type, path: `${type.toLowerCase()}/cache.md` };
      const created = await createDocument(store, config, args);
      expect(created.document.body).toBe(input.body);
      expect(created.taskId).toBeNull();
      const original = await store.read(args.path);
      await expect(createDocument(store, config, args)).rejects.toThrow(
        "already exists",
      );
      expect(await store.read(args.path)).toBe(original);
      await editDocument(store, config, args.path, {
        expectedVersion: created.document.version,
        patch: { body: "Changed\n" },
      });
      await expect(
        editDocument(store, config, args.path, {
          expectedVersion: created.document.version,
          patch: { body: "Stale\n" },
        }),
      ).rejects.toThrow("changed");
    }
  });
  test("rejects unauthorized paths, fields and oversized content before writes", async () => {
    const store = new InMemoryFileStore();
    for (const path of [
      "../escape.md",
      "/escape.md",
      "reference/INDEX.md",
      "reference/hidden.MD",
      "Reference/Project-Guidance.md",
      "work/a.md",
      "decisions/a.md",
      "workflows/a.md",
      "extensions/a.md",
      ".agents/a.md",
    ]) {
      await expect(
        createDocument(store, config, { ...input, path }),
      ).rejects.toThrow();
    }
    for (const change of [
      { status: "todo" },
      { type: "Task" },
      { title: " " },
      { tags: [null] },
      { body: "x".repeat(DOCUMENT_EDIT_MAX_BYTES) },
    ])
      await expect(
        createDocument(store, config, { ...input, ...change }),
      ).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });
  test("exclusive local creation refuses concurrent collisions and linked parents", async () => {
    const root = await mkdtemp(join(tmpdir(), "docket-wiki-"));
    try {
      await mkdir(join(root, "bundle"));
      await mkdir(join(root, "outside"));
      await symlink(join(root, "outside"), join(root, "bundle/linked"));
      const store = new LocalFileStore(join(root, "bundle"));
      await expect(
        createDocument(store, config, { ...input, path: "linked/a.md" }),
      ).rejects.toThrow();
      const results = await Promise.allSettled([
        createDocument(store, config, input),
        createDocument(new LocalFileStore(store.root), config, input),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
