import type { DocumentPatch, EditableDocument } from "@gitdocket/core";
export interface EditorSource extends EditableDocument {
  sourceScope: string;
}
export type WikiPageType = "Reference" | "Spec" | "Playbook";
export const wikiPagePath = (type: WikiPageType, title: string) => {
  const directory = {
    Reference: "reference",
    Spec: "specs",
    Playbook: "playbooks",
  }[type];
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  return slug ? `${directory}/${slug}.md` : "";
};
export interface DocumentDraft {
  creation?: { type: WikiPageType; path: string; autoPath: boolean };
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
  Object.keys(draftPatch(draft)).length > 0 ||
  !!(
    draft.creation &&
    (draft.creation.path || draft.creation.type !== "Reference")
  );
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
      (draft?.creation !== undefined &&
        (!draft.creation ||
          !["Reference", "Spec", "Playbook"].includes(draft.creation.type) ||
          typeof draft.creation.path !== "string" ||
          typeof draft.creation.autoPath !== "boolean")) ||
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

/** Re-entering creation recovers only this project's creation draft. */
export function openCreationDraft(
  base: EditorSource,
  storage: Pick<Storage, "getItem">,
) {
  const restored = restoreDraft(
    draftKey(base.sourceScope, base.path),
    base.sourceScope,
    base.path,
    storage,
  );
  return {
    recovered: !!restored?.creation,
    draft: restored?.creation
      ? restored
      : {
          ...newDraft(base),
          creation: { type: "Reference" as const, path: "", autoPath: true },
        },
  };
}

export class EditorRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
export async function requestDocument<T>(
  url: string,
  body?: unknown,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<T> {
  const response = await transport(
    url,
    body === undefined
      ? {
          cache: "no-store",
          headers: { "X-Docket-Trigger": "explicit" },
        }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Docket-Trigger": "explicit",
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new EditorRequestError(
      result.error ?? "Request failed. Your draft is still here.",
      result.code,
    );
  return result as T;
}
