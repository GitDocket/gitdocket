import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type DocumentDraft,
  draftChanged,
  draftKey,
  draftPatch,
  EditorRequestError,
  type EditorSource,
  newDraft,
  openCreationDraft,
  registerEditorNavigationGuard,
  requestDocument as request,
  restoreDraft,
  retainDraft,
  type WikiPageType,
  wikiPagePath,
} from "./document-draft";
import { Markdown } from "./markdown";

const sourceUrl = (path: string) =>
  `/api/edit-source/${path.split("/").map(encodeURIComponent).join("/")}`;
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
  creationSource,
  onCancel,
}: {
  path: string;
  sourceScope: string;
  onSaved: (saved?: { path: string; notice: string }) => void;
  creationSource?: EditorSource;
  onCancel?: () => void;
  actionContainer?: HTMLElement | null;
  onEditingChange?: (editing: boolean) => void;
  editLabel?: string;
  draftTools?: (body: string, changeBody: (body: string) => void) => ReactNode;
}) {
  const key = draftKey(sourceScope, path);
  const initialCreation = useRef(creationSource);
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [latest, setLatest] = useState<EditorSource>();
  const [preview, setPreview] = useState<string>();
  const editButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const keepEditingButton = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    if (confirmDiscard) keepEditingButton.current?.focus();
  }, [confirmDiscard]);

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
      const source =
        creationSource ?? (await request<EditorSource>(sourceUrl(path)));
      if (!mounted.current) return;
      if (source.sourceScope !== sourceScope)
        throw new Error(
          "Project source changed. Refresh this page before editing.",
        );
      if (!restored)
        persist({
          ...newDraft(source),
          ...(creationSource
            ? {
                creation: {
                  type: "Reference" as const,
                  path: "",
                  autoPath: true,
                },
              }
            : {}),
        });
      else if (restored.base.version !== source.version) {
        setConflict(true);
        setError(
          "Source changed since this draft began. Review the latest source before retrying.",
        );
      }
    });
  useEffect(() => {
    const source = initialCreation.current;
    if (!source) return;
    const { draft: next, recovered } = openCreationDraft(source, storage);
    current.current = next;
    setDraft(next);
    stored.current = retainDraft(
      key,
      draftChanged(next) ? next : null,
      storage,
    );
    setStorageFailed(!stored.current);
    if (recovered)
      setNotice("Recovered your new-page draft. It has not been saved.");
    focusOnOpen.current = true;
  }, [key]);
  const change = (field: keyof DocumentDraft["fields"], value: string) => {
    if (!current.current || busyRef.current) return;
    persist({
      ...current.current,
      fields: { ...current.current.fields, [field]: value },
      ...(field === "title" && current.current.creation?.autoPath
        ? {
            creation: {
              ...current.current.creation,
              path: wikiPagePath(current.current.creation.type, value),
            },
          }
        : {}),
    });
    if (
      creationSource &&
      field === "title" &&
      current.current.creation?.autoPath
    )
      setConflict(false);
    setPreview(undefined);
  };
  const changeLocation = (value: string, type?: WikiPageType) => {
    if (!current.current?.creation || busyRef.current) return;
    const creation = current.current.creation;
    persist({
      ...current.current,
      creation: type
        ? {
            ...creation,
            type,
            path: creation.autoPath
              ? wikiPagePath(type, current.current.fields.title)
              : creation.path,
          }
        : { ...creation, path: value, autoPath: false },
    });
    setConflict(false);
    setPreview(undefined);
  };
  const discard = () => {
    if (busyRef.current) return;
    setConfirmDiscard(false);
    persist(undefined);
    setRecoverable(false);
    setPreview(undefined);
    setLatest(undefined);
    setConflict(false);
    setError(undefined);
    setNotice("Draft discarded. Source was not changed.");
    onCancel?.();
    requestAnimationFrame(() => editButton.current?.focus());
  };
  const cancel = () => {
    if (busyRef.current) return;
    if (current.current && draftChanged(current.current)) {
      setConfirmDiscard(true);
      return;
    }
    discard();
  };
  const keepEditing = () => {
    setConfirmDiscard(false);
    requestAnimationFrame(() => cancelButton.current?.focus());
  };
  const save = () =>
    run(async () => {
      const pending = current.current;
      if (!pending) return;
      const result = await request<{
        document: EditorSource;
        saveState: string;
        commitError?: string;
      }>(
        pending.creation ? "/api/document-create" : sourceUrl(path),
        pending.creation
          ? {
              sourceScope: pending.base.sourceScope,
              path: pending.creation.path,
              type: pending.creation.type,
              title: pending.fields.title,
              description: pending.fields.description,
              body: pending.fields.body,
            }
          : {
              sourceScope: pending.base.sourceScope,
              expectedVersion: pending.base.version,
              patch: draftPatch(pending),
            },
      );
      if (!mounted.current) return;
      persist(undefined);
      setRecoverable(false);
      setPreview(undefined);
      setConflict(false);
      setLatest(undefined);
      const savedNotice =
        result.saveState === "committed"
          ? "Saved and committed."
          : result.saveState === "commit_failed"
            ? `Saved locally; commit failed. Your source is saved. Check Git before committing manually. ${result.commitError ?? ""}`
            : result.saveState === "unchanged"
              ? "Source is unchanged. No commit was created."
              : "Saved locally. Changes are not committed.";
      setConfirmDiscard(false);
      setNotice(savedNotice);
      setError(undefined);
      // Navigation must happen after run() releases the busy navigation guard.
      requestAnimationFrame(() => {
        if (!mounted.current) return;
        onSaved({ path: result.document.path, notice: savedNotice });
        editButton.current?.focus();
      });
    });
  const showPreview = () =>
    run(async () => {
      if (!current.current) return;
      const result = await request<{ html: string }>(
        sourceUrl(
          current.current.creation?.path ||
            (creationSource ? "reference/new-page.md" : path),
        ).replace("/edit-source/", "/edit-preview/"),
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
      {!creationSource &&
        (actionContainer
          ? createPortal(editAction, actionContainer)
          : editAction)}
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
              : creationSource
                ? "New page draft"
                : "Editing complete source"}{" "}
          </p>
          <div className="editor-actions">
            <button
              type="button"
              disabled={busy || confirmDiscard}
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
              disabled={busy || conflict || confirmDiscard}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              ref={cancelButton}
              type="button"
              disabled={busy || confirmDiscard}
              onClick={cancel}
            >
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={() => void copy()}>
              Copy draft
            </button>
          </div>
          {confirmDiscard && (
            <section
              className="editor-discard"
              aria-labelledby={`${id}-discard-question`}
            >
              <p id={`${id}-discard-question`}>Discard this unsaved draft?</p>
              <button
                ref={keepEditingButton}
                type="button"
                disabled={busy}
                onClick={keepEditing}
              >
                Keep editing
              </button>{" "}
              <button type="button" disabled={busy} onClick={discard}>
                Discard draft
              </button>
            </section>
          )}
          {conflict && !creationSource && (
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
          {conflict && creationSource && (
            <p className="editor-conflict" role="alert">
              Your page was not created. If the location is occupied, choose
              another location; your content stays in this draft. To update an
              existing page, open it separately and review its latest source.
            </p>
          )}
          <details className="editor-recovery">
            <summary>Draft recovery</summary>
            <p>
              Drafts are kept for this tab’s browser session when storage is
              available. Reopen this editor after navigation or reload to
              recover them. Closing the tab may lose your draft. Use Copy draft
              to keep a separate recovery copy.
            </p>
          </details>
          <div className={latest ? "editor-comparison" : undefined}>
            <fieldset disabled={busy || confirmDiscard}>
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
              <p className="muted">
                {creationSource
                  ? "A title is required. Description is optional."
                  : "Title and description are optional."}
              </p>
              {draft.creation && (
                <>
                  <label htmlFor={`${id}-type`}>Page type</label>
                  <select
                    id={`${id}-type`}
                    value={draft.creation.type}
                    onChange={(e) =>
                      changeLocation("", e.target.value as WikiPageType)
                    }
                  >
                    <option value="Reference">
                      Reference — explain project knowledge
                    </option>
                    <option value="Spec">
                      Spec — describe desired behavior
                    </option>
                    <option value="Playbook">
                      Playbook — record a repeatable procedure
                    </option>
                  </select>
                  <label htmlFor={`${id}-location`}>Location</label>
                  <input
                    id={`${id}-location`}
                    value={draft.creation.path}
                    placeholder="reference/page-name.md"
                    onChange={(e) => changeLocation(e.target.value)}
                    aria-describedby={`${id}-location-help`}
                  />
                  <p className="muted" id={`${id}-location-help`}>
                    A Markdown path inside this project’s wiki, ending in .md.
                    Existing pages are never replaced.
                  </p>
                </>
              )}
              {preview !== undefined ? (
                <Markdown html={preview} preview />
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
