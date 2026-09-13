import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type DocumentDraft,
  draftChanged,
  draftKey,
  draftPatch,
  type EditorSource,
  newDraft,
  registerEditorNavigationGuard,
  restoreDraft,
  retainDraft,
} from "./document-draft";

const sourceUrl = (path: string) =>
  `/api/edit-source/${path.split("/").map(encodeURIComponent).join("/")}`;
class EditorRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
const storage = {
  getItem: (key: string) => sessionStorage.getItem(key),
  setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
  removeItem: (key: string) => sessionStorage.removeItem(key),
};

/** Reusable on any authored source detail, including the guidance view. */
export function DocumentEditor({
  path,
  sourceScope,
  onSaved,
  actionContainer,
  onEditingChange,
  editLabel = "Edit",
  draftTools,
}: {
  path: string;
  sourceScope: string;
  onSaved: () => void;
  actionContainer?: HTMLElement | null;
  onEditingChange?: (editing: boolean) => void;
  editLabel?: string;
  draftTools?: (body: string, changeBody: (body: string) => void) => ReactNode;
}) {
  const key = draftKey(sourceScope, path);
  const [draft, setDraft] = useState<DocumentDraft>();
  const [recoverable, setRecoverable] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const current = useRef<DocumentDraft | undefined>(undefined);
  const stored = useRef(true);
  const mounted = useRef(true);
  const [storageFailed, setStorageFailed] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<EditorSource>();
  const [preview, setPreview] = useState<string>();
  const editButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const focusOnOpen = useRef(false);
  const id = useId();

  useEffect(() => {
    mounted.current = true;
    setRecoverable(!!restoreDraft(key, sourceScope, path, storage));
    return () => {
      mounted.current = false;
    };
  }, [key, sourceScope, path]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (
        busyRef.current ||
        (current.current && draftChanged(current.current))
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    const unregister = registerEditorNavigationGuard(() => {
      if (busyRef.current) {
        setError("Wait for the current request before leaving this page.");
        return false;
      }
      return (
        !current.current ||
        !draftChanged(current.current) ||
        stored.current ||
        window.confirm(
          "This draft could not be stored for reload. Copy it before leaving. Leave this page?",
        )
      );
    });
    return () => {
      window.removeEventListener("beforeunload", unload);
      unregister();
    };
  }, []);
  const editing = !!draft;
  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);
  useEffect(() => {
    if (editing && !busy && focusOnOpen.current) {
      titleInput.current?.focus();
      focusOnOpen.current = false;
    }
  }, [editing, busy]);

  const persist = (next: DocumentDraft | undefined) => {
    current.current = next;
    setDraft(next);
    stored.current = retainDraft(
      key,
      next && draftChanged(next) ? next : null,
      storage,
    );
    setStorageFailed(!stored.current);
  };
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (error) {
      if (!mounted.current) return;
      setError(error instanceof Error ? error.message : String(error));
      if (error instanceof EditorRequestError && error.code === "conflict")
        setConflict(true);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const open = () =>
    run(async () => {
      setNotice(undefined);
      focusOnOpen.current = true;
      const restored = restoreDraft(key, sourceScope, path, storage);
      if (restored) {
        persist(restored);
        setNotice("Recovered your draft. It has not been saved to source.");
      }
      const source = await request<EditorSource>(sourceUrl(path));
      if (!mounted.current) return;
      if (source.sourceScope !== sourceScope)
        throw new Error(
          "Project source changed. Refresh this page before editing.",
        );
      if (!restored) persist(newDraft(source));
      else if (restored.base.version !== source.version) {
        setConflict(true);
        setError(
          "Source changed since this draft began. Review the latest source before retrying.",
        );
      }
    });
  const change = (field: keyof DocumentDraft["fields"], value: string) => {
    if (!current.current || busyRef.current) return;
    persist({
      ...current.current,
      fields: { ...current.current.fields, [field]: value },
    });
    setPreview(undefined);
  };
  const cancel = () => {
    if (
      busyRef.current ||
      (current.current &&
        draftChanged(current.current) &&
        !window.confirm("Discard this unsaved draft?"))
    )
      return;
    persist(undefined);
    setRecoverable(false);
    setPreview(undefined);
    setLatest(undefined);
    setConflict(false);
    setError(undefined);
    setNotice("Draft discarded. Source was not changed.");
    requestAnimationFrame(() => editButton.current?.focus());
  };
  const save = () =>
    run(async () => {
      const pending = current.current;
      if (!pending) return;
      const result = await request<{
        document: EditorSource;
        saveState: string;
        commitError?: string;
      }>(sourceUrl(path), {
        sourceScope: pending.base.sourceScope,
        expectedVersion: pending.base.version,
        patch: draftPatch(pending),
      });
      if (!mounted.current) return;
      persist(undefined);
      setRecoverable(false);
      setPreview(undefined);
      setConflict(false);
      setLatest(undefined);
      setNotice(
        result.saveState === "committed"
          ? "Saved and committed."
          : result.saveState === "commit_failed"
            ? `Saved locally; commit failed. Your source is saved. Check Git before committing manually. ${result.commitError ?? ""}`
            : result.saveState === "unchanged"
              ? "Source is unchanged. No commit was created."
              : "Saved locally. Changes are not committed.",
      );
      onSaved();
      requestAnimationFrame(() => editButton.current?.focus());
    });
  const showPreview = () =>
    run(async () => {
      if (!current.current) return;
      const result = await request<{ html: string }>(
        sourceUrl(path).replace("/edit-source/", "/edit-preview/"),
        { body: current.current.fields.body },
      );
      if (mounted.current) setPreview(result.html);
    });
  const review = () =>
    run(async () => {
      const source = await request<EditorSource>(sourceUrl(path));
      if (!mounted.current) return;
      if (source.sourceScope !== sourceScope)
        throw new Error(
          "This source now belongs to a different project. Copy your draft, then refresh the page.",
        );
      setLatest(source);
      setPreview(undefined);
    });
  const adopt = () => {
    if (!latest || !current.current) return;
    persist({ ...current.current, base: latest });
    setLatest(undefined);
    setConflict(false);
    setError(undefined);
    setNotice(
      "Reviewed source version adopted. Your draft is unchanged; Save will apply your reconciled fields.",
    );
    titleInput.current?.focus();
  };
  const copy = () =>
    run(async () => {
      if (!current.current) return;
      await navigator.clipboard.writeText(
        JSON.stringify(current.current, null, 2),
      );
      setNotice("Draft and original source fields copied for recovery.");
    });

  const editAction = (
    <button
      ref={editButton}
      type="button"
      disabled={busy || !!draft}
      onClick={() => void open()}
    >
      {recoverable ? "Recover draft" : editLabel}
    </button>
  );
  return (
    <section
      className={`document-editor${draft ? " is-editing" : ""}${latest ? " is-comparing" : ""}`}
      aria-label="Document editing"
    >
      {actionContainer ? createPortal(editAction, actionContainer) : editAction}
      {busy && <span role="status"> Working…</span>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          {draft
            ? "Your draft is still here."
            : "Source has not been changed. You can retry Edit or use a local editor."}
        </p>
      )}
      {storageFailed && (
        <p role="alert">
          Browser draft storage is unavailable. Copy your draft before
          navigating or reloading; in-memory text is not a durable backup.
        </p>
      )}
      {draft && (
        <>
          <p className="editor-draft-state">
            {draftChanged(draft)
              ? "Unsaved draft"
              : "Editing complete source"}{" "}
          </p>
          <div className="editor-actions">
            <button
              type="button"
              disabled={busy}
              aria-pressed={preview !== undefined}
              onClick={() =>
                preview !== undefined
                  ? setPreview(undefined)
                  : void showPreview()
              }
            >
              {preview !== undefined ? "Continue editing" : "Preview"}
            </button>
            <button
              type="button"
              className="editor-save"
              disabled={busy || conflict}
              onClick={() => void save()}
            >
              Save
            </button>
            <button type="button" disabled={busy} onClick={cancel}>
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={() => void copy()}>
              Copy draft
            </button>
          </div>
          {conflict && (
            <div className="editor-conflict" role="alert">
              <p>
                Newer source needs review. Reconcile your draft with the latest
                title, description and body before saving.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void review()}
              >
                Review latest source
              </button>
            </div>
          )}
          <details className="editor-recovery">
            <summary>Draft recovery</summary>
            <p>
              Drafts are kept for this tab’s browser session when storage is
              available. Reopen Edit after navigation or reload to recover them.
              Closing the tab may lose your draft. Use Copy draft to keep a
              separate recovery copy.
            </p>
          </details>
          <div className={latest ? "editor-comparison" : undefined}>
            <fieldset disabled={busy}>
              <legend className="muted">Page content</legend>
              <label htmlFor={`${id}-title`}>Title</label>
              <input
                ref={titleInput}
                id={`${id}-title`}
                value={draft.fields.title}
                maxLength={4096}
                onChange={(e) => change("title", e.target.value)}
              />
              <label htmlFor={`${id}-description`}>Description</label>
              <textarea
                id={`${id}-description`}
                rows={3}
                value={draft.fields.description}
                maxLength={4096}
                onChange={(e) => change("description", e.target.value)}
              />
              <p className="muted">Title and description are optional.</p>
              {preview !== undefined ? (
                <section
                  className="md editor-preview"
                  aria-label="Markdown preview" // biome-ignore lint/security/noDangerouslySetInnerHtml: server uses the shared safe Markdown renderer.
                  dangerouslySetInnerHTML={{ __html: preview }}
                />
              ) : (
                <>
                  {draftTools?.(draft.fields.body, (body) =>
                    change("body", body),
                  )}
                  <label htmlFor={`${id}-body`}>Content · Markdown</label>
                  <textarea
                    className="editor-body"
                    id={`${id}-body`}
                    rows={20}
                    spellCheck={false}
                    value={draft.fields.body}
                    onChange={(e) => change("body", e.target.value)}
                  />
                </>
              )}
            </fieldset>
            {latest && (
              <section
                className="editor-latest"
                aria-label="Latest source for review"
              >
                <h3>Latest source</h3>
                <p>
                  Compare every field with your draft. Copy newer changes into
                  your draft as needed.
                </p>
                <label htmlFor={`${id}-latest-title`}>Latest title</label>
                <input
                  id={`${id}-latest-title`}
                  readOnly
                  value={latest.title ?? ""}
                />
                <label htmlFor={`${id}-latest-description`}>
                  Latest description
                </label>
                <textarea
                  id={`${id}-latest-description`}
                  readOnly
                  rows={3}
                  value={latest.description ?? ""}
                />
                <label htmlFor={`${id}-latest-body`}>
                  Latest Markdown body
                </label>
                <textarea
                  id={`${id}-latest-body`}
                  className="editor-body"
                  readOnly
                  rows={20}
                  value={latest.body}
                />
                <button type="button" disabled={busy} onClick={adopt}>
                  Use reviewed version
                </button>
                <p className="muted">
                  Keeps your draft and enables Save against this version.
                  Changes made after this review will conflict again.
                </p>
              </section>
            )}
          </div>
        </>
      )}
    </section>
  );
}
