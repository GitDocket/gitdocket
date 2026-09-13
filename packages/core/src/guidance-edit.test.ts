import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "./config";
import { InMemoryFileStore, LocalFileStore } from "./filestore";
import { PROJECT_GUIDANCE_PATH, readProjectGuidance } from "./guidance";
import { editGuidance, readEditableGuidance } from "./guidance-edit";

const config = parseConfig();
test("optional guidance stays absent until shared save, validates patches, then rejects stale creation", async () => {
  const store = new InMemoryFileStore();
  const draft = await readEditableGuidance(store, config);
  expect(await store.list()).toEqual([]);
  await expect(
    editGuidance(store, config, {
      expectedVersion: draft.version,
      patch: { status: "done" },
    }),
  ).rejects.toThrow("Only body");
  expect(await store.list()).toEqual([]);
  const saved = await editGuidance(store, config, {
    expectedVersion: draft.version,
    patch: { body: "- Requirement: GraphQL. Scope: API changes.\n" },
  });
  expect(saved.changed).toBe(true);
  expect(saved.taskId).toBeNull();
  expect(saved.paths).toEqual([PROJECT_GUIDANCE_PATH]);
  expect(saved.document).toEqual(await readEditableGuidance(store, config));
  expect((await readProjectGuidance(store, config)).status).toBe("present");
  await expect(
    editGuidance(store, config, {
      expectedVersion: draft.version,
      patch: { body: "overwrite" },
    }),
  ).rejects.toThrow("created since");
});

test("retiring a link preserves its shared source and unrelated metadata", async () => {
  const procedure =
    "---\ntype: Playbook\ntitle: Deploy\n---\nRehearsal only.\n";
  const store = new InMemoryFileStore(
    new Map([
      ["playbooks/deploy.md", procedure],
      [
        PROJECT_GUIDANCE_PATH,
        "---\ntype: Reference\ntitle: Guidance\ncustom: keep\n---\n[Deploy](/playbooks/deploy.md)\n",
      ],
    ]),
  );
  const draft = await readEditableGuidance(store, config);
  await editGuidance(store, config, {
    expectedVersion: draft.version,
    patch: { body: "<!-- Retired guidance entry: no longer used. -->\n" },
  });
  expect((await readProjectGuidance(store, config)).links).toEqual([]);
  expect(await store.read("playbooks/deploy.md")).toBe(procedure);
  expect(await store.read(PROJECT_GUIDANCE_PATH)).toContain("custom: keep");
});

test("local creation is exclusive and refuses a symlinked reference directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "guidance-create-"));
  try {
    await mkdir(join(root, "bundle"));
    await mkdir(join(root, "outside"));
    const store = new LocalFileStore(join(root, "bundle"));
    const draft = await readEditableGuidance(store, config);
    const request = {
      expectedVersion: draft.version,
      patch: { body: "First source" },
    };
    await symlink(join(root, "outside"), join(root, "bundle/reference"));
    await expect(editGuidance(store, config, request)).rejects.toThrow(
      "without a symlink",
    );
    await expect(
      readFile(join(root, "outside/project-guidance.md")),
    ).rejects.toThrow();
    await rm(join(root, "bundle/reference"));
    const results = await Promise.allSettled([
      editGuidance(store, config, request),
      editGuidance(store, config, request),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await readEditableGuidance(store, config)).body).toBe(
      "First source",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
