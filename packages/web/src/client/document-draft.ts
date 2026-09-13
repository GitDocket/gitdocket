import type { DocumentPatch, EditableDocument } from "@gitdocket/core";
export interface EditorSource extends EditableDocument {
  sourceScope: string;
}
export interface DocumentDraft {
  base: EditorSource;
  fields: { title: string; description: string; body: string };
}
export const newDraft = (base: EditorSource): DocumentDraft => ({
  base,
  fields: {
    title: base.title ?? "",
    description: base.description ?? "",
    body: base.body,
  },
});
export function draftPatch(draft: DocumentDraft): DocumentPatch {
  const patch: DocumentPatch = {};
  for (const key of ["title", "description"] as const) {
    if (draft.fields[key] !== (draft.base[key] ?? ""))
      patch[key] = draft.fields[key] || null;
  }
  if (draft.fields.body !== draft.base.body) patch.body = draft.fields.body;
  return patch;
}
export const draftChanged = (draft: DocumentDraft) =>
  Object.keys(draftPatch(draft)).length > 0;
export const draftKey = (scope: string, path: string) =>
  `docket:document-draft:v1:${scope}:${path}`;
const memory = new Map<string, DocumentDraft>();
export function retainDraft(
  key: string,
  draft: DocumentDraft | null,
  storage: Pick<Storage, "setItem" | "removeItem">,
): boolean {
  if (draft) memory.set(key, draft);
  else memory.delete(key);
  try {
    if (draft) storage.setItem(key, JSON.stringify(draft));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
export function restoreDraft(
  key: string,
  scope: string,
  path: string,
  storage: Pick<Storage, "getItem">,
): DocumentDraft | undefined {
  const fallback = memory.get(key);
  try {
    const value = storage.getItem(key);
    const draft = fallback ?? (value ? JSON.parse(value) : undefined);
    if (
      draft?.base?.sourceScope !== scope ||
      draft?.base?.path !== path ||
      !/^[a-f0-9]{64}$/.test(draft?.base?.version) ||
      ![
        draft.fields?.title,
        draft.fields?.description,
        draft.fields?.body,
        draft.base.body,
      ].every((value) => typeof value === "string") ||
      ![draft.base.title, draft.base.description].every(
        (value) => value === null || typeof value === "string",
      )
    )
      return undefined;
    return draft;
  } catch {
    return fallback;
  }
}
let navigationGuard: (() => boolean) | undefined;
export function registerEditorNavigationGuard(
  guard: () => boolean,
): () => void {
  navigationGuard = guard;
  return () => {
    if (navigationGuard === guard) navigationGuard = undefined;
  };
}
export function allowEditorNavigation(): boolean {
  return navigationGuard?.() ?? true;
}
