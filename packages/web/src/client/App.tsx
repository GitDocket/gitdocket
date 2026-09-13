// The whole SPA: hash routing, wiki pages, board with drag-to-move, epic
// rollups. Read-mostly by design — the writes are the status drag and the
// Inline field edits round-trip through the server's
// core-ops endpoints.

import type { ProjectGuidance } from "@gitdocket/core";
import {
  REENTRY_CONTEXT_V1_FORMAT,
  type StateOfPlayView,
} from "@gitdocket/core/state-of-play";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { conceptHref, hashQuery, workHref } from "../urls";
import {
  type BoardState,
  boardStateQuery,
  DEFAULT_BOARD,
  type EpicRef,
  groupByEpic,
  parseBoardState,
} from "./board";
import {
  type DocItem,
  type DocSection,
  isDocPath,
  sidebarSections,
} from "./docs";
import { allowEditorNavigation } from "./document-draft";
import { DocumentEditor } from "./document-editor";
import {
  DEFAULT_EPICS,
  type EpicListState,
  type EpicRow,
  type EpicSortKey,
  epicListEmptyMessage,
  epicListQuery,
  parseEpicListState,
} from "./epiclist";
import { GuidanceTools } from "./guidance-tools";
import { createRequestGate } from "./live";
import { createJsonRequests } from "./requests";

import {
  Icon,
  readPreference,
  rememberedView,
  rememberView,
  writePreference,
} from "./workspace";

const jsonRequests = createJsonRequests();

import {
  itemHash,
  type PaletteItem,
  paletteItems,
  type SearchHit,
  viewCatalog,
} from "./palette";
import { modeLabel, nextMode, type SortMode } from "./sort";
import {
  DEFAULT_STATE,
  type ListState,
  listStateQuery,
  parseListState,
  type SortKey,
  type TaskRow,
} from "./tasklist";

export type Route =
  | { view: "home" }
  | { view: "wiki" }
  | { view: "guidance" }
  | { view: "board"; query: string }
  | { view: "epics"; query: string }
  | { view: "tasks"; query: string }
  | { view: "activity" }
  | { view: "docs"; dir: string }
  | { view: "concept"; path: string; ticket?: string; anchor?: string };

export function parseHashValue(hash: string): Route {
  const [routePart = "", fragment] = hash.replace(/^#\/?/, "").split("#");
  const raw = routePart;
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const anchor = fragment === undefined ? {} : { anchor: decode(fragment) };
  // Tasks and board keep their filter state in the query part; URLSearchParams
  // decodes it, so it must not be pre-decoded with the rest.
  if (raw === "tasks" || raw.startsWith("tasks?"))
    return { view: "tasks", query: raw.slice("tasks?".length) };
  if (raw === "board" || raw.startsWith("board?"))
    return { view: "board", query: raw.slice("board?".length) };
  if (raw === "epics" || raw.startsWith("epics?"))
    return { view: "epics", query: raw.slice("epics?".length) };
  const h = decode(raw.split("?")[0] ?? raw);
  if (h === "work" || h.startsWith("work/"))
    return { view: "concept", path: h, ticket: h.slice(5), ...anchor };
  if (h === "guidance") return { view: "guidance" };
  if (h === "wiki") return { view: "wiki" };
  if (h === "activity") return { view: "activity" };
  // Bare #/docs is the Docs tab; #/docs/<dir> renders into the same view with
  // that section's articles up.
  if (h === "docs") return { view: "docs", dir: "" };
  if (h.startsWith("docs/")) return { view: "docs", dir: h.slice(5) };
  if (h.startsWith("c/"))
    return { view: "concept", path: h.slice(2), ...anchor };
  return { view: "home" };
}

function parseHash(): Route {
  return parseHashValue(location.hash);
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    let acceptedHash = location.hash;
    const onChange = () => {
      if (location.hash !== acceptedHash && !allowEditorNavigation()) {
        history.replaceState(null, "", acceptedHash || "#/");
        return;
      }
      acceptedHash = location.hash;
      setRoute(parseHash());
    };
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
  return route;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    signal,
    headers: { "X-Docket-Trigger": "explicit" },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  if (res.headers.get("X-Docket-Freshness") === "stale")
    throw new Error(
      "Refresh failed. Showing last-known data; current state is unconfirmed.",
    );
  return body as T;
}

// Each mounted route owns one latest-only loader. Bundle revision changes and
// local writes use the same load function, so overlapping requests cannot
// publish out of order.
function useLiveJson<T>(url: string, revision: string, enabled = true) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const gate = useRef(createRequestGate());
  const previous = useRef<{ url: string; revision: string } | undefined>(
    undefined,
  );
  const pending = useRef<(() => void) | undefined>(undefined);
  const load = useCallback(
    (fresh = true) => {
      // Reading the revision binds this loader generation to the signal even
      // though the API URL itself is stable.
      void revision;
      if (!enabled) return;
      pending.current?.();
      const trigger =
        !fresh &&
        previous.current?.url === url &&
        previous.current.revision !== revision
          ? "background"
          : "explicit";
      previous.current = { url, revision };
      const request = jsonRequests.acquire<T>(url, revision, fresh, trigger);
      pending.current = request.release;
      const current = gate.current.begin();
      setLoading(true);
      return request.result
        .then(({ data: next, stale }) => {
          if (!current()) return;
          setData(next);
          setError(
            stale
              ? "Refresh failed. Showing last-known data; current state is unconfirmed."
              : undefined,
          );
        })
        .catch((e: Error) => {
          if (current()) setError(e.message);
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    },
    [enabled, revision, url],
  );

  useEffect(() => {
    load(false);
    return () => {
      gate.current.cancel();
      pending.current?.();
    };
  }, [load]);

  return { data, error, load, loading };
}

interface PageInfo {
  number: number;
  limit: number;
  total: number;
  generation: number;
  next: number | null;
}
function Pager({
  page,
  onPage,
  label = "Result pages",
  disabled = false,
}: {
  label?: string;
  disabled?: boolean;
  page?: PageInfo;
  onPage: (page: number) => void;
}) {
  if (!page) return null;
  return (
    <nav className="pagination" aria-label={label}>
      <button
        type="button"
        disabled={disabled || page.number <= 1}
        onClick={() => onPage(page.number - 1)}
      >
        Previous
      </button>
      <span role="status">
        {page.total ? (page.number - 1) * page.limit + 1 : 0}–
        {Math.min(page.number * page.limit, page.total)} of {page.total}
      </span>
      <button
        type="button"
        disabled={disabled || !page.next}
        onClick={() => {
          if (page.next) onPage(page.next);
        }}
      >
        Next
      </button>
    </nav>
  );
}
function usePage(query = "") {
  const requested = Math.max(
    1,
    Number(new URLSearchParams(query).get("page")) || 1,
  );
  const [page, setPage] = useState(requested);
  useEffect(() => setPage(requested), [requested]);
  const change = (next: number, push = true) => {
    setPage(next);
    const [route = "", anchor] = location.hash.slice(1).split("#");
    const [base, qs] = `#${route}`.split("?");
    const params = new URLSearchParams(qs);
    if (next === 1) params.delete("page");
    else params.set("page", String(next));
    history[push ? "pushState" : "replaceState"](
      null,
      "",
      base +
        (params.size ? `?${params}` : "") +
        (anchor === undefined ? "" : `#${anchor}`),
    );
    // History API writes do not emit hashchange. Defer until a filter's
    // accompanying replaceState has finished, then synchronize route props.
    queueMicrotask(() =>
      window.dispatchEvent(new HashChangeEvent("hashchange")),
    );
  };
  return [page, change] as const;
}
// Native datalist keeps keyboard entry available; options are an exact search
// of all facet values, independent of the currently loaded result page.
function FacetInput({
  field,
  value,
  onChange,
  label,
  revision,
}: {
  field: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
  revision: string;
}) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const { data } = useLiveJson<{ options: { value: string; label: string }[] }>(
    `/api/facets?field=${field}&q=${encodeURIComponent(value)}`,
    revision,
    focused,
  );
  return (
    <>
      <input
        list={id}
        aria-label={label}
        placeholder={label}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={id}>
        {data?.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </datalist>
    </>
  );
}
function EpicPicker({
  current,
  onChange,
  revision,
  label = "epic",
}: {
  current: GraphRef | null;
  onChange: (path: string | null) => void;
  revision: string;
  label?: string;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const editor = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) editor.current?.focus();
    else if (wasEditing.current) trigger.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const [query, setQuery] = useState("");
  const { data } = useLiveJson<{
    options: { value: string; label: string; path: string }[];
  }>(
    `/api/facets?field=epic&q=${encodeURIComponent(query)}`,
    revision,
    editing,
  );
  if (!editing)
    return (
      <span>
        {current && <a href={workHref(current)}>{current.id}</a>}{" "}
        <button
          type="button"
          ref={trigger}
          aria-label={label}
          onClick={() => {
            setQuery("");
            setEditing(true);
          }}
        >
          Edit epic
        </button>
      </span>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const option = data?.options.find((o) => o.value === query);
        if (!query || option) {
          onChange(option ? `/${option.path}` : null);
          setEditing(false);
        }
      }}
    >
      <input
        ref={editor}
        list={id}
        aria-label={label}
        placeholder="Epic ID; empty clears"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <datalist id={id}>
        {data?.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </datalist>
      <button
        type="submit"
        disabled={!!query && !data?.options.some((o) => o.value === query)}
      >
        Save
      </button>
      <button type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}
function SourceReader({
  path,
  revision,
  readable = false,
  anchor,
}: {
  path: string;
  revision: string;
  readable?: boolean;
  anchor?: string;
}) {
  const [cursors, setCursors] = useState<(unknown | undefined)[]>([undefined]);
  const [at, setAt] = useState(0);
  const [skipAnchor, setSkipAnchor] = useState(false);
  useEffect(() => {
    void path;
    void revision;
    setCursors([undefined]);
    setAt(0);
    void anchor;
    setSkipAnchor(false);
  }, [path, revision, anchor]);
  const cursor = cursors[at];
  const { data, error, load, loading } = useLiveJson<{
    text: string;
    html?: string | null;
    partial?: boolean;
    startLine: number;
    endLine: number;
    sourceHash: string;
    nextCursor?: unknown;
  }>(
    "/api/source/" +
      path +
      `?${readable ? "readable=1&" : ""}${cursor ? `cursor=${encodeURIComponent(JSON.stringify(cursor))}` : anchor && !skipAnchor ? `anchor=${encodeURIComponent(anchor)}` : ""}`,
    revision,
  );
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (data && anchor && !skipAnchor) section.current?.scrollIntoView();
  }, [data, anchor, skipAnchor]);
  return (
    <section ref={section} aria-label={`Source ${path}`}>
      {error && (
        <>
          <ErrorNote message={error} />
          <button
            type="button"
            onClick={() => {
              setCursors([undefined]);
              setAt(0);
              setSkipAnchor(true);
              if (!at) load();
            }}
          >
            Restart from first page
          </button>
        </>
      )}
      {data ? (
        readable ? (
          <>
            <p className="muted log-caption">
              Authored project log{data.partial ? " · excerpt" : ""}
            </p>
            {data.html != null ? (
              <Markdown html={data.html} />
            ) : (
              <>
                <p className="muted">
                  This excerpt may cross a Markdown block. Exact text is shown.
                </p>
                <pre className="source-page">{data.text}</pre>
              </>
            )}
            <details className="source-details">
              <summary>
                Source details · lines {data.startLine}–{data.endLine}
              </summary>
              <code>{path}</code>
              <p>
                Source hash <code>{data.sourceHash}</code>
              </p>
            </details>
          </>
        ) : (
          <>
            <p>
              <code>{path}</code> · lines {data.startLine}–{data.endLine}{" "}
              <small title={data.sourceHash}>
                source {data.sourceHash.slice(0, 8)}
              </small>
            </p>
            <pre className="source-page">{data.text}</pre>
          </>
        )
      ) : (
        <p>loading…</p>
      )}
      <nav
        className="pagination"
        aria-label={readable ? "Project log pages" : "Source pages"}
      >
        <button
          type="button"
          disabled={loading || !at}
          onClick={() => setAt(at - 1)}
        >
          {readable ? "Previous log page" : "Previous source page"}
        </button>
        <button
          type="button"
          disabled={loading || !data?.nextCursor}
          onClick={() => {
            setCursors([...cursors.slice(0, at + 1), data?.nextCursor]);
            setAt(at + 1);
          }}
        >
          {readable ? "Next log page" : "Next source page"}
        </button>
      </nav>
    </section>
  );
}

