// The whole SPA: hash routing, wiki pages, board with drag-to-move, epic
// rollups. Read-mostly by design — the writes are the status drag and the
// Inline field edits round-trip through the server's
// core-ops endpoints.

import {
  REENTRY_CONTEXT_V1_FORMAT,
  type StateOfPlayView,
} from "@gitdocket/core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type BoardState,
  boardStateQuery,
  DEFAULT_BOARD,
  type EpicRef,
  filterCards,
  groupByEpic,
  parseBoardState,
} from "./board";
import {
  type DocItem,
  type DocSection,
  isDocPath,
  sidebarSections,
} from "./docs";
import {
  applyEpicList,
  DEFAULT_EPICS,
  type EpicListState,
  type EpicRow,
  type EpicSortKey,
  epicListEmptyMessage,
  epicListQuery,
  parseEpicListState,
} from "./epiclist";
import { createRequestGate } from "./live";
import {
  itemHash,
  type PaletteItem,
  paletteItems,
  type SearchHit,
  viewCatalog,
} from "./palette";
import { dropRank } from "./rank";
import { modeLabel, nextMode, type SortMode, sortCards } from "./sort";
import {
  applyList,
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
  | { view: "board"; query: string }
  | { view: "epics"; query: string }
  | { view: "tasks"; query: string }
  | { view: "activity" }
  | { view: "docs"; dir: string }
  | { view: "concept"; path: string };

export function parseHashValue(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  // Tasks and board keep their filter state in the query part; URLSearchParams
  // decodes it, so it must not be pre-decoded with the rest.
  if (raw === "tasks" || raw.startsWith("tasks?"))
    return { view: "tasks", query: raw.slice("tasks?".length) };
  if (raw === "board" || raw.startsWith("board?"))
    return { view: "board", query: raw.slice("board?".length) };
  if (raw === "epics" || raw.startsWith("epics?"))
    return { view: "epics", query: raw.slice("epics?".length) };
  const h = decodeURIComponent(raw);
  if (h === "wiki") return { view: "wiki" };
  if (h === "activity") return { view: "activity" };
  // Bare #/docs is the Docs tab; #/docs/<dir> renders into the same view with
  // that section's articles up.
  if (h === "docs") return { view: "docs", dir: "" };
  if (h.startsWith("docs/")) return { view: "docs", dir: h.slice(5) };
  if (h.startsWith("c/")) return { view: "concept", path: h.slice(2) };
  return { view: "home" };
}

function parseHash(): Route {
  return parseHashValue(location.hash);
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

// Each mounted route owns one latest-only loader. Bundle revision changes and
// local writes use the same load function, so overlapping requests cannot
// publish out of order.
function useLiveJson<T>(url: string, revision: string, enabled = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const gate = useRef(createRequestGate());
  const load = useCallback(() => {
    // Reading the revision binds this loader generation to the signal even
    // though the API URL itself is stable.
    void revision;
    if (!enabled) return;
    const current = gate.current.begin();
    getJson<T>(url)
      .then((next) => {
        if (!current()) return;
        setData(next);
        setError(undefined);
      })
      .catch((e: Error) => {
        if (current()) setError(e.message);
      });
  }, [enabled, revision, url]);

  useEffect(() => {
    load();
    return () => gate.current.cancel();
  }, [load]);

  return { data, error, load };
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
  path: string;
  fm: Frontmatter | null;
  states: string[];
  ready: boolean;
  html: string;
  backlinks: { path: string; title: string | null }[];
  activity: { sha: string; date: string; subject: string }[];
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
  states: string[];
  cards: BoardCard[];
  totals: Record<string, number>;
}

interface EpicsData {
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
          href={`#/c/${current.path}`}
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, ...(note ? { note: note.trim() } : {}) }),
    });
    if (res.ok) return undefined;
    return ((await res.json()) as { error?: string }).error ?? res.statusText;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function Chip({ kind, children }: { kind: string; children: string }) {
  return (
    <span className={`chip chip-${kind.replace(/\s/g, "")}`}>{children}</span>
  );
}

function ErrorNote({ message }: { message: string }) {
  return <p className="error">{message}</p>;
}

