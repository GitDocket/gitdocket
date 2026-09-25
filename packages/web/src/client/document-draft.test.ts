import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  allowEditorNavigation,
  draftChanged,
  draftKey,
  draftPatch,
  type EditorSource,
  newDraft,
  openCreationDraft,
  registerEditorNavigationGuard,
  restoreDraft,
  retainDraft,
  wikiPagePath,
} from "./document-draft";
import { DocumentEditor } from "./document-editor";

const base: EditorSource = {
  path: "specs/a.md",
  version: "a".repeat(64),
  sourceScope: "project-one",
  title: null,
  description: "Original",
  body: "\r\nComplete 雪\r\n",
  maxBytes: 262144,
};
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
};
test("patches preserve optional field presence and untouched CRLF bodies", () => {
  const draft = newDraft(base);
  expect(draftChanged(draft)).toBe(false);
  expect(draftPatch(draft)).toEqual({});
  draft.fields.description = "";
  draft.fields.title = "Added";
  expect(draftPatch(draft)).toEqual({ title: "Added", description: null });
});
test("draft survives navigation with its original version and is scoped to source identity", () => {
  const store = storage();
  const key = draftKey(base.sourceScope, base.path);
  const draft = newDraft(base);
  draft.fields.body = "Unsaved replacement";
  expect(retainDraft(key, draft, store)).toBe(true);
  expect(restoreDraft(key, base.sourceScope, base.path, store)).toEqual(draft);
  expect(
    restoreDraft(key, "different-project", base.path, store),
  ).toBeUndefined();
  expect(retainDraft(key, null, store)).toBe(true);
  expect(restoreDraft(key, base.sourceScope, base.path, store)).toBeUndefined();
});
test("storage failure retains in-memory recovery and navigation guard can refuse leaving", () => {
  const key = draftKey("failed", base.path);
  const draft = newDraft({ ...base, sourceScope: "failed" });
  draft.fields.body = "Recovery";
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  expect(retainDraft(key, draft, broken)).toBe(false);
  expect(restoreDraft(key, "failed", base.path, broken)).toEqual(draft);
  const clear = registerEditorNavigationGuard(() => false);
  expect(allowEditorNavigation()).toBe(false);
  clear();
  expect(allowEditorNavigation()).toBe(true);
});
test("invalid stored drafts are ignored; read mode exposes a quiet explicit action", () => {
  const store = storage();
  store.setItem("broken", JSON.stringify({ fields: { body: 32 }, base }));
  expect(
    restoreDraft("broken", base.sourceScope, base.path, store),
  ).toBeUndefined();
  const html = renderToStaticMarkup(
    createElement(DocumentEditor, {
      path: base.path,
      sourceScope: base.sourceScope,
      onSaved: () => {},
    }),
  );
  expect(html).toContain(">Edit</button>");
  expect(html).not.toContain("<textarea");
});

test("creation drafts retain destination, type and complete content through recovery and cancellation", () => {
  const baseCreate = {
    ...base,
    path: "@new-page",
    title: null,
    description: null,
    body: "",
    version: "0".repeat(64),
  };
  const draft = {
    ...newDraft(baseCreate),
    creation: { type: "Reference" as const, path: "", autoPath: true },
  };
  expect(draftChanged(draft)).toBe(false);
  const next = {
    ...draft,
    creation: {
      type: "Playbook" as const,
      path: "playbooks/a-long-manual-location.md",
      autoPath: false,
    },
  };
  next.fields.body = "Complete recovery content\n";
  const store = storage();
  const key = draftKey(baseCreate.sourceScope, baseCreate.path);
  expect(draftChanged(next)).toBe(true);
  expect(retainDraft(key, next, store)).toBe(true);
  expect(
    restoreDraft(key, baseCreate.sourceScope, baseCreate.path, store),
  ).toEqual(next);
  expect(
    restoreDraft(key, "another-project", baseCreate.path, store),
  ).toBeUndefined();
  retainDraft(key, null, store);
  expect(
    restoreDraft(key, baseCreate.sourceScope, baseCreate.path, store),
  ).toBeUndefined();
  const reentered = openCreationDraft(baseCreate, store);
  expect(reentered.recovered).toBe(false);
  expect(reentered.draft.fields).toEqual({
    title: "",
    description: "",
    body: "",
  });
  expect(reentered.draft.creation).toEqual({
    type: "Reference",
    path: "",
    autoPath: true,
  });
  expect(draftChanged(reentered.draft)).toBe(false);
  store.setItem(
    key,
    JSON.stringify({
      ...next,
      creation: { type: "Task", path: "work/a.md", autoPath: false },
    }),
  );
  expect(
    restoreDraft(key, baseCreate.sourceScope, baseCreate.path, store),
  ).toBeUndefined();
  expect(wikiPagePath("Spec", "Cache / API Requirements!")).toBe(
    "specs/cache-api-requirements.md",
  );
  expect(wikiPagePath("Playbook", "")).toBe("");
});