// One subscription per tab. The server immediately sends its current
// revision on connect, making EventSource's automatic reconnect a catch-up
// refresh after any missed bundle changes.
function useBundleRevision(): string {
  const [revision, setRevision] = useState("0");
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (event) =>
      setRevision(event.lastEventId || event.data || String(Date.now()));
    return () => events.close();
  }, []);
  return revision;
}

interface Frontmatter {
  type: string;
  title?: string;
  id?: string;
  status?: string;
  priority?: string;
  epic?: string;
}

interface GraphRef {
  path: string;
  id: string;
  title: string | null;
  status: string | null;
}

interface Concept {
  editScope: string;
  editing: { editable: boolean; reason?: string };
  sourcePath?: string;
  relationPage?: PageInfo;
  path: string;
  fm: Frontmatter | null;
  states: string[];
  ready: boolean;
  html: string;
  backlinks: {
    path: string;
    title: string | null;
    id?: string;
    type?: string;
  }[];
  activity: { sha: string; date: string; subject: string }[];
  unmergedActivity: GitActivityObservation[];
  graph: {
    epic: GraphRef | null;
    deps: GraphRef[];
    children: (GraphRef & { ready: boolean })[];
  } | null;
  verification: VerificationCardData | null;
}

export interface VerificationCardData {
  groups: {
    kind: string;
    anchors: {
      anchor: string | null;
      sources: { path: string; line: number }[];
    }[];
  }[];
}

// The slim shape the home strips get; board cards add filter facets.
interface WorkCard {
  status: string;
  priority: string | null;
  rank: number | null;
  id: string;
  title: string | null;
  path: string;
  timestamp: string | null;
}

interface BoardCard extends WorkCard {
  epic: EpicRef | null;
  tags: string[];
  assignee: string | null;
}

interface BoardData {
  columns?: { status: string; cards: BoardCard[]; page: PageInfo }[];
  states: string[];
  cards: BoardCard[];
  totals: Record<string, number>;
}

interface EpicsData {
  page?: PageInfo;
  total?: number;
  states: string[];
  epics: EpicRow[];
}

export function EpicEditor({
  current,
  epics,
  value,
  onChange,
}: {
  current: GraphRef | null;
  epics: EpicRow[] | undefined;
  value: string;
  onChange: (to: string | null) => void;
}) {
  return (
    <div className="edit-field">
      <span>epic</span>
      {epics && (
        <select
          aria-label="epic"
          className="inline-select"
          value={value}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">no epic</option>
          {epics.map((epic) => (
            <option key={epic.id} value={`/${epic.path}`}>
              {epic.id} — {epic.title ?? epic.path}
            </option>
          ))}
        </select>
      )}
      {current && (
        <a
          className="edit-link"
          href={workHref(current)}
          aria-label={`View epic ${current.id}`}
        >
          view {current.id}
        </a>
      )}
    </div>
  );
}

// Fixed by the task profile spec — not worth an API round-trip.
const PRIORITIES = ["p0", "p1", "p2", "p3"];

type EditField = "status" | "priority" | "epic";