function Markdown({ html }: { html: string }) {
  // Server-rendered through the same unified pipeline core parses with.
  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local render
  return <article className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export interface HomeData {
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

function DocList({ items }: { items: DocItem[] }) {
  return (
    <ul className="doclist">
      {items.map((item) => (
        <li key={item.path}>
          <a href={`#/c/${item.path}`}>{item.title ?? item.path}</a>
          {item.description && (
            <span className="muted"> — {item.description}</span>
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
          presented as current project context.
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
          will be replaced only by a meaningful refresh.
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
      ? "Context needs review. This last-known note remains useful, but newer evidence or time may have moved beyond it."
      : note.review.status === "age-unavailable"
        ? "Evidence age is unavailable. The note is shown with its review time, but its Git age could not be confirmed."
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

export function HomeBriefing({ data }: { data: HomeData }) {
  return (
    <div className="home">
      <section className="home-intro">
        {data.preamble ? (
          <Markdown html={data.preamble} />
        ) : (
          <h1>{data.project}</h1>
        )}
      </section>
      {data.narrative ? (
        <StateOfPlay note={data.narrative} />
      ) : (
        <p className="context-unavailable muted">
          No usable project re-entry note is available.
        </p>
      )}
    </div>
  );
}

// Home is the first-minute briefing; the git-facing index body belongs to the
// separate Wiki/Docs knowledge surfaces.
function HomeView({ revision }: { revision: string }) {
  const { data, error } = useLiveJson<HomeData>("/api/home", revision);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;

  return <HomeBriefing data={data} />;
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
              {section.items.length > previewLimit && (
                <a className="wiki-more" href={`#/docs/${section.name}`}>
                  Browse all {section.items.length} →
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
  const { data, error } = useLiveJson<{ sections: DocSection[] }>(
    "/api/docs",
    revision,
  );
  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;
  return <WikiLanding sections={data.sections} />;
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
  const { data, error } = useLiveJson<{ sections: DocSection[] }>(
    "/api/docs",
    revision,
  );
  const sections = data?.sections;
  if (error) return <ErrorNote message={error} />;
  if (!sections) return <p className="muted">loading…</p>;

  const listing = (section: DocSection) => (
    <section key={section.name}>
      <h2 className="section-title section-name">{section.name}</h2>
      <DocList items={section.items} />
    </section>
  );
  const shown = dir ? sections.filter((s) => s.name === dir) : sections;
  const main =
    children ??
    (shown.length > 0 ? (
      shown.map(listing)
    ) : (
      <ErrorNote message={`no such section: ${dir}`} />
    ));

  return (
    <div className="docs-layout">
      <aside className="docs-sidebar" aria-label="Wiki sections">
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
      </aside>
      <div className="docs-main">{main}</div>
    </div>
  );
}

// The curated log.md narrative above the raw commit feed; a bundle
// without log.md just shows the feed.
function ActivityView({ revision }: { revision: string }) {
  const { data, error } = useLiveJson<{
    activity: ActivityEntry[];
    log: string;
  }>("/api/activity", revision);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;
  return (
    <div>
      {data.log && <Markdown html={data.log} />}
      <h2 className="section-title">Commits</h2>
      {data.activity.length === 0 ? (
        <p className="muted">nothing here</p>
      ) : (
        <ActivityFeed entries={data.activity} />
      )}
    </div>
  );
}

function ConceptView({ path, revision }: { path: string; revision: string }) {
  const {
    data: concept,
    error,
    load,
  } = useLiveJson<Concept>(`/api/concept/${path}`, revision);
  const [editError, setEditError] = useState<string>();
  // Options for the epic select, fetched once a Task page loads.
  const { data: epicData } = useLiveJson<EpicsData>(
    "/api/epics",
    revision,
    concept?.fm?.type === "Task",
  );
  const epics = epicData?.epics;
  // Tab title tracks the loaded concept; the path stands in until it arrives
  // (and stays for title-less files).
  useEffect(() => {
    const fm = concept?.fm;
    const name =
      fm?.id && fm.title ? `${fm.id} — ${fm.title}` : (fm?.title ?? path);
    document.title = `${name} · docket`;
  }, [concept, path]);

  if (error) return <ErrorNote message={error} />;
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
          <h1>{fm.title ?? concept.path}</h1>
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
                <EpicEditor
                  current={graph?.epic ?? null}
                  epics={epics}
                  value={fm.epic ?? ""}
                  onChange={(to) => void edit("epic", to)}
                />
              )}
            </div>
          )}
          {editError && <ErrorNote message={editError} />}
          {graph && graph.deps.length > 0 && (
            <div className="deps">
              <span className="muted">depends on</span>
              {graph.deps.map((dep) => (
                <a key={dep.id} className="dep" href={`#/c/${dep.path}`}>
                  {dep.id}
                  {dep.status && <Chip kind={dep.status}>{dep.status}</Chip>}
                </a>
              ))}
            </div>
          )}
        </header>
      )}
      <Markdown html={concept.html} />
      {concept.verification && (
        <VerifiedByCard verification={concept.verification} />
      )}
      {graph && graph.children.length > 0 && (
        <section>
          <h2 className="section-title">Tasks</h2>
          <ul className="children">
            {graph.children.map((child) => (
              <li key={child.id}>
                <a href={`#/c/${child.path}`}>
                  <code>{child.id}</code> {child.title ?? child.path}
                </a>{" "}
                {child.status && (
                  <Chip kind={child.status}>{child.status}</Chip>
                )}
                {child.ready && <Chip kind="ready">ready</Chip>}
              </li>
            ))}
          </ul>
        </section>
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
      {concept.backlinks.length > 0 && (
        <section>
          <h2 className="section-title">Linked from</h2>
          <ul>
            {concept.backlinks.map((b) => (
              <li key={b.path}>
                <a href={`#/c/${b.path}`}>{b.title ?? b.path}</a>
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
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const show = useCallback(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setQ("");
    setHits([]);
    setActive(0);
    setOpen(true);
  }, []);
  const hide = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) restoreRef.current?.focus();
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
      return;
    }
    const t = setTimeout(() => {
      getJson<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`)
        .then((d) => {
          setHits(d.hits);
          setActive(0);
        })
        .catch(() => {});
    }, 150);
    return () => clearTimeout(t);
  }, [q, open]);

  const items = paletteItems(viewCatalog(sections), hits, q);
  // The view rows update synchronously with q while hits lag the fetch, so
  // the active index can briefly point past the end — clamp, don't trust it.
  const sel = Math.max(0, Math.min(active, items.length - 1));

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
    } else if (e.key === "Escape") {
      hide(true);
    }
  };

  return (
    <>
      <button
        type="button"
        className="palette-open"
        aria-label="open command palette"
        onClick={show}
      >
        search — / or ⌘k
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
          <div className="palette" role="dialog" aria-label="command palette">
            <input
              ref={inputRef}
              value={q}
              placeholder="jump to a concept or view…"
              aria-label="search concepts and views"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <ul className="palette-results">
              {items.map((item, i) => (
                <li key={itemHash(item)}>
                  <a
                    href={itemHash(item)}
                    className={i === sel ? "active" : ""}
                    onClick={() => hide(false)}
                    onMouseEnter={() => setActive(i)}
                  >
                    {item.kind === "view" ? (
                      <span className="hit-title">
                        {item.label}
                        <span className="muted"> — view</span>
                      </span>
                    ) : (
                      <>
                        <span className="hit-title">
                          {item.id ? `${item.id} — ` : ""}
                          {item.title ?? item.path}
                        </span>
                        <span className="hit-text muted">{item.text}</span>
                      </>
                    )}
                  </a>
                </li>
              ))}
              {items.length === 0 && (
                <li className="palette-empty muted">no matches</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

// Header count: terminal columns are capped server-side, so say what's hidden.
const columnCount = (data: BoardData, state: string): string => {
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
}: {
  state: string;
  cards: BoardCard[];
  count: string;
  mode: SortMode;
  onCycle: () => void;
  onMove: (id: string, to: string) => void;
  onReorder: (id: string, beforeId: string | null) => void;
}) {
  // A drop from inside the column reorders; one from another column
  // keeps moving status. Membership decides — no dragged-state bookkeeping.
  const drop = (id: string, beforeId: string | null) =>
    cards.some((c) => c.id === id)
      ? onReorder(id, beforeId)
      : onMove(id, state);
  const dropped = (e: React.DragEvent): string => {
    e.preventDefault();
    return e.dataTransfer.getData("text/plain");
  };
  return (
    <div
      className="column"
      role="listbox"
      aria-label={`${state} column`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const id = dropped(e);
        if (id) drop(id, null);
      }}
    >
      <h3>
        {state} <span className="muted">{count}</span>
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
      {sortCards(cards, mode).map((card, i, displayed) => (
        <a
          key={card.id}
          className="card"
          href={`#/c/${card.path}`}
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
            drop(id, below ? (displayed[i + 1]?.id ?? null) : card.id);
          }}
        >
          <span className="card-id">
            {card.id}
            {card.priority && <Chip kind="priority">{card.priority}</Chip>}
          </span>
          {card.title}
        </a>
      ))}
    </div>
  );
}

// Board: drag between columns, per-column sort, and
// filters + optional epic swimlanes. Filter/grouping state lives in the URL
// hash query; the per-column sort stays a local
// preference in localStorage.
function BoardView({ query, revision }: { query: string; revision: string }) {
  const {
    data,
    error: loadError,
    load,
  } = useLiveJson<BoardData>("/api/board", revision);
  const [writeError, setWriteError] = useState<string>();
  const [sorts, setSorts] = useState<Record<string, SortMode>>(loadSorts);
  const [state, setState] = useState<BoardState>(() => parseBoardState(query));
  const cycleSort = (state: string) => {
    const next = { ...sorts, [state]: nextMode(sorts[state] ?? null) };
    setSorts(next);
    localStorage.setItem(SORT_KEY, JSON.stringify(next));
  };
  useEffect(() => setState(parseBoardState(query)), [query]);

  const update = (patch: Partial<BoardState>) => {
    const next = { ...state, ...patch };
    setState(next);
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
        headers: { "content-type": "application/json" },
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
  ) => {
    if ((sorts[colState] ?? null) !== null) {
      setWriteError(
        "column is sorted — set its sort control back to ⇅ to reorder",
      );
      return;
    }
    const to = dropRank(lane, id, beforeId);
    if (to !== null) await post(`/api/tasks/${id}/rank`, to);
  };

  const error = writeError ?? loadError;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;

  const shown = filterCards(data.cards, state);
  const filtered = !!(state.epic || state.tag || state.assignee);
  const idNum = (id: string) => Number(id.split("-").pop());
  const epics = data.cards
    .flatMap((c) => (c.epic ? [c.epic] : []))
    .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
    .sort((a, z) => idNum(z.id) - idNum(a.id));
  const tags = [...new Set(data.cards.flatMap((c) => c.tags))].sort();
  const assignees = [
    ...new Set(data.cards.flatMap((c) => (c.assignee ? [c.assignee] : []))),
  ].sort();
  // Unfiltered flat columns keep the true totals (with terminal caps called
  // out); filtered and lane columns count what they show.
  const countFor = (colState: string, cards: BoardCard[]) =>
    filtered ? String(cards.length) : columnCount(data, colState);
  const columns = (
    cards: BoardCard[],
    count: (s: string, c: BoardCard[]) => string,
  ) =>
    data.states.map((s) => {
      const colCards = cards.filter((c) => c.status === s);
      return (
        <Column
          key={s}
          state={s}
          cards={colCards}
          count={count(s, colCards)}
          mode={sorts[s] ?? null}
          onCycle={() => cycleSort(s)}
          onMove={(id, to) => void move(id, to)}
          onReorder={(id, beforeId) => void reorder(colCards, s, id, beforeId)}
        />
      );
    });

  return (
    <div>
      {error && <ErrorNote message={error} />}
      <div className="filters">
        <select
          value={state.epic}
          aria-label="filter by epic"
          onChange={(e) => update({ epic: e.target.value })}
        >
          <option value="">any epic</option>
          {epics.map((e) => (
            <option key={e.id} value={e.id}>
              {e.id} — {e.title ?? e.path}
            </option>
          ))}
        </select>
        <select
          value={state.tag}
          aria-label="filter by tag"
          onChange={(e) => update({ tag: e.target.value })}
        >
          <option value="">any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={state.assignee}
          aria-label="filter by assignee"
          onChange={(e) => update({ assignee: e.target.value })}
        >
          <option value="">any assignee</option>
          {assignees.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
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
            onClick={() => update({ ...DEFAULT_BOARD, group: state.group })}
          >
            clear
          </button>
        )}
        <span className="muted count">
          <a href="#/tasks">All tasks →</a>
        </span>
      </div>
      {state.group ? (
        <>
          {groupByEpic(shown).map((lane) => (
            <section key={lane.epic?.id ?? "no-epic"} className="lane">
              <h2 className="lane-title">
                {lane.epic ? (
                  <a href={`#/c/${lane.epic.path}`}>
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
              <a href={`#/c/${epic.path}`}>
                <code>{epic.id}</code> {epic.title}
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
              {epic.done}/{epic.total} done
              {epic.closed > 0 ? `, ${epic.closed} closed` : ""}
            </span>
          </div>
          <div className="bar">
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
              <a href={`#/c/${epic.path}`}>review epic</a>
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
  const { data, error, load } = useLiveJson<EpicsData>("/api/epics", revision);
  const [editError, setEditError] = useState<string>();
  const [state, setState] = useState<EpicListState>(() =>
    parseEpicListState(query),
  );
  useEffect(() => setState(parseEpicListState(query)), [query]);

  const update = (patch: Partial<EpicListState>) => {
    const next = { ...state, ...patch };
    setState(next);
    const qs = epicListQuery(next);
    history.replaceState(null, "", qs ? `#/epics?${qs}` : "#/epics");
  };

  const editStatus = async (id: string, status: string) => {
    setEditError(await postEdit(id, "status", status));
    load();
  };

  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;

  const rows = applyEpicList(data.epics, state);
  const tags = [...new Set(data.epics.flatMap((e) => e.tags))].sort();
  const filtered = !!(state.status || state.tag || state.done || state.cleanup);
  return (
    <div>
      {editError && <ErrorNote message={editError} />}
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
        <select
          value={state.tag}
          aria-label="filter by tag"
          onChange={(e) => update({ tag: e.target.value })}
        >
          <option value="">any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
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
          {rows.length === data.epics.length
            ? `${rows.length} epics`
            : `${rows.length} of ${data.epics.length}`}
        </span>
      </div>
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
  states: string[];
  items: TaskRow[];
}

// All-tasks view: one filterable, sortable table over every work
// item. The URL hash query is the source of truth for filter/sort state —
// control edits replaceState (no history spam), external navigation
// (back/forward, pasted links) re-parses via the query prop.
function TasksView({ query, revision }: { query: string; revision: string }) {
  const { data, error, load } = useLiveJson<TasksData>("/api/tasks", revision);
  const [editError, setEditError] = useState<string>();
  const [state, setState] = useState<ListState>(() => parseListState(query));
  useEffect(() => setState(parseListState(query)), [query]);

  const edit = async (id: string, field: EditField, to: string | null) => {
    setEditError(await postEdit(id, field, to));
    load();
  };

  const update = (patch: Partial<ListState>) => {
    const next = { ...state, ...patch };
    setState(next);
    const qs = listStateQuery(next);
    history.replaceState(null, "", qs ? `#/tasks?${qs}` : "#/tasks");
  };

  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="muted">loading…</p>;

  const rows = applyList(data.items, data.states, state);
  const epics = data.items
    .flatMap((r) => (r.epic ? [r.epic] : []))
    .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
  // Row-edit options: every epic, not just the referenced ones the filter shows.
  const allEpics = data.items.filter((r) => r.type === "Epic");
  const priorities = [...new Set(data.items.map((r) => r.priority))].sort();
  const tags = [...new Set(data.items.flatMap((r) => r.tags))].sort();
  // Whatever work-item types the bundle holds — not a hard-coded pair.
  const types = [...new Set(data.items.map((r) => r.type))].sort();
  const filtered = listStateQuery({ ...state, sort: "id", dir: "desc" }) !== "";

  const Th = ({ k, label }: { k: SortKey; label: string }) => (
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

  return (
    <div>
      {editError && <ErrorNote message={editError} />}
      <div className="filters">
        <input
          value={state.q}
          placeholder="filter by id or title"
          aria-label="filter tasks by text"
          onChange={(e) => update({ q: e.target.value })}
        />
        <select
          value={state.type}
          aria-label="filter by type"
          onChange={(e) => update({ type: e.target.value })}
        >
          <option value="">any type</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t.toLowerCase()}
            </option>
          ))}
        </select>
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
        <select
          value={state.epic}
          aria-label="filter by epic"
          onChange={(e) => update({ epic: e.target.value })}
        >
          <option value="">any epic</option>
          {epics.map((e) => (
            <option key={e.id} value={e.id}>
              {e.id} — {e.title ?? e.path}
            </option>
          ))}
        </select>
        <select
          value={state.priority}
          aria-label="filter by priority"
          onChange={(e) => update({ priority: e.target.value })}
        >
          <option value="">any priority</option>
          {priorities.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={state.tag}
          aria-label="filter by tag"
          onChange={(e) => update({ tag: e.target.value })}
        >
          <option value="">any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
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
          {rows.length === data.items.length
            ? `${rows.length} items`
            : `${rows.length} of ${data.items.length}`}
        </span>
      </div>
      <table className="tasks">
        <thead>
          <tr>
            <Th k="id" label="ID" />
            <Th k="title" label="Title" />
            <Th k="status" label="Status" />
            <Th k="priority" label="Priority" />
            <th>Epic</th>
            <th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <a href={`#/c/${r.path}`}>
                  <code>{r.id}</code>
                </a>
              </td>
              <td>
                <a href={`#/c/${r.path}`}>{r.title ?? r.path}</a>
                {r.type === "Epic" && <Chip kind="type">epic</Chip>}
              </td>
              <td>
                <select
                  className="inline-select"
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
                  aria-label={`priority of ${r.id}`}
                  value={r.priority}
                  onChange={(e) => void edit(r.id, "priority", e.target.value)}
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
                  <select
                    className="inline-select"
                    aria-label={`epic of ${r.id}`}
                    value={r.epic ? `/${r.epic.path}` : ""}
                    onChange={(e) =>
                      void edit(r.id, "epic", e.target.value || null)
                    }
                  >
                    <option value="">no epic</option>
                    {allEpics.map((e) => (
                      <option key={e.id} value={`/${e.path}`}>
                        {e.id} — {e.title ?? e.path}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="muted">{r.tags.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">nothing matches</p>}
    </div>
  );
}

export function App() {
  const route = useRoute();
  const revision = useBundleRevision();
  const { data: navData } = useLiveJson<{
    project: string;
    sections: string[];
  }>("/api/nav", revision);
  const project = navData?.project ?? "docket";
  const sections = navData?.sections ?? [];

  // List-view tab titles; ConceptView owns its own once the concept loads.
  useEffect(() => {
    if (route.view === "board") document.title = "Board · docket";
    else if (route.view === "tasks") document.title = "Tasks · docket";
    else if (route.view === "epics") document.title = "Epics · docket";
    else if (route.view === "activity") document.title = "Activity · docket";
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
    {
      hash: "#/",
      label: "Home",
      active: route.view === "home",
    },
    {
      hash: "#/wiki",
      label: "Wiki",
      active:
        route.view === "wiki" ||
        route.view === "docs" ||
        route.view === "concept",
    },
    { hash: "#/tasks", label: "Tasks", active: route.view === "tasks" },
    { hash: "#/board", label: "Board", active: route.view === "board" },
    { hash: "#/epics", label: "Epics", active: route.view === "epics" },
    {
      hash: "#/activity",
      label: "Activity",
      active: route.view === "activity",
    },
  ];

  return (
    <div className="layout">
      <nav className="topbar">
        <a className="brand" href="#/">
          docket <span className="muted">· {project}</span>
        </a>
        <Palette sections={sections} />
        {nav.map((item) => (
          <a
            key={item.hash}
            href={item.hash}
            className={item.active ? "active" : ""}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <main>
        {route.view === "home" && <HomeView revision={revision} />}
        {route.view === "wiki" && <WikiView revision={revision} />}
        {route.view === "concept" &&
          (docConcept ? (
            <DocsShell current={route.path} revision={revision}>
              <ConceptView
                key={route.path}
                path={route.path}
                revision={revision}
              />
            </DocsShell>
          ) : (
            <ConceptView
              key={route.path}
              path={route.path}
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