// One POST per field edit, against the same core-ops endpoints the
// board drag uses. Resolves to an error message, or undefined on success.
async function postEdit(
  id: string,
  field: EditField,
  to: string | null,
): Promise<string | undefined> {
  try {
    const note =
      field === "status" && to === "closed"
        ? window.prompt("Why is this work being closed without completion?")
        : undefined;
    if (field === "status" && to === "closed" && !note?.trim())
      return "Closing without completion requires a disposition note.";
    const res = await fetch(`/api/tasks/${id}/${field}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Docket-Trigger": "explicit",
      },
      body: JSON.stringify({ to, ...(note ? { note: note.trim() } : {}) }),
    });
    if (res.ok) return undefined;
    return ((await res.json()) as { error?: string }).error ?? res.statusText;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function WorkHelp() {
  return (
    <details className="work-help muted">
      <summary>Saving, completion and follow-up</summary>
      <p>
        Changes save to local files and remain uncommitted by default. Start the
        server with <code>docket serve --commit</code> to request a commit per
        edit. If a commit fails after saving, the source is still saved locally;
        inspect Git status before retrying the commit.
      </p>
      <p>
        Done records completed acceptance criteria. Review the Outcome, checks
        and affected docs; changing status alone does not verify or reconcile
        them. Closed means work ended without completion and requires a reason;
        it does not unblock dependencies.
      </p>
      <p>
        Done and closed are terminal. Ask your agent to create a new follow-up
        task linked to the original when more work is needed.
      </p>
    </details>
  );
}

function Chip({ kind, children }: { kind: string; children: string }) {
  return (
    <span className={`chip chip-${kind.replace(/\s/g, "")}`}>{children}</span>
  );
}

function ErrorNote({ message }: { message: string }) {
  return <p className="error">{message}</p>;
}

function GuidanceView({ revision }: { revision: string }) {
  const { data, error, load } = useLiveJson<{
    guidance: ProjectGuidance;
    editScope: string;
    editing: { editable: boolean; reason?: string };
    html: string | null;
  }>("/api/guidance", revision);
  const [editing, setEditing] = useState(false);
  return (
    <article className="guidance-view">
      <header className="view-header">
        <h1>Project guidance</h1>
      </header>
      <p>
        Project-authored standards and scoped procedure links. Agents read these
        sources and apply relevant instructions; a procedure link does not
        authorize execution.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading guidance…</p>}
      {data && (
        <>
          {data.guidance.status === "absent" ? (
            <p>
              No project guidance yet. Setup is optional. Add an instruction or
              reuse an existing procedure to start a draft.
            </p>
          ) : (
            <p>
              Source:{" "}
              <a href={conceptHref({ path: data.guidance.path })}>
                {data.guidance.path}
              </a>{" "}
              · {data.guidance.status}
            </p>
          )}
          {data.guidance.status === "empty" && (
            <p>This source has no active guidance content yet.</p>
          )}
          {data.guidance.diagnostics.length > 0 && (
            <ul aria-label="Guidance diagnostics">
              {data.guidance.diagnostics.map((diagnostic) => (
                <li key={diagnostic.message}>{diagnostic.message}</li>
              ))}
            </ul>
          )}
          {data.editing.editable ? (
            <DocumentEditor
              path={data.guidance.path}
              sourceScope={data.editScope}
              onSaved={() => void load()}
              onEditingChange={setEditing}
              editLabel={
                data.guidance.status === "absent"
                  ? "Add project guidance"
                  : "Edit guidance"
              }
              draftTools={(body, changeBody) => (
                <GuidanceTools body={body} changeBody={changeBody} />
              )}
            />
          ) : (
            <p className="muted">{data.editing.reason}</p>
          )}
          {!editing &&
            data.guidance.source &&
            (data.html !== null ? (
              <Markdown html={data.html} />
            ) : (
              <SourceReader
                path={data.guidance.path}
                revision={revision}
                readable
              />
            ))}
          {data.guidance.links.length > 0 && (
            <section aria-label="Linked guidance sources">
              <h2>Linked sources</h2>
              <p>
                Open a source to read its full content or edit it with the
                shared document editor. Availability does not establish
                authority or scope.
              </p>
              <ul>
                {data.guidance.links.map((link) => (
                  <li key={link.target}>
                    {link.path && link.status === "available" ? (
                      <a href={conceptHref({ path: link.path })}>
                        {link.target}
                      </a>
                    ) : (
                      <span>{link.target}</span>
                    )}{" "}
                    · {link.status}
                  </li>
                ))}
              </ul>
              {data.guidance.linksTruncated && (
                <p>
                  Only the first 100 distinct links are listed. Read the
                  complete source for the remaining links.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </article>
  );
}

function Markdown({ html }: { html: string }) {
  // Server-rendered through the same unified pipeline core parses with.
  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local render
  return <article className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export interface HomeData {
  preambleSourcePath?: string;
  narrativeSourcePath?: string;
  narrativeProblem?: "missing" | "malformed";
  project: string;
  preamble: string;
  narrative:
    | (StateOfPlayView & {
        html: string;
        sectionHtml?: {
          recent: string;
          next: string;
          worthKnowing?: string;
        };
      })
    | null;
}

function VerificationKindLabel({ kind }: { kind: string }) {
  const label = kind === "test" ? "Tests" : kind === "case" ? "Cases" : kind;
  return <h3>{label}</h3>;
}

/** Presence only: no result state, scores, or unknown-state treatment. */
export function VerifiedByCard({
  verification,
}: {
  verification: VerificationCardData;
}) {
  return (
    <section className="verified-by" aria-labelledby="verified-by-title">
      <h2 id="verified-by-title">Verified by</h2>
      {verification.groups.length === 0 ? (
        <p className="muted">Nothing verifies this spec.</p>
      ) : (
        verification.groups.map((group) => (
          <div className="verification-kind" key={group.kind}>
            <VerificationKindLabel kind={group.kind} />
            {group.anchors.map((anchorGroup) => (
              <div
                className="verification-anchor"
                key={anchorGroup.anchor ?? "whole-spec"}
              >
                <h4>
                  {anchorGroup.anchor ? (
                    <code>#{anchorGroup.anchor}</code>
                  ) : (
                    "Whole spec"
                  )}
                </h4>
                <ul>
                  {anchorGroup.sources.map((source) => (
                    <li key={`${source.path}:${source.line}`}>
                      <code>
                        {source.path}:{source.line}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  );
}

interface ActivityEntry {
  sha: string;
  date: string;
  subject: string;
}

interface GitActivityObservation extends ActivityEntry {
  taskId: string;
  mergedIntoCurrentHead: false;
  refs: string[];
  worktrees: string[];
}

interface GitWorktreeEvidence {
  path: string;
  head: string;
  ref: string | null;
  activeTaskId: string | null;
  dirty: boolean | null;
  mergedIntoCurrentHead: boolean | null;
  current: boolean;
  available: boolean;
}

interface GitEvidence {
  status: "available" | "history-unavailable";
  unmergedActivity: GitActivityObservation[];
  worktrees: GitWorktreeEvidence[];
  truncated: boolean;
  reason?: string;
}

function DocList({ items }: { items: DocItem[] }) {
  return (
    <ul className="doclist">
      {items.map((item) => (
        <li key={item.path}>
          <a href={`#/c/${item.path}`}>{item.title ?? item.path}</a>
          {item.description && (
            <span className="doc-description muted">{item.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  return (
    <ul className="activity">
      {entries.map((a) => (
        <li key={a.sha}>
          <code>{a.sha.slice(0, 7)}</code>
          <span className="muted"> {a.date.slice(0, 10)} </span>
          {a.subject}
        </li>
      ))}
    </ul>
  );
}

function UnmergedActivityFeed({
  entries,
}: {
  entries: GitActivityObservation[];
}) {
  return (
    <ul className="activity">
      {entries.map((entry) => {
        const provenance = [...entry.refs, ...entry.worktrees];
        return (
          <li key={`${entry.sha}:${entry.taskId}`}>
            <code>{entry.sha.slice(0, 7)}</code>
            <span className="muted"> {entry.date.slice(0, 10)} </span>
            <code>{entry.taskId}</code> {entry.subject}
            {provenance.length > 0 && (
              <span className="muted"> — {provenance.join(", ")}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StateOfPlay({ note }: { note: NonNullable<HomeData["narrative"]> }) {
  const age =
    note.taskCommitsAgo === null
      ? "task-linked age unavailable"
      : `${note.taskCommitsAgo} task-linked commits ago`;
  if (note.format === "legacy") {
    return (
      <section className="state-of-play state-of-play-needs-review">
        <h2>Earlier state of play</h2>
        <p className="state-of-play-review" role="status">
          Context needs review. This older prose remains inspectable but is not
          presented as current project context. Ask your agent to refresh the
          project re-entry note from repository evidence.
        </p>
        <Markdown html={note.html} />
        <p className="state-of-play-stamp">
          as of <code>{note.asOf.slice(0, 7)}</code>, {age}
        </p>
      </section>
    );
  }

  if (note.format === REENTRY_CONTEXT_V1_FORMAT) {
    return (
      <section className="state-of-play state-of-play-needs-review">
        <h2>Earlier product context</h2>
        <p className="state-of-play-review" role="status">
          Context needs review. This superseded format remains inspectable and
          will be replaced only by a meaningful refresh. Ask your agent to
          refresh the project re-entry note from repository evidence.
        </p>
        <Markdown html={note.html} />
        <p className="state-of-play-stamp">
          reviewed {new Date(note.reviewedAt).toLocaleDateString()}, as of{" "}
          <code>{note.asOf.slice(0, 7)}</code>, {age}
        </p>
      </section>
    );
  }

  const html = note.sectionHtml;
  if (!html) return null;
  const reviewMessage =
    note.review.status === "needs-review"
      ? "Context needs review. This last-known note remains useful, but newer evidence or time may have moved beyond it. Ask your agent to refresh the project re-entry note from repository evidence."
      : note.review.status === "age-unavailable"
        ? "Evidence age is unavailable. The note is shown with its review time, but its Git age could not be confirmed. Use the Board for current work and ask your agent to review the note against available repository evidence."
        : null;
  const sections: { kind: string; label: string; html: string }[] = [
    {
      kind: "recent",
      label: "What we've done recently",
      html: html.recent,
    },
    { kind: "next", label: "What's up next", html: html.next },
    ...(html.worthKnowing
      ? [
          {
            kind: "worth-knowing",
            label: "Worth knowing",
            html: html.worthKnowing,
          },
        ]
      : []),
  ];
  const trustLabel =
    note.review.status === "current"
      ? "Current"
      : note.review.status === "needs-review"
        ? "Needs review"
        : "Evidence age unavailable";
  const evidenceAge =
    note.taskCommitsAgo === null
      ? "Task-linked commit distance is unavailable."
      : note.taskCommitsAgo === 0
        ? "No task-linked commits after this revision."
        : `${note.taskCommitsAgo} task-linked commit${
            note.taskCommitsAgo === 1 ? "" : "s"
          } after this revision.`;
  return (
    <section
      className={`state-of-play${
        note.review.status === "needs-review"
          ? " state-of-play-needs-review"
          : ""
      }`}
    >
      <h2>Project re-entry</h2>
      {reviewMessage && (
        <p className="state-of-play-review" role="status">
          {reviewMessage}
        </p>
      )}
      <div className="reentry-sections">
        {sections.map((section) => (
          <div
            className={`reentry-section reentry-section-${section.kind}`}
            key={section.label}
          >
            <h3>{section.label}</h3>
            <Markdown html={section.html} />
          </div>
        ))}
      </div>
      <div className="state-of-play-meta">
        <span
          className={`state-of-play-trust state-of-play-trust-${note.review.status}`}
        >
          {trustLabel}
        </span>
        <span>
          Reviewed{" "}
          {new Date(note.reviewedAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </span>
        <details className="state-of-play-audit">
          <summary>Audit details</summary>
          <span>
            Evidence revision <code>{note.asOf.slice(0, 7)}</code>.{" "}
            {evidenceAge}
          </span>
        </details>
      </div>
    </section>
  );
}

export function HomeBriefing({
  data,
  boardPreview,
}: {
  data: HomeData;
  boardPreview?: ReactNode;
}) {
  return (
    <div className="home">
      <section className="home-intro">
        {data.preamble ? (
          <Markdown html={data.preamble} />
        ) : (
          <h1>{data.project}</h1>
        )}
      </section>
      {boardPreview}
      {data.narrative ? (
        <StateOfPlay note={data.narrative} />
      ) : (
        !data.narrativeSourcePath && (
          <div className="context-unavailable muted">
            <p>
              {data.narrativeProblem === "malformed"
                ? "The project re-entry note could not be read as a valid briefing. Ask your agent to inspect and repair overview.md from repository evidence."
                : "No project re-entry note yet. This is optional. Ask your agent to create a project re-entry note from repository evidence when a summary would help."}
            </p>
            <p>
              <a href="#/board">View current work</a> or{" "}
              <a href="#/wiki">read project docs</a>. A briefing refresh updates
              authored context; reloading this page only reads the saved files.
            </p>
          </div>
        )
      )}
    </div>
  );
}

// Home is the first-minute briefing; the git-facing index body belongs to the
// separate Wiki/Docs knowledge surfaces.
function HomeView({ revision }: { revision: string }) {
  const { data, error } = useLiveJson<HomeData>(
    "/api/home?briefing=1",
    revision,
  );
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;

  return (
    <>
      {error && <ErrorNote message={error} />}
      <HomeBriefing
        data={data}
        boardPreview={<BoardAtGlance revision={revision} />}
      />
      {data.preambleSourcePath && (
        <SourceReader path={data.preambleSourcePath} revision={revision} />
      )}
      {data.narrativeSourcePath && (
        <SourceReader path={data.narrativeSourcePath} revision={revision} />
      )}
    </>
  );
}

export function BoardPreview({
  data,
  href,
  scope,
  visibility,
}: {
  data: BoardData;
  href: string;
  scope: string;
  visibility: BoardState["visibility"];
}) {
  const terminal = (status: string) => status === "done" || status === "closed";
  const eligible = data.states.filter(
    (status) =>
      visibility === "all" ||
      (visibility === "completed" ? terminal(status) : !terminal(status)),
  );
  const ordered = [
    "in-progress",
    "todo",
    ...eligible.filter((status) => !["in-progress", "todo"].includes(status)),
  ]
    .filter((status) => eligible.includes(status))
    .slice(0, 3);
  return (
    <section className="board-preview" aria-label="Board at a glance">
      <header>
        <div>
          <h2>Board at a glance</h2>
          <p className="muted">
            {scope} ·{" "}
            {visibility === "completed"
              ? "Done & Closed"
              : visibility === "all"
                ? "All states"
                : "Active work"}
          </p>
        </div>
        <a href={href}>Open board →</a>
      </header>
      <div className="mini-board">
        {ordered.map((status) => {
          const column = data.columns?.find(
            (column) => column.status === status,
          );
          const cards = data.cards
            .filter((card) => card.status === status)
            .slice(0, 2);
          return (
            <section className="mini-column" key={status}>
              <h3>
                {status.replaceAll("-", " ")}{" "}
                <span className="muted">
                  {column?.page.total ?? cards.length}
                </span>
              </h3>
              {cards.map((card) => (
                <a key={card.id} href={workHref(card)}>
                  <span>{card.title}</span>
                  <code>{card.id}</code>
                </a>
              ))}
              {cards.length === 0 && (
                <p className="muted">No matching tasks.</p>
              )}
            </section>
          );
        })}
      </div>
      <p className="preview-caption muted">
        Up to two tasks per status. Open the board for all matching work.
      </p>
    </section>
  );
}

function BoardAtGlance({ revision }: { revision: string }) {
  const restored = rememberedView("board");
  const state = parseBoardState(restored.split("?")[1] ?? "");
  const query = boardStateQuery(state);
  const href = `#/board${query ? `?${query}` : ""}`;
  const scope = [
    state.epic ? `Epic ${state.epic}` : "Project-wide",
    state.tag && `Tag: ${state.tag}`,
    state.assignee && `Assignee: ${state.assignee}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const { data, error, load, loading } = useLiveJson<BoardData>(
    `/api/board?page=1&limit=2&${query}&sorts=${encodeURIComponent(JSON.stringify(loadSorts()))}`,
    revision,
  );
  return (
    <>
      <div role="status">
        {!data && !error && <p className="muted">Loading board preview…</p>}
      </div>
      {error && (
        <div className="preview-error">
          <ErrorNote message={error} />
          <button type="button" onClick={() => load()} disabled={loading}>
            Retry board preview
          </button>
        </div>
      )}
      {data && (
        <BoardPreview
          data={data}
          href={href}
          scope={scope}
          visibility={state.visibility}
        />
      )}
    </>
  );
}

export function WikiLanding({ sections }: { sections: DocSection[] }) {
  const previewLimit = 3;
  return (
    <div className="wiki-home">
      <header className="wiki-head">
        <h1>Wiki</h1>
        <p>
          Browse the project&apos;s linked knowledge, then follow concepts into
          their specs, decisions, workflows, references, and work context.
        </p>
      </header>
      {sections.length === 0 ? (
        <p className="muted">No knowledge sections are available yet.</p>
      ) : (
        <div className="wiki-section-grid">
          {sections.map((section) => (
            <section className="wiki-section-card" key={section.name}>
              <h2 className="section-name">
                <a href={`#/docs/${section.name}`}>{section.name}</a>
              </h2>
              <DocList items={section.items.slice(0, previewLimit)} />
              {(section.total ?? section.items.length) > previewLimit && (
                <a className="wiki-more" href={`#/docs/${section.name}`}>
                  Browse all {section.total ?? section.items.length} →
                </a>
              )}
            </section>
          ))}
        </div>
      )}
      <section className="wiki-work">
        <h2>Work and history</h2>
        <p className="muted">
          Tasks and epics are Wiki concepts with dedicated operational views.
        </p>
        <div className="wiki-work-links">
          <a href="#/tasks">
            <strong>Tasks</strong>
            <span>Search and filter every work item.</span>
          </a>
          <a href="#/board">
            <strong>Board</strong>
            <span>Sequence work across workflow states.</span>
          </a>
          <a href="#/epics">
            <strong>Epics</strong>
            <span>Review outcomes, progress, and cleanup.</span>
          </a>
          <a href="#/activity">
            <strong>Activity</strong>
            <span>Read the authored log and Git history.</span>
          </a>
        </div>
      </section>
    </div>
  );
}

function WikiView({ revision }: { revision: string }) {
  const [page, setPage] = usePage(hashQuery(location.hash));
  const { data, error } = useLiveJson<{
    sections: DocSection[];
    page: PageInfo;
  }>(`/api/docs?preview=1&page=${page}`, revision);
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;
  return (
    <>
      {error && <ErrorNote message={error} />}
      <WikiLanding sections={data.sections} />
      <Pager page={data.page} onPage={setPage} label="Wiki sections pages" />
    </>
  );
}

// The Docs view: a persistent section sidebar beside the main pane.
// The pane holds either a doc article (ConceptView as children) or, on the
// #/docs routes and the section listings behind the "All N →" links —
// listings keep the server's newest-first order, the sidebar sorts by title.
function DocsShell({
  dir,
  current,
  children,
  revision,
}: {
  dir?: string;
  current?: string;
  children?: ReactNode;
  revision: string;
}) {
  const [browseOpen, setBrowseOpen] = useState(
    () => !window.matchMedia("(max-width: 900px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const change = () => setBrowseOpen(!media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const { data, error } = useLiveJson<{ sections: DocSection[] }>(
    "/api/docs",
    revision,
  );
  const [page, setPage] = usePage(hashQuery(location.hash));
  const { data: listingData, error: listingError } = useLiveJson<{
    sections: DocSection[];
    page: PageInfo;
  }>(
    `/api/docs?page=${page}&section=${encodeURIComponent(dir ?? "")}`,
    revision,
    !children,
  );
  const sections = data?.sections;
  if (error && !data) return <ErrorNote message={error} />;
  if (!sections) return <p className="muted">loading…</p>;

  const listing = (section: DocSection) => (
    <section key={section.name}>
      <h2 className="section-title section-name">{section.name}</h2>
      <DocList items={section.items} />
    </section>
  );
  const shown = listingData?.sections ?? [];
  const main =
    children ??
    (shown.length > 0 ? (
      shown.map(listing)
    ) : (
      <ErrorNote message={`no such section: ${dir}`} />
    ));

  return (
    <div className="docs-layout">
      <div className="docs-main">
        {(error || listingError) && (
          <ErrorNote message={error ?? listingError ?? "Refresh failed"} />
        )}{" "}
        {main}
        {!children && (
          <Pager
            page={listingData?.page}
            onPage={setPage}
            label="Wiki documents pages"
          />
        )}
      </div>
      <aside className="docs-sidebar" aria-label="Wiki sections">
        <details
          open={browseOpen}
          onToggle={(e) => setBrowseOpen(e.currentTarget.open)}
        >
          <summary>Browse wiki</summary>
          <a className="wiki-overview-link" href="#/wiki">
            ← Wiki overview
          </a>
          {sidebarSections(sections).map((section) => (
            <section key={section.name}>
              <h3 className="section-name">
                <a href={`#/docs/${section.name}`}>{section.name}</a>
              </h3>
              <ul>
                {section.items.map((item) => (
                  <li key={item.path}>
                    <a
                      href={`#/c/${item.path}`}
                      aria-current={item.path === current ? "page" : undefined}
                      className={item.path === current ? "active" : ""}
                    >
                      {item.title ?? item.path}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </details>
      </aside>
    </div>
  );
}

// The curated log.md narrative above the raw commit feed; a bundle
// without log.md just shows the feed.
function ActivityView({ revision }: { revision: string }) {
  const params = new URLSearchParams(hashQuery(location.hash));
  const tab =
    params.get("tab") === "git"
      ? "git"
      : params.get("tab") === "source"
        ? "source"
        : "log";
  const task = params.get("task") ?? "";
  const update = (key: string, value: string) => {
    if (value) params.set(key, value);
    else params.delete(key);
    if (key === "task") params.delete("page");
    history.pushState(null, "", `#/activity${params.size ? `?${params}` : ""}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  const [page, setPage] = usePage(hashQuery(location.hash));
  const { data, error } = useLiveJson<{
    activity: ActivityEntry[];
    git: GitEvidence;
    log: string;
    logPath?: string;
    page?: PageInfo;
  }>(`/api/activity?page=${page}&task=${encodeURIComponent(task)}`, revision);
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;
  return (
    <div>
      <header className="view-heading">
        <h1>Activity</h1>
        <p className="muted">The authored project log and its Git evidence.</p>
      </header>
      <fieldset
        className="view-segments activity-tabs"
        aria-label="Activity view"
      >
        <button
          type="button"
          aria-pressed={tab === "log"}
          onClick={() => update("tab", "log")}
        >
          Project log
        </button>
        <button
          type="button"
          aria-pressed={tab === "git"}
          onClick={() => update("tab", "git")}
        >
          Git history
        </button>
        <button
          type="button"
          aria-pressed={tab === "source"}
          onClick={() => update("tab", "source")}
        >
          Source
        </button>
      </fieldset>
      {error && <ErrorNote message={error} />}
      {tab !== "git" &&
        (data.logPath ? (
          <SourceReader
            path={data.logPath}
            revision={revision}
            readable={tab === "log"}
          />
        ) : (
          <p className="muted">
            No project log is available.{" "}
            <button type="button" onClick={() => update("tab", "git")}>
              View Git history
            </button>
          </p>
        ))}
      {tab === "git" && (
        <>
          <div className="filters">
            <input
              aria-label="Filter Git history by task"
              placeholder="Task ID"
              value={task}
              onChange={(e) => update("task", e.target.value)}
            />
          </div>
          <h2 className="section-title">Integrated commits</h2>
          {data.activity.length === 0 ? (
            <p className="muted">nothing here</p>
          ) : (
            <ActivityFeed entries={data.activity} />
          )}
          <Pager page={data.page} onPage={setPage} label="Git evidence pages" />
          {data.git.status === "history-unavailable" ? (
            <p className="muted">
              Local Git evidence unavailable:{" "}
              {data.git.reason ?? "unknown reason"}
            </p>
          ) : (
            <>
              {data.git.reason && <p className="muted">{data.git.reason}</p>}
              {data.git.truncated && (
                <p className="muted">Additional local evidence was omitted.</p>
              )}
              {data.git.unmergedActivity.length > 0 && (
                <section>
                  <h2 className="section-title">Unmerged Git evidence</h2>
                  <UnmergedActivityFeed entries={data.git.unmergedActivity} />
                </section>
              )}
              {data.git.worktrees.some(
                (worktree) =>
                  !worktree.current &&
                  (!worktree.available ||
                    worktree.dirty ||
                    worktree.activeTaskId ||
                    worktree.mergedIntoCurrentHead === false),
              ) && (
                <section>
                  <h2 className="section-title">
                    Linked worktrees needing attention
                  </h2>
                  <ul>
                    {data.git.worktrees
                      .filter(
                        (worktree) =>
                          !worktree.current &&
                          (!worktree.available ||
                            worktree.dirty ||
                            worktree.activeTaskId ||
                            worktree.mergedIntoCurrentHead === false),
                      )
                      .slice(0, 10)
                      .map((worktree) => (
                        <li key={worktree.path}>
                          <code>
                            {worktree.ref ?? worktree.head.slice(0, 7)}
                          </code>{" "}
                          {worktree.path}
                          <span className="muted">
                            {worktree.activeTaskId
                              ? ` — active ${worktree.activeTaskId}`
                              : ""}
                            {worktree.dirty ? " — dirty" : ""}
                            {!worktree.available ? " — unavailable" : ""}
                          </span>
                        </li>
                      ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function ChildTasks({
  items,
  title,
}: {
  items: (GraphRef & { ready: boolean })[];
  title: string;
}) {
  if (!items.length) return null;
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <ul className="items">
        {items.map((child) => (
          <li key={child.id}>
            <a href={workHref(child)}>
              {child.title ?? child.path}{" "}
              <code className="muted">{child.id}</code>
            </a>
            {child.status && <Chip kind={child.status}>{child.status}</Chip>}
            {child.ready && <Chip kind="ready">ready</Chip>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConceptView({
  path,
  ticket,
  anchor,
  revision,
}: {
  path: string;
  ticket?: string;
  anchor?: string;
  revision: string;
}) {
  const [page, setPage] = usePage(hashQuery(location.hash));
  const {
    data: concept,
    error,
    load,
  } = useLiveJson<Concept>(
    `/api/${ticket === undefined ? `concept/${path.split("/").map(encodeURIComponent).join("/")}` : `work/${encodeURIComponent(ticket)}`}?page=${page}`,
    revision,
  );
  const [editError, setEditError] = useState<string>();
  const [editorAction, setEditorAction] = useState<HTMLDivElement | null>(null);
  const [editingContent, setEditingContent] = useState(false);
  useEffect(() => {
    if (concept && anchor) document.getElementById(anchor)?.scrollIntoView();
  }, [concept, anchor]);
  // Tab title tracks the loaded concept; the path stands in until it arrives
  // (and stays for title-less files).
  useEffect(() => {
    const fm = concept?.fm;
    const name =
      fm?.id && fm.title ? `${fm.id} — ${fm.title}` : (fm?.title ?? path);
    document.title = `${name} · docket`;
  }, [concept, path]);

  if (error && !concept) return <ErrorNote message={error} />;
  if (!concept) return <p className="muted">loading…</p>;

  const fm = concept.fm;
  const graph = concept.graph;
  // Work items (graph is non-null only for them) edit in place; docs and
  // decisions keep their read-only chips.
  const editable = graph !== null && !!fm?.id && !!fm.status;
  const edit = async (field: EditField, to: string | null) => {
    if (!fm?.id) return;
    setEditError(await postEdit(fm.id, field, to));
    load();
  };
  return (
    <div>
      {fm && (
        <header className="concept-head">
          <div className="concept-title-row">
            <h1>{fm.title ?? concept.path}</h1>
            <div ref={setEditorAction} className="concept-page-actions" />
          </div>
          <div className="chips">
            <Chip kind="type">{fm.type}</Chip>
            {fm.id && <Chip kind="id">{fm.id}</Chip>}
            {!editable && fm.status && (
              <Chip kind={fm.status}>{fm.status}</Chip>
            )}
            {concept.ready && <Chip kind="ready">ready</Chip>}
            {!editable && fm.priority && (
              <Chip kind="priority">{fm.priority}</Chip>
            )}
          </div>
          {editable && (
            <div className="edit-row">
              <label>
                status
                <select
                  className="inline-select"
                  value={fm.status}
                  onChange={(e) => void edit("status", e.target.value)}
                >
                  {concept.states.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                priority
                <select
                  className="inline-select"
                  value={fm.priority ?? "p2"}
                  onChange={(e) => void edit("priority", e.target.value)}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              {fm.type === "Task" && (
                <EpicPicker
                  current={graph?.epic ?? null}
                  revision={revision}
                  onChange={(to) => void edit("epic", to)}
                />
              )}
            </div>
          )}
          {editable && <WorkHelp />}
          {editError && <ErrorNote message={editError} />}
          {graph && graph.deps.length > 0 && (
            <div className="deps">
              <span className="muted">depends on</span>
              {graph.deps.map((dep) => (
                <a key={dep.id} className="dep" href={workHref(dep)}>
                  {dep.id}
                  {dep.status && <Chip kind={dep.status}>{dep.status}</Chip>}
                </a>
              ))}
            </div>
          )}
        </header>
      )}
      {error && <ErrorNote message={error} />}
      {fm?.type === "Epic" && graph && (
        <section className="epic-current-work">
          <ChildTasks
            items={graph.children.filter(
              (child) => child.status !== "done" && child.status !== "closed",
            )}
            title="Active tasks on this page"
          />
          <a href={`#/board?epic=${encodeURIComponent(fm.id ?? "")}`}>
            Open epic board →
          </a>
          {graph.children.length === 0 && (
            <p className="muted">No child tasks on this page.</p>
          )}
        </section>
      )}
      {concept.editing?.editable ? (
        <DocumentEditor
          key={`${concept.editScope}:${concept.path}`}
          path={concept.path}
          sourceScope={concept.editScope}
          onSaved={() => load()}
          actionContainer={editorAction}
          onEditingChange={setEditingContent}
        />
      ) : (
        <p className="muted" role="status">
          Read-only here.{" "}
          {concept.editing?.reason ??
            "Use the source file’s own workflow to make changes."}
        </p>
      )}
      <div hidden={editingContent}>
        {concept.sourcePath ? (
          <SourceReader
            path={concept.sourcePath}
            revision={revision}
            anchor={anchor}
          />
        ) : (
          <Markdown html={concept.html} />
        )}
      </div>
      <Pager
        page={concept.relationPage}
        onPage={setPage}
        label="Concept relationships and history pages"
      />
      {concept.verification && (
        <VerifiedByCard verification={concept.verification} />
      )}
      {graph && (
        <ChildTasks
          items={graph.children.filter(
            (child) => child.status === "done" || child.status === "closed",
          )}
          title="Completed and closed tasks on this page"
        />
      )}
      {concept.activity.length > 0 && (
        <section>
          <h2 className="section-title">Activity</h2>
          <ul className="activity">
            {concept.activity.map((a) => (
              <li key={a.sha}>
                <code>{a.sha.slice(0, 7)}</code>
                <span className="muted"> {a.date.slice(0, 10)} </span>
                {a.subject}
              </li>
            ))}
          </ul>
        </section>
      )}
      {concept.unmergedActivity.length > 0 && (
        <section>
          <h2 className="section-title">Unmerged Git evidence</h2>
          <UnmergedActivityFeed entries={concept.unmergedActivity} />
        </section>
      )}
      {concept.backlinks.length > 0 && (
        <section>
          <h2 className="section-title">Linked from</h2>
          <ul>
            {concept.backlinks.map((b) => (
              <li key={b.path}>
                <a href={conceptHref(b)}>{b.title ?? b.path}</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// The command palette absorbs topbar search rather than
// living beside it — one overlay fronts core's ranked engine plus view
// navigation, and the topbar keeps only a search-shaped button that opens
// it. "/" or cmd/ctrl-k from anywhere; escape restores focus to wherever it
// was; results are plain anchors so the mouse still works.
function Palette({ sections }: { sections: string[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [resultPage, setResultPage] = useState(1);
  const [searchPage, setSearchPage] = useState<PageInfo>();
  useEffect(() => {
    void q;
    setResultPage(1);
  }, [q]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const searchGate = useRef(createRequestGate());
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    if (open) {
      inputRef.current?.focus();
      return;
    }
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setQ("");
    setHits([]);
    setSearchState("idle");
    setSearchPage(undefined);
    setResultPage(1);
    setActive(0);
    setOpen(true);
  }, [open]);
  const hide = (restoreFocus: boolean) => {
    searchGate.current.cancel();
    setOpen(false);
    if (restoreFocus) restoreRef.current?.focus();
    else queueMicrotask(() => document.querySelector("main")?.focus());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable);
      if (
        (e.key === "/" && !typing) ||
        (e.key === "k" && (e.metaKey || e.ctrlKey))
      ) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || !q.trim()) {
      setHits([]);
      setActive(0);
      setSearchState("idle");
      return;
    }
    setSearchState("loading");
    const current = searchGate.current.begin();
    const controller = new AbortController();
    const t = setTimeout(() => {
      getJson<{ hits: SearchHit[]; page: PageInfo }>(
        `/api/search?q=${encodeURIComponent(q)}&page=${resultPage}&limit=10`,
        controller.signal,
      )
        .then((d) => {
          if (!current()) return;
          setHits(d.hits);
          setSearchPage(d.page);
          setActive(0);
          setSearchState("idle");
        })
        .catch(() => {
          if (current()) setSearchState("error");
        });
    }, 150);
    return () => {
      clearTimeout(t);
      controller.abort();
      searchGate.current.cancel();
    };
  }, [q, open, resultPage]);

  const views = viewCatalog(sections).map((item) =>
    ["Board", "Tasks", "Epics"].includes(item.label)
      ? { ...item, hash: rememberedView(item.label.toLowerCase()) }
      : item,
  );
  const items = paletteItems(views, hits, q);
  // The view rows update synchronously with q while hits lag the fetch, so
  // the active index can briefly point past the end — clamp, don't trust it.
  const sel = Math.max(0, Math.min(active, items.length - 1));

  useEffect(() => {
    void open;
    void active;
    void hits;
    dialogRef.current
      ?.querySelector(".palette-results a.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open, hits]);
  const groupFor = (item: PaletteItem | undefined) =>
    !item
      ? ""
      : item.kind === "concept"
        ? "Concepts"
        : item.hash.startsWith("#/docs")
          ? "Wiki sections"
          : "Workspace";
  const modalKeys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      hide(true);
    }
    if (e.key !== "Tab") return;
    const elements = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "input, a[href], button:not(:disabled)",
      ) ?? []),
    ];
    const first = elements[0],
      last = elements.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  const go = (item: PaletteItem) => {
    location.hash = itemHash(item);
    hide(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(sel + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(sel - 1, 0));
    } else if (e.key === "Enter" && items[sel]) {
      go(items[sel]);
    }
  };

  return (
    <>
      <button
        type="button"
        className="palette-open"
        aria-label="open command palette"
        title="Search — / or ⌘ K"
        onClick={show}
      >
        <Icon name="Search" />
        <span className="nav-label">
          Search <kbd>⌘ K</kbd>
        </span>
      </button>
      {open && (
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-away; escape is the keyboard path
        <div
          className="palette-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) hide(true);
          }}
        >
          <div
            ref={dialogRef}
            className="palette"
            role="dialog"
            aria-label="command palette"
            aria-modal="true"
            onKeyDown={modalKeys}
          >
            <input
              ref={inputRef}
              value={q}
              placeholder="jump to a concept or view…"
              aria-label="search concepts and views"
              onChange={(e) => {
                searchGate.current.cancel();
                setQ(e.target.value);
                setSearchPage(undefined);
                setHits([]);
                setActive(0);
                setSearchState(e.target.value.trim() ? "loading" : "idle");
              }}
              onKeyDown={onKeyDown}
            />
            <div className="palette-status muted" role="status">
              {searchState === "loading" && (
                <>
                  <span className="palette-spinner" aria-hidden="true" />
                  Searching…
                </>
              )}
              {searchState === "error" && "Search failed. Try again."}
            </div>
            <ul
              className="palette-results"
              aria-busy={searchState === "loading"}
            >
              {items.map((item, i) => (
                <li key={itemHash(item)}>
                  {(i === 0 || groupFor(items[i - 1]) !== groupFor(item)) && (
                    <div className="palette-group">{groupFor(item)}</div>
                  )}
                  <a
                    href={itemHash(item)}
                    className={i === sel ? "active" : ""}
                    onClick={() => hide(false)}
                    onMouseEnter={() => setActive(i)}
                  >
                    {item.kind === "view" ? (
                      <span className="hit-title">
                        <Icon
                          name={
                            item.hash.startsWith("#/docs") ? "Wiki" : item.label
                          }
                        />
                        {item.label}
                      </span>
                    ) : (
                      <>
                        <span className="hit-title">
                          {item.title ?? item.path}
                        </span>
                        <span className="hit-meta muted">
                          {item.type ?? "Concept"}
                          {item.id ? ` · ${item.id}` : ""}
                        </span>
                        <span className="hit-text muted">{item.text}</span>
                      </>
                    )}
                  </a>
                </li>
              ))}
              {items.length === 0 && searchState === "idle" && (
                <li className="palette-empty muted">no matches</li>
              )}
            </ul>
            <p className="sr-only" role="status">
              {items[sel]
                ? `Selected: ${items[sel]?.kind === "view" ? (items[sel] as { label: string }).label : (items[sel] as { title?: string }).title}`
                : ""}
            </p>
            {q.trim() && (
              <Pager
                page={searchPage}
                onPage={setResultPage}
                label="Search result pages"
                disabled={searchState === "loading"}
              />
            )}
            <footer className="palette-help muted">
              ↑ ↓ Navigate · Enter Open · Esc Close
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

// Header count: terminal columns are capped server-side, so say what's hidden.
const _columnCount = (data: BoardData, state: string): string => {
  const shown = data.cards.filter((c) => c.status === state).length;
  const total = data.totals[state] ?? shown;
  return total > shown ? `latest ${shown} of ${total}` : String(total);
};

// Per-column sort choices survive data refreshes (React state) and page
// reloads (localStorage) — client-side only.
const SORT_KEY = "docket.board.sort";

function loadSorts(): Record<string, SortMode> {
  try {
    return JSON.parse(localStorage.getItem(SORT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

// One status column — the flat board and each swimlane render through this,
// so drag-to-move and the per-column sort control work identically in both.
function Column({
  state,
  cards,
  count,
  mode,
  onCycle,
  onMove,
  onReorder,
  page,
  onPage,
  loading,
  collapsed,
  onExpand,
}: {
  collapsed: boolean;
  onExpand: () => void;
  page?: PageInfo;
  onPage: (page: number) => void;
  loading: boolean;
  state: string;
  cards: BoardCard[];
  count: string;
  mode: SortMode;
  onCycle: () => void;
  onMove: (id: string, to: string) => void;
  onReorder: (id: string, beforeId: string | null, afterId?: string) => void;
}) {
  // A drop from inside the column reorders; one from another column
  // keeps moving status. Membership decides — no dragged-state bookkeeping.
  const drop = (id: string, beforeId: string | null, afterId?: string) =>
    cards.some((c) => c.id === id)
      ? onReorder(id, beforeId, afterId)
      : onMove(id, state);
  const dropped = (e: React.DragEvent): string => {
    e.preventDefault();
    return e.dataTransfer.getData("text/plain");
  };
  return (
    <div
      className={`column${collapsed ? " column-collapsed" : ""}`}
      role="listbox"
      aria-label={`${state} column`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const id = dropped(e);
        if (id) drop(id, null);
      }}
    >
      {collapsed ? (
        <button
          className="expand-column"
          type="button"
          onClick={onExpand}
          aria-label={`Expand ${state} column`}
        >
          {state.replaceAll("-", " ")} · 0
        </button>
      ) : (
        <>
          <h3>
            {state.replaceAll("-", " ")} <span className="muted">{count}</span>
            <button
              type="button"
              className="sort"
              title="cycle sort: default / priority / recency / id"
              aria-label={`sort ${state} column`}
              onClick={onCycle}
            >
              {modeLabel(mode)}
            </button>
          </h3>
          {page && page.total > page.limit && (
            <Pager
              page={page}
              onPage={onPage}
              label={`${state} task pages`}
              disabled={loading}
            />
          )}
          {cards.map((card, i, displayed) => (
            <a
              key={card.id}
              className="card"
              href={workHref(card)}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("text/plain", card.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.stopPropagation();
                const id = dropped(e);
                if (!id) return;
                // Pointer height decides above/below the target, so dragging a
                // card one slot down (onto its neighbor's lower half) works.
                const rect = e.currentTarget.getBoundingClientRect();
                const below = e.clientY > rect.top + rect.height / 2;
                drop(
                  id,
                  below ? (displayed[i + 1]?.id ?? null) : card.id,
                  below ? card.id : undefined,
                );
              }}
            >
              <span className="card-title">{card.title}</span>
              <span className="card-id">
                {card.id}
                {card.priority && <Chip kind="priority">{card.priority}</Chip>}
              </span>
            </a>
          ))}
          {cards.length === 0 && (
            <p className="column-empty muted">
              No tasks here. Drop a card to move it.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Board: drag between columns, per-column sort, and
// filters + optional epic swimlanes. Filter/grouping state lives in the URL
// hash query; the per-column sort stays a local
// preference in localStorage.
function BoardView({ query, revision }: { query: string; revision: string }) {
  const [expandedEmpty, setExpandedEmpty] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [writeError, setWriteError] = useState<string>();
  const [sorts, setSorts] = useState<Record<string, SortMode>>(loadSorts);
  const [state, setState] = useState<BoardState>(() => parseBoardState(query));
  const [page, setPage] = usePage(query);
  const columnParams = new URLSearchParams(
    [...new URLSearchParams(query)].filter(([key]) =>
      key.startsWith("column."),
    ),
  );
  const setColumnPage = (status: string, number: number) => {
    const params = new URLSearchParams(query);
    params.set(`column.${status}`, String(number));
    history.pushState(null, "", `#/board?${params}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  const {
    data,
    error: loadError,
    loading,
    load,
  } = useLiveJson<BoardData>(
    "/api/board?" +
      boardStateQuery(state) +
      "&page=" +
      page +
      "&sorts=" +
      encodeURIComponent(JSON.stringify(sorts)) +
      "&" +
      columnParams,
    revision,
  );
  const cycleSort = (state: string) => {
    setPage(1, false);
    const next = { ...sorts, [state]: nextMode(sorts[state] ?? null) };
    setSorts(next);
    writePreference(SORT_KEY, JSON.stringify(next));
    const params = new URLSearchParams(query);
    for (const key of [...params.keys()])
      if (key.startsWith("column.")) params.delete(key);
    params.delete("page");
    history.replaceState(null, "", `#/board${params.size ? `?${params}` : ""}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  useEffect(() => setState(parseBoardState(query)), [query]);

  const update = (patch: Partial<BoardState>) => {
    const next = { ...state, ...patch };
    setState(next);
    setPage(1, false);
    const qs = boardStateQuery(next);
    history.replaceState(null, "", qs ? `#/board?${qs}` : "#/board");
  };

  const post = async (url: string, to: unknown) => {
    try {
      const note =
        url.endsWith("/status") && to === "closed"
          ? window.prompt("Why is this work being closed without completion?")
          : undefined;
      if (url.endsWith("/status") && to === "closed" && !note?.trim()) {
        setWriteError(
          "Closing without completion requires a disposition note.",
        );
        return;
      }
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Docket-Trigger": "explicit",
        },
        body: JSON.stringify({ to, ...(note ? { note: note.trim() } : {}) }),
      });
      if (!res.ok) setWriteError((await res.json()).error);
      else setWriteError(undefined);
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : String(e));
    }
    load();
  };

  const move = async (id: string, to: string) => {
    // A drop on the same status in another swimlane has nothing to change.
    if (data?.cards.find((c) => c.id === id)?.status === to) return;
    await post(`/api/tasks/${id}/status`, to);
  };

  // Same-column drop: persist the neighbor-midpoint rank. Only the
  // default (manual) order can be reordered by hand — a sorted column would
  // snap the card somewhere else on refresh.
  const reorder = async (
    lane: BoardCard[],
    colState: string,
    id: string,
    beforeId: string | null,
    afterId?: string,
  ) => {
    if ((sorts[colState] ?? null) !== null) {
      setWriteError(
        "column is sorted — set its sort control back to ⇅ to reorder",
      );
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${id}/reorder`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Docket-Trigger": "explicit",
        },
        body: JSON.stringify({
          beforeId,
          afterId,
          status: colState,
          query: boardStateQuery(state),
          ...(state.group ? { epic: lane[0]?.epic?.id ?? "" } : {}),
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      setWriteError(undefined);
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
    }
    load();
  };

  const error = writeError ?? loadError;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;

  const terminal = (status: string) => status === "done" || status === "closed";
  const visibleStates = data.states.filter(
    (status) =>
      dragging ||
      state.visibility === "all" ||
      (state.visibility === "completed" ? terminal(status) : !terminal(status)),
  );
  const shown = data.cards.filter((card) =>
    visibleStates.includes(card.status),
  );
  const totalFor = (completed: boolean) =>
    data.columns
      ?.filter((column) => terminal(column.status) === completed)
      .reduce((sum, column) => sum + column.page.total, 0) ?? 0;
  const filtered = !!(state.epic || state.tag || state.assignee);
  const countFor = (status: string, cards: BoardCard[]) => {
    const total =
      data.columns?.find((column) => column.status === status)?.page.total ??
      cards.length;
    return `${cards.length} of ${total}`;
  };
  const columns = (
    cards: BoardCard[],
    count: (s: string, c: BoardCard[]) => string,
  ) =>
    visibleStates.map((s) => {
      const colCards = cards.filter((c) => c.status === s);
      return (
        <Column
          key={s}
          state={s}
          cards={colCards}
          count={count(s, colCards)}
          page={
            state.group
              ? undefined
              : data.columns?.find((column) => column.status === s)?.page
          }
          onPage={(page) => setColumnPage(s, page)}
          loading={loading}
          collapsed={
            !dragging &&
            state.collapseEmpty &&
            !expandedEmpty.includes(s) &&
            colCards.length === 0 &&
            (!data.columns?.find((column) => column.status === s)?.page.total ||
              state.group)
          }
          onExpand={() => setExpandedEmpty((statuses) => [...statuses, s])}
          mode={sorts[s] ?? null}
          onCycle={() => cycleSort(s)}
          onMove={(id, to) => void move(id, to)}
          onReorder={(id, beforeId, afterId) =>
            void reorder(colCards, s, id, beforeId, afterId)
          }
        />
      );
    });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: observes bubbling card drag lifecycle; linked concept provides keyboard status editing
    <div
      className="board-view"
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      onDropCapture={() => setDragging(false)}
    >
      <header className="view-heading">
        <h1>Board</h1>
        <p className="muted">
          {state.epic ? `Epic ${state.epic}` : "Project-wide work"} · Open a
          card to edit its status.
        </p>
      </header>
      <div className="board-toolbar">
        <fieldset className="view-segments" aria-label="Workflow visibility">
          <button
            type="button"
            aria-pressed={state.visibility === "active"}
            onClick={() => update({ visibility: "active" })}
          >
            Active <span>{totalFor(false)}</span>
          </button>
          <button
            type="button"
            aria-pressed={state.visibility === "completed"}
            onClick={() => update({ visibility: "completed" })}
          >
            Done &amp; Closed <span>{totalFor(true)}</span>
          </button>
          <button
            type="button"
            aria-pressed={state.visibility === "all"}
            onClick={() => update({ visibility: "all" })}
          >
            All states
          </button>
        </fieldset>
        <label className="group-toggle">
          <input
            type="checkbox"
            checked={state.collapseEmpty}
            onChange={(e) => {
              setExpandedEmpty([]);
              update({ collapseEmpty: e.target.checked });
            }}
          />{" "}
          Collapse empty columns
        </label>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="filters">
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh board"
          title="Refresh board"
          disabled={loading}
          onClick={() => load()}
        >
          <Icon name="Refresh" />
        </button>
        <span className="refresh-status muted" role="status">
          {loading ? "Refreshing…" : ""}
        </span>
        <FacetInput
          field="epic"
          label="filter by epic"
          value={state.epic}
          onChange={(epic) => update({ epic })}
          revision={revision}
        />
        <FacetInput
          field="tag"
          label="filter by tag"
          value={state.tag}
          onChange={(tag) => update({ tag })}
          revision={revision}
        />
        <FacetInput
          field="assignee"
          label="filter by assignee"
          value={state.assignee}
          onChange={(assignee) => update({ assignee })}
          revision={revision}
        />
        <label className="group-toggle">
          <input
            type="checkbox"
            checked={state.group}
            onChange={(e) => update({ group: e.target.checked })}
          />
          group by epic
        </label>
        {filtered && (
          <button
            type="button"
            className="clear"
            onClick={() =>
              update({
                ...DEFAULT_BOARD,
                group: state.group,
                visibility: state.visibility,
                collapseEmpty: state.collapseEmpty,
              })
            }
          >
            clear
          </button>
        )}
        <span className="muted count">
          <a href="#/tasks">All tasks →</a>
        </span>
      </div>
      {state.group && (
        <div className="board-pages">
          {data.columns
            ?.filter(
              (column) =>
                visibleStates.includes(column.status) &&
                column.page.total > column.page.limit,
            )
            .map((column) => (
              <div key={column.status}>
                <strong>{column.status}</strong>
                <Pager
                  page={column.page}
                  onPage={(page) => setColumnPage(column.status, page)}
                  label={`${column.status} task pages across epic groups`}
                  disabled={loading}
                />
              </div>
            ))}
        </div>
      )}
      {state.group ? (
        <>
          {groupByEpic(shown).map((lane) => (
            <section key={lane.epic?.id ?? "no-epic"} className="lane">
              <h2 className="lane-title">
                {lane.epic ? (
                  <a href={workHref(lane.epic)}>
                    <code>{lane.epic.id}</code>{" "}
                    {lane.epic.title ?? lane.epic.path}
                  </a>
                ) : (
                  <span className="muted">no epic</span>
                )}
              </h2>
              <div className="board">
                {columns(lane.cards, (_, c) => String(c.length))}
              </div>
            </section>
          ))}
          {shown.length === 0 && <p className="muted">nothing matches</p>}
        </>
      ) : (
        <div className="board">{columns(shown, countFor)}</div>
      )}
    </div>
  );
}

export function EpicList({
  epics,
  states,
  onStatusChange,
}: {
  epics: EpicsData["epics"];
  states: string[];
  onStatusChange?: (id: string, status: string) => void;
}) {
  return (
    <div className="epics">
      {epics.map((epic) => (
        <article key={epic.id} className="epic">
          <div className="epic-title">
            <span className="epic-heading">
              <a href={workHref(epic)}>
                <strong>{epic.title}</strong>{" "}
                <code className="muted">{epic.id}</code>
              </a>{" "}
              {epic.status && <Chip kind={epic.status}>{epic.status}</Chip>}
              {epic.needsCleanup && (
                <span
                  className="recent-workstream-warning"
                  title="All child tasks are done but the epic is still open"
                >
                  needs cleanup
                </span>
              )}
            </span>
            <span className="muted">
              {epic.total
                ? `${epic.done} of ${epic.total} done`
                : "No child tasks yet"}
              {epic.closed > 0 ? `, ${epic.closed} closed` : ""}
            </span>
          </div>
          <div className="bar" aria-hidden="true">
            <div
              className="bar-fill"
              style={{
                width: epic.total ? `${(100 * epic.done) / epic.total}%` : 0,
              }}
            />
          </div>
          {epic.needsCleanup && (
            <div className="epic-cleanup-actions">
              <span className="muted">All child tasks are done.</span>
              <label>
                reconcile status
                <select
                  className="inline-select"
                  aria-label={`reconcile ${epic.id} status`}
                  value={epic.status ?? ""}
                  onChange={(event) =>
                    onStatusChange?.(epic.id, event.target.value)
                  }
                >
                  {states.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </label>
              <a href={workHref(epic)}>review epic</a>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

// The sort select doubles as the "active sort is visible" affordance; each
// key has a fixed natural direction (see epiclist.ts).
const EPIC_SORTS: { key: EpicSortKey; label: string }[] = [
  { key: "activity", label: "recent activity" },
  { key: "progress", label: "progress" },
  { key: "priority", label: "priority" },
  { key: "status", label: "status" },
];

// Epics page: the rollup list with filters and a visible sort.
// State lives in the URL hash query; terminal epics
// hide by default so the page leads with what's alive.
function EpicsView({ query, revision }: { query: string; revision: string }) {
  const [editError, setEditError] = useState<string>();
  const [state, setState] = useState<EpicListState>(() =>
    parseEpicListState(query),
  );
  const [page, setPage] = usePage(query);
  const { data, error, load } = useLiveJson<EpicsData>(
    `/api/epics?${epicListQuery(state)}&page=${page}`,
    revision,
  );
  useEffect(() => setState(parseEpicListState(query)), [query]);

  const update = (patch: Partial<EpicListState>) => {
    const next = { ...state, ...patch };
    setState(next);
    setPage(1, false);
    const qs = epicListQuery(next);
    history.replaceState(null, "", qs ? `#/epics?${qs}` : "#/epics");
  };

  const editStatus = async (id: string, status: string) => {
    setEditError(await postEdit(id, "status", status));
    load();
  };

  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;

  const rows = data.epics;

  const filtered = !!(state.status || state.tag || state.done || state.cleanup);
  return (
    <div>
      <header className="view-heading">
        <h1>Epics</h1>
        <p className="muted">
          Outcomes, progress, and work that still needs review.
        </p>
      </header>
      {(editError || error) && (
        <ErrorNote message={editError ?? error ?? "Refresh failed"} />
      )}
      <div className="filters">
        <select
          value={state.status}
          aria-label="filter by status"
          onChange={(e) => update({ status: e.target.value })}
        >
          <option value="">any status</option>
          {data.states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <FacetInput
          field="tag"
          label="filter by tag"
          value={state.tag}
          onChange={(tag) => update({ tag })}
          revision={revision}
        />
        <select
          value={state.sort}
          aria-label="sort epics"
          onChange={(e) => update({ sort: e.target.value as EpicSortKey })}
        >
          {EPIC_SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              sort: {s.label}
            </option>
          ))}
        </select>
        <label className="group-toggle">
          <input
            type="checkbox"
            checked={state.done}
            onChange={(e) => update({ done: e.target.checked })}
          />
          show inactive
        </label>
        <label className="group-toggle">
          <input
            type="checkbox"
            checked={state.cleanup}
            onChange={(e) => update({ cleanup: e.target.checked })}
          />
          needs cleanup
        </label>
        {filtered && (
          <button
            type="button"
            className="clear"
            onClick={() => update({ ...DEFAULT_EPICS, sort: state.sort })}
          >
            clear
          </button>
        )}
        <span className="muted count">
          {data.page?.total ?? rows.length} matching of{" "}
          {data.total ?? rows.length} epics
        </span>
      </div>
      <Pager page={data.page} onPage={setPage} label="Epic list pages" />
      <EpicList
        epics={rows}
        states={data.states}
        onStatusChange={(id, status) => void editStatus(id, status)}
      />
      {rows.length === 0 && (
        <p className="muted">{epicListEmptyMessage(state)}</p>
      )}
    </div>
  );
}

interface TasksData {
  page?: PageInfo;
  total?: number;
  states: string[];
  items: TaskRow[];
}

// All-tasks view: one filterable, sortable table over every work
// item. The URL hash query is the source of truth for filter/sort state —
// control edits replaceState (no history spam), external navigation
// (back/forward, pasted links) re-parses via the query prop.
function TaskHeading({
  k,
  label,
  state,
  update,
}: {
  k: SortKey;
  label: string;
  state: ListState;
  update: (patch: Partial<ListState>) => void;
}) {
  return (
    <th
      aria-sort={
        state.sort === k
          ? state.dir === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <button
        type="button"
        onClick={() =>
          update(
            state.sort === k
              ? { dir: state.dir === "asc" ? "desc" : "asc" }
              : { sort: k, dir: k === "id" ? "desc" : "asc" },
          )
        }
      >
        {label}
        {state.sort === k && (state.dir === "asc" ? " ↑" : " ↓")}
      </button>
    </th>
  );
}

function TasksView({ query, revision }: { query: string; revision: string }) {
  const [pendingEdits, setPendingEdits] = useState<string[]>([]);
  const [editError, setEditError] = useState<string>();
  const [state, setState] = useState<ListState>(() => parseListState(query));
  const [page, setPage] = usePage(query);
  const { data, error, load } = useLiveJson<TasksData>(
    `/api/tasks?${listStateQuery(state)}&page=${page}`,
    revision,
  );
  useEffect(() => setState(parseListState(query)), [query]);

  const edit = async (id: string, field: EditField, to: string | null) => {
    if (pendingEdits.includes(id)) return;
    setPendingEdits((ids) => [...ids, id]);
    setEditError(await postEdit(id, field, to));
    setPendingEdits((ids) => ids.filter((value) => value !== id));
    load();
  };

  const update = (patch: Partial<ListState>) => {
    const next = { ...state, ...patch };
    setState(next);
    setPage(1, false);
    const qs = listStateQuery(next);
    history.replaceState(null, "", qs ? `#/tasks?${qs}` : "#/tasks");
  };

  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;

  const rows = data.items;
  const filtered = listStateQuery({ ...state, sort: "id", dir: "desc" }) !== "";

  return (
    <div className="task-view">
      <header className="view-heading">
        <h1>Tasks</h1>
        <p className="muted">
          Every work item, with the context to move it forward.
        </p>
      </header>
      {(editError || error) && (
        <ErrorNote message={editError ?? error ?? "Refresh failed"} />
      )}
      <div className="filters">
        <input
          value={state.q}
          placeholder="filter by id or title"
          aria-label="filter tasks by text"
          onChange={(e) => update({ q: e.target.value })}
        />
        <FacetInput
          field="type"
          label="filter by type"
          value={state.type}
          onChange={(type) => update({ type })}
          revision={revision}
        />
        <select
          value={state.status}
          aria-label="filter by status"
          onChange={(e) => update({ status: e.target.value })}
        >
          <option value="">any status</option>
          {data.states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <FacetInput
          field="epic"
          label="filter by epic"
          value={state.epic}
          onChange={(epic) => update({ epic })}
          revision={revision}
        />
        <FacetInput
          field="priority"
          label="filter by priority"
          value={state.priority}
          onChange={(priority) => update({ priority })}
          revision={revision}
        />
        <FacetInput
          field="tag"
          label="filter by tag"
          value={state.tag}
          onChange={(tag) => update({ tag })}
          revision={revision}
        />
        {filtered && (
          <button
            type="button"
            className="clear"
            onClick={() => update({ ...DEFAULT_STATE })}
          >
            clear
          </button>
        )}
        <span className="muted count">
          {data.page?.total ?? rows.length} matching of{" "}
          {data.total ?? rows.length} items
        </span>
      </div>
      <Pager page={data.page} onPage={setPage} label="Task list pages" />
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the bounded table horizontally */}
      <section className="table-scroll" aria-label="Task list" tabIndex={0}>
        <table className="tasks">
          <thead>
            <tr>
              <TaskHeading
                state={state}
                update={update}
                k="title"
                label="Title"
              />
              <TaskHeading state={state} update={update} k="id" label="ID" />
              <TaskHeading
                state={state}
                update={update}
                k="status"
                label="Status"
              />
              <TaskHeading
                state={state}
                update={update}
                k="priority"
                label="Priority"
              />
              <th>Epic</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <a href={workHref(r)}>{r.title ?? r.path}</a>
                  {r.type === "Epic" && <Chip kind="type">epic</Chip>}
                  {pendingEdits.includes(r.id) && (
                    <span className="muted" role="status">
                      {" "}
                      Saving…
                    </span>
                  )}
                </td>
                <td>
                  <a href={workHref(r)}>
                    <code>{r.id}</code>
                  </a>
                </td>

                <td>
                  <select
                    className="inline-select"
                    disabled={pendingEdits.includes(r.id)}
                    aria-label={`status of ${r.id}`}
                    value={r.status}
                    onChange={(e) => void edit(r.id, "status", e.target.value)}
                  >
                    {data.states.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  {r.ready && <Chip kind="ready">ready</Chip>}
                </td>
                <td>
                  <select
                    className="inline-select"
                    disabled={pendingEdits.includes(r.id)}
                    aria-label={`priority of ${r.id}`}
                    value={r.priority}
                    onChange={(e) =>
                      void edit(r.id, "priority", e.target.value)
                    }
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {r.type === "Task" && (
                    <fieldset
                      className="inline-editor"
                      disabled={pendingEdits.includes(r.id)}
                    >
                      <EpicPicker
                        current={r.epic ? { ...r.epic, status: null } : null}
                        label={`epic of ${r.id}`}
                        revision={revision}
                        onChange={(to) => void edit(r.id, "epic", to)}
                      />
                    </fieldset>
                  )}
                </td>
                <td className="muted">{r.tags.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {rows.length === 0 && <p className="muted">nothing matches</p>}
    </div>
  );
}

export function App() {
  const route = useRoute();
  const revision = useBundleRevision();
  const [collapsed, setCollapsed] = useState(
    () => readPreference("docket.sidebar.collapsed") === "true",
  );
  const previousRoute = useRef(route);
  const [returnRoute, setReturnRoute] = useState<{
    href: string;
    label: string;
  }>();
  useEffect(() => {
    if (["board", "tasks", "epics"].includes(route.view))
      rememberView(route.view, location.hash);
    if (
      route.view === "concept" &&
      ["board", "tasks", "epics"].includes(previousRoute.current.view)
    ) {
      const view = previousRoute.current.view;
      setReturnRoute({
        href: rememberedView(view),
        label: view.charAt(0).toUpperCase() + view.slice(1),
      });
    } else if (route.view !== "concept") setReturnRoute(undefined);
    previousRoute.current = route;
  }, [route]);
  const { data: navData } = useLiveJson<{
    project: string;
    sections: string[];
  }>("/api/nav?summary=1", revision);
  const project = navData?.project ?? "docket";
  const sections = navData?.sections ?? [];

  // List-view tab titles; ConceptView owns its own once the concept loads.
  useEffect(() => {
    if (route.view === "board") document.title = "Board · docket";
    else if (route.view === "tasks") document.title = "Tasks · docket";
    else if (route.view === "epics") document.title = "Epics · docket";
    else if (route.view === "activity") document.title = "Activity · docket";
    else if (route.view === "guidance")
      document.title = "Project guidance · docket";
    else if (route.view === "wiki") document.title = "Wiki · docket";
    else if (route.view === "docs")
      document.title = route.dir ? `${route.dir} · docket` : "Docs · docket";
    else if (route.view === "home") document.title = `docket · ${project}`;
  }, [route, project]);

  // Every concept belongs to the Wiki reading context; Docs is a compatible
  // section lens inside it rather than a competing top-level destination.
  const docConcept =
    route.view === "concept" && isDocPath(route.path, sections);
  const nav = [
    { hash: "#/", label: "Home", active: route.view === "home" },
    {
      hash: rememberedView("board"),
      label: "Board",
      active: route.view === "board",
    },
    {
      hash: "#/wiki",
      label: "Wiki",
      active: ["wiki", "docs", "concept"].includes(route.view),
    },
    {
      hash: "#/guidance",
      label: "Project guidance",
      active: route.view === "guidance",
    },
    {
      hash: rememberedView("tasks"),
      label: "Tasks",
      active: route.view === "tasks",
    },
    {
      hash: rememberedView("epics"),
      label: "Epics",
      active: route.view === "epics",
    },
    {
      hash: "#/activity",
      label: "Activity",
      active: route.view === "activity",
    },
  ];

  return (
    <div className={`layout workspace${collapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="workspace-sidebar">
        <a
          className="workspace-brand"
          href="#/"
          title={`Docket · ${project}`}
          aria-label={`Docket · ${project}`}
        >
          <span className="brand-mark" aria-hidden="true">
            d
          </span>
          <span className="nav-label">
            <strong>Docket</strong>
            <small>{project}</small>
          </span>
        </a>
        <Palette sections={sections} />
        <nav className="workspace-nav" aria-label="Workspace">
          {nav.map((item) => (
            <a
              key={item.label}
              href={item.hash}
              className={item.active ? "active" : ""}
              aria-current={item.active ? "page" : undefined}
              aria-label={item.label}
              title={item.label}
            >
              <Icon name={item.label} />
              <span className="nav-label">{item.label}</span>
            </a>
          ))}
        </nav>
        <button
          className="sidebar-toggle"
          type="button"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={() => {
            setCollapsed(!collapsed);
            writePreference("docket.sidebar.collapsed", String(!collapsed));
          }}
        >
          <Icon name={collapsed ? "Expand" : "Collapse"} />
        </button>
      </aside>
      <main id="main-content" tabIndex={-1}>
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <span>{project}</span>
          <span aria-hidden="true">/</span>
          {route.view === "concept" || route.view === "docs" ? (
            <a href="#/wiki">Wiki</a>
          ) : (
            <span>{nav.find((item) => item.active)?.label}</span>
          )}
          {route.view === "docs" && route.dir && (
            <>
              <span aria-hidden="true">/</span>
              <span>{route.dir}</span>
            </>
          )}
          {route.view === "concept" && (
            <>
              <span aria-hidden="true">/</span>
              <span>Concept</span>
            </>
          )}
          {route.view === "concept" && returnRoute && (
            <a className="return-context" href={returnRoute.href}>
              ← Back to {returnRoute.label}
            </a>
          )}
        </nav>
        {route.view === "home" && <HomeView revision={revision} />}
        {route.view === "wiki" && <WikiView revision={revision} />}
        {route.view === "guidance" && <GuidanceView revision={revision} />}
        {route.view === "concept" &&
          (docConcept ? (
            <DocsShell current={route.path} revision={revision}>
              <ConceptView
                key={route.path}
                path={route.path}
                ticket={route.ticket}
                anchor={route.anchor}
                revision={revision}
              />
            </DocsShell>
          ) : (
            <ConceptView
              key={route.path}
              path={route.path}
              ticket={route.ticket}
              anchor={route.anchor}
              revision={revision}
            />
          ))}
        {route.view === "board" && (
          <BoardView query={route.query} revision={revision} />
        )}
        {route.view === "tasks" && (
          <TasksView query={route.query} revision={revision} />
        )}
        {route.view === "epics" && (
          <EpicsView query={route.query} revision={revision} />
        )}
        {route.view === "activity" && <ActivityView revision={revision} />}
        {route.view === "docs" && (
          <DocsShell dir={route.dir} revision={revision} />
        )}
      </main>
    </div>
  );
}
