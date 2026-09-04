// The Hono app: a thin JSON API over core plus the SPA shell. Every write
// goes through core ops (setStatus, setPriority, setEpic) — the same single
// write path as the CLI and MCP server — so the Phase 4 team UI is a client
// change, not a rewrite.

import type { Database } from "bun:sqlite";
import {
  type Bundle,
  isStatus,
  isTerminalStatus,
  parseStateOfPlay,
  presentStateOfPlay,
  REENTRY_CONTEXT_FORMAT,
  REENTRY_CONTEXT_V1_FORMAT,
  renderIndex,
  resolveLink,
  STATE_OF_PLAY_PATH,
  searchBundle,
  setEpic,
  setPriority,
  setRank,
  setStatus,
  type WorkItem,
} from "@gitdocket/core";
import { taskLinkedCommitsSince } from "@gitdocket/core/cache";
import { deriveOverview, epicNeedsCleanup } from "@gitdocket/core/overview";
import { Hono } from "hono";
import type { Committer } from "./commit";
import { renderMarkdown } from "./render";
import type { RepoContext } from "./state";

const LOCAL_REQUEST_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Keep the repository API local even if a browser is tricked by DNS rebinding,
 * and reject cross-site browser writes. Origin-less local clients remain valid.
 */
export function localRequestBoundary(request: Request): string | undefined {
  const target = new URL(request.url);
  if (!LOCAL_REQUEST_HOSTS.has(target.hostname))
    return "docket serve accepts requests from this computer only";

  if (SAFE_HTTP_METHODS.has(request.method.toUpperCase())) return undefined;
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  try {
    if (new URL(origin).origin === target.origin) return undefined;
  } catch {
    // Malformed and opaque (`null`) origins are not trusted write callers.
  }
  return "docket serve rejects cross-origin writes";
}

export interface Assets {
  js: string;
  css: string;
}

export interface AppOptions {
  /** When set (serve --commit), every successful write commits. */
  commit?: Committer;
  /** Test seam for deterministic age-based product-context presentation. */
  now?: Date;
}

interface BoardRow {
  status: string;
  priority: string | null;
  rank: number | null;
  id: string;
  title: string | null;
  path: string;
  timestamp: string | null;
}

/** The task's epic as an identity ref, or null — shared by board and tasks. */
function epicRefOf(bundle: Bundle, w: WorkItem) {
  const target =
    typeof w.fm.epic === "string" ? resolveLink(w.path, w.fm.epic) : undefined;
  const parent = target
    ? bundle.concepts.find((k) => k.path === target)
    : undefined;
  return parent?.kind === "work"
    ? {
        path: parent.path,
        id: parent.fm.id,
        title: parent.fm.title ?? null,
      }
    : null;
}

/** Cards shown per terminal board column — older history lives in Git and the wiki. */
const TERMINAL_LIMIT = 15;

interface RollupRow {
  path: string;
  id: string;
  title: string | null;
  status: string | null;
  priority: string | null;
  total: number;
  done: number;
  closed: number;
  lastActivity: string;
}

// Tags ride from the bundle — the cache stores no list fields.
function epicTags(
  bundle: Bundle,
  rows: RollupRow[],
): (RollupRow & { tags: string[]; needsCleanup: boolean })[] {
  const tags = new Map(
    bundle.concepts
      .filter((k): k is WorkItem => k.kind === "work")
      .map((w) => [w.path, w.fm.tags]),
  );
  return rows.map((r) => ({
    ...r,
    tags: tags.get(r.path) ?? [],
    needsCleanup: epicNeedsCleanup(r.status, {
      done: r.done,
      total: r.total,
    }),
  }));
}

interface ActivityRow {
  sha: string;
  date: string;
  subject: string;
}

/** Work-graph context for a concept page — identity refs only. */
interface GraphRef {
  path: string;
  id: string;
  title: string | null;
  status: string | null;
}

interface ConceptGraph {
  epic: GraphRef | null;
  deps: GraphRef[];
  children: (GraphRef & { ready: boolean })[];
}

interface VerificationSourceRef {
  path: string;
  line: number;
}

interface VerificationAnchorGroup {
  anchor: string | null;
  sources: VerificationSourceRef[];
}

interface VerificationKindGroup {
  kind: string;
  anchors: VerificationAnchorGroup[];
}

interface VerificationRow {
  kind: string;
  source: string;
  line: number;
  anchor: string | null;
}

/** Presence-only verification groups for one concept; results never enter this shape. */
function verificationGroups(
  db: Database,
  path: string,
): VerificationKindGroup[] {
  const rows = db
    .query(
      `SELECT kind, source_path AS source, line, anchor
       FROM verifications WHERE concept_path = ?
       ORDER BY kind, anchor IS NOT NULL, anchor, source_path, line`,
    )
    .all(path) as VerificationRow[];
  const kinds = new Map<string, Map<string | null, VerificationSourceRef[]>>();
  for (const row of rows) {
    const anchors = kinds.get(row.kind) ?? new Map();
    const sources = anchors.get(row.anchor) ?? [];
    sources.push({ path: row.source, line: row.line });
    anchors.set(row.anchor, sources);
    kinds.set(row.kind, anchors);
  }
  return [...kinds].map(([kind, anchors]) => ({
    kind,
    anchors: [...anchors].map(([anchor, sources]) => ({ anchor, sources })),
  }));
}

// Epic lists (home strip and the epics page) share one order: open epics
// before terminal ones, most recent status transition first within each.
const EPICS_SQL = `SELECT c.path, c.id, c.title, c.status, c.priority,
         r.total, r.done, r.closed, r.last_activity AS lastActivity
  FROM epic_rollup r JOIN concepts c ON c.id = r.epic_id
  ORDER BY c.status IN ('done', 'closed'), r.last_activity DESC, c.id`;

// Doc sections in reading order; unknown directories trail.
const SECTION_ORDER = ["specs", "decisions", "workflows", "reference"];
const sectionRank = (name: string): number => {
  const i = SECTION_ORDER.indexOf(name);
  return i === -1 ? SECTION_ORDER.length : i;
};

// The file-facing preamble can contain maintenance directions for the
// generated index body. Home renders neither that body nor its marker, so
// those directions are noise in the composed briefing.
function homePreamble(source: string): string {
  const authored = source.split("<!-- docket:generated -->")[0] ?? "";
  return authored
    .split(/\n{2,}/)
    .filter(
      (block) =>
        !/docket index|edit nothing|generated.{0,40}marker|marker.{0,40}generated/i.test(
          block,
        ),
    )
    .join("\n\n")
    .trim();
}

interface DocItem {
  path: string;
  title: string | null;
  description: string | null;
}

// Docs grouped by top-level directory, work items excluded. Items sort
// newest-first by frontmatter timestamp (unstamped files trail, by path) so
// listings lead with what changed last.
function docSections(bundle: Bundle): Map<string, DocItem[]> {
  const sections = new Map<string, (DocItem & { ts: string })[]>();
  for (const concept of bundle.concepts) {
    if (concept.kind === "work") continue;
    const dir = concept.path.includes("/")
      ? (concept.path.split("/")[0] ?? "")
      : "";
    if (!dir) continue; // reserved root files: index.md, log.md
    const fm = concept.fm as {
      title?: string;
      description?: string;
      timestamp?: string;
    };
    const list = sections.get(dir) ?? [];
    list.push({
      path: concept.path,
      title: fm.title ?? null,
      description: fm.description ?? null,
      ts: typeof fm.timestamp === "string" ? fm.timestamp : "",
    });
    sections.set(dir, list);
  }
  return new Map(
    [...sections.entries()].map(([name, items]) => [
      name,
      items
        .sort(
          (a, z) => z.ts.localeCompare(a.ts) || a.path.localeCompare(z.path),
        )
        .map(({ ts: _, ...item }) => item),
    ]),
  );
}

const page = (assets: Assets): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>docket</title>
<style>${assets.css}</style>
</head>
<body><div id="root"></div><script type="module" src="/assets/app.js"></script></body>
</html>
`;

export function createApp(
  ctx: RepoContext,
  assets?: Assets,
  appOpts: AppOptions = {},
): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const error = localRequestBoundary(c.req.raw);
    if (error) return c.json({ error }, 403);
    await next();
  });

  // Wiki nav: the generated index rendered like any other page. Falls back to
  // an in-memory render so serve works before `docket index` has ever run.
  app.get("/api/nav", async (c) => {
    const { bundle } = await ctx.state();
    const source = await ctx.store
      .read("index.md")
      .catch(() => renderIndex(bundle));
    // Doc directories in reading order — the command palette lists
    // them as navigation targets.
    const sections = [...docSections(bundle).keys()].sort(
      (a, z) => sectionRank(a) - sectionRank(z) || a.localeCompare(z),
    );
    return c.json({
      project: ctx.config.project,
      html: renderMarkdown("index.md", source),
      sections,
    });
  });

  // Composed home briefing. index.md stays the
  // git-facing artifact; only its hand-written preamble renders here.
  app.get("/api/home", async (c) => {
    const { bundle, db, git } = await ctx.state();

    const source = await ctx.store.read("index.md").catch(() => "");
    const preamble = homePreamble(source);

    const narrativeSource = await ctx.store
      .read(STATE_OF_PLAY_PATH)
      .catch(() => undefined);
    const note = narrativeSource
      ? parseStateOfPlay(narrativeSource).note
      : undefined;
    const narrative = note
      ? (() => {
          const presented = presentStateOfPlay(
            note,
            taskLinkedCommitsSince(ctx.root, ctx.config.git.trailer, note.asOf),
            { now: appOpts.now },
          );
          return {
            ...presented,
            // Whole-body HTML keeps superseded formats readable. Current
            // consumers use sectionHtml for the small linked note.
            html: renderMarkdown(STATE_OF_PLAY_PATH, note.body),
            ...(note.format === REENTRY_CONTEXT_FORMAT
              ? {
                  sectionHtml: {
                    recent: renderMarkdown(STATE_OF_PLAY_PATH, note.recent),
                    next: renderMarkdown(STATE_OF_PLAY_PATH, note.next),
                    ...(note.worthKnowing
                      ? {
                          worthKnowing: renderMarkdown(
                            STATE_OF_PLAY_PATH,
                            note.worthKnowing,
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          };
        })()
      : null;

    return c.json({
      project: ctx.config.project,
      preamble: preamble.trim() ? renderMarkdown("index.md", preamble) : "",
      narrative,
      overview: {
        ...deriveOverview(bundle, db, {
          checkpoint: git.checkpoint ?? undefined,
          historyAvailable: git.status === "available",
          decisionLinks:
            note?.format === REENTRY_CONTEXT_FORMAT
              ? note.decisionLinks
              : note?.format === REENTRY_CONTEXT_V1_FORMAT
                ? note.assessment.decisionLinks
                : undefined,
        }),
        git,
      },
    });
  });

  // Every section with its articles in one response — the Docs view's
  // sidebar and listings render from this, replacing the older
  // per-directory listing).
  app.get("/api/docs", async (c) => {
    const { bundle } = await ctx.state();
    const sections = [...docSections(bundle).entries()]
      .sort(([a], [z]) => sectionRank(a) - sectionRank(z) || a.localeCompare(z))
      .map(([name, items]) => ({ name, items }));
    return c.json({ sections });
  });

  // The whole task-linked commit feed. The hand-written log.md narrative
  // rides alongside — it's a reserved root file the doc sections
  // skip, so this remains its one surface.
  app.get("/api/activity", async (c) => {
    const { db, git } = await ctx.state();
    const activity = db
      .query(
        `SELECT sha, date, subject, MIN(task_id) AS taskId FROM activity
         GROUP BY sha ORDER BY date DESC`,
      )
      .all() as (ActivityRow & { taskId: string })[];
    const source = await ctx.store.read("log.md").catch(() => "");
    return c.json({
      activity,
      git,
      log: source.trim() ? renderMarkdown("log.md", source) : "",
    });
  });

  app.get("/api/concept/:path{.+}", async (c) => {
    const path = c.req.param("path");
    if (path.split("/").includes(".."))
      return c.json({ error: "bad path" }, 400);
    const source = await ctx.store.read(path).catch(() => undefined);
    if (source === undefined)
      return c.json({ error: `not found: ${path}` }, 404);

    const { bundle, db, git } = await ctx.state();
    const concept = bundle.concepts.find((k) => k.path === path);
    const backlinks = db
      .query(
        `SELECT DISTINCT b.from_path, c.title FROM backlinks b
         LEFT JOIN concepts c ON c.path = b.from_path
         WHERE b.path = ? ORDER BY b.from_path`,
      )
      .all(path) as { from_path: string; title: string | null }[];
    // Work-graph context: epic breadcrumb + dep statuses for tasks, derived
    // children for epics. Null for docs/decisions so they render unchanged.
    let graph: ConceptGraph | null = null;
    if (concept?.kind === "work") {
      const refOf = (w: WorkItem): GraphRef => ({
        path: w.path,
        id: w.fm.id,
        title: w.fm.title ?? null,
        status: w.fm.status,
      });
      const workAt = (p: string | undefined): WorkItem | undefined => {
        const c = p ? bundle.concepts.find((k) => k.path === p) : undefined;
        return c?.kind === "work" ? c : undefined;
      };
      const epicOf = (w: WorkItem): string | undefined =>
        typeof w.fm.epic === "string"
          ? resolveLink(w.path, w.fm.epic)
          : undefined;

      const ready = new Set(bundle.readyIds());
      const parent = workAt(epicOf(concept));
      graph = {
        epic: parent ? refOf(parent) : null,
        deps: (concept.fm.depends_on ?? []).flatMap((depId) => {
          const dep = bundle.byId(depId);
          return dep?.kind === "work" ? [refOf(dep)] : [];
        }),
        children:
          concept.fm.type === "Epic"
            ? bundle.concepts
                .filter(
                  (c): c is WorkItem =>
                    c.kind === "work" &&
                    c.fm.type === "Task" &&
                    epicOf(c) === concept.path,
                )
                .map((t) => ({ ...refOf(t), ready: ready.has(t.fm.id) }))
                .sort((a, z) =>
                  a.id.localeCompare(z.id, undefined, { numeric: true }),
                )
            : [],
      };
    }

    const id = concept?.kind === "work" ? concept.fm.id : undefined;
    const activity = id
      ? (db
          .query(
            "SELECT sha, date, subject FROM activity WHERE task_id = ? ORDER BY date DESC",
          )
          .all(id) as ActivityRow[])
      : [];

    // The config key is the feature switch. Every configured Spec gets a
    // card, including the intentionally useful empty card; other concepts
    // and unconfigured bundles stay entirely quiet.
    const verification =
      ctx.config.verify && concept?.fm.type === "Spec"
        ? { groups: verificationGroups(db, path) }
        : null;

    return c.json({
      path,
      fm: concept?.fm ?? null,
      // Inline edits need the configured state list for the select.
      states: ctx.config.workflow.states,
      ready: id ? bundle.readyIds().includes(id) : false,
      html: renderMarkdown(path, source),
      backlinks: backlinks.map((b) => ({ path: b.from_path, title: b.title })),
      activity,
      unmergedActivity: id
        ? git.unmergedActivity.filter((entry) => entry.taskId === id)
        : [],
      graph,
      verification,
    });
  });

  // Search delegates wholesale to core's ranked engine —
  // no web-side ranking, same definition as CLI and MCP.
  app.get("/api/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.min(50, Number(c.req.query("limit")) || 10);
    const { bundle } = await ctx.state();
    return c.json({
      hits: await searchBundle(ctx.store, bundle, q, { limit }),
    });
  });

  app.get("/api/board", async (c) => {
    const { bundle, db } = await ctx.state();
    const all = db.query("SELECT * FROM board").all() as BoardRow[];
    // The view already orders terminal history newest-first, so capping keeps
    // the most recent N per terminal state. True counts ride alongside.
    const totals: Record<string, number> = {};
    for (const card of all)
      totals[card.status] = (totals[card.status] ?? 0) + 1;
    const terminalShown: Record<string, number> = {};
    // Facets ride on each card for client-side filtering and swimlane
    // grouping — same convention as /api/tasks.
    const work = new Map(
      bundle.concepts
        .filter((k): k is WorkItem => k.kind === "work")
        .map((w) => [w.path, w]),
    );
    const cards = all
      .filter((card) => {
        if (!isTerminalStatus(card.status)) return true;
        const shown = (terminalShown[card.status] ?? 0) + 1;
        terminalShown[card.status] = shown;
        return shown <= TERMINAL_LIMIT;
      })
      .map((card) => {
        const w = work.get(card.path);
        return {
          ...card,
          epic: w ? epicRefOf(bundle, w) : null,
          tags: w?.fm.tags ?? [],
          assignee: w?.fm.assignee ?? null,
        };
      });
    return c.json({ states: ctx.config.workflow.states, cards, totals });
  });

  // Rollups with the facets the epics page filters and sorts on.
  app.get("/api/epics", async (c) => {
    const { bundle, db } = await ctx.state();
    const epics = epicTags(bundle, db.query(EPICS_SQL).all() as RollupRow[]);
    return c.json({ states: ctx.config.workflow.states, epics });
  });

  // Flat all-tasks listing: every work item — tasks and epics — with
  // the facets the list view filters on. Newest id first; the client re-sorts.
  app.get("/api/tasks", async (c) => {
    const { bundle } = await ctx.state();
    const ready = new Set(bundle.readyIds());
    const num = (id: string) => Number(id.split("-").pop());
    const items = bundle.concepts
      .filter((k): k is WorkItem => k.kind === "work")
      .map((w) => ({
        path: w.path,
        id: w.fm.id,
        type: w.fm.type,
        title: w.fm.title ?? null,
        status: w.fm.status,
        priority: w.fm.priority,
        tags: w.fm.tags,
        ready: ready.has(w.fm.id),
        epic: epicRefOf(bundle, w),
      }))
      .sort((a, z) => num(z.id) - num(a.id));
    return c.json({ states: ctx.config.workflow.states, items });
  });

  // Opt-in audit-log commit: pathspec-limited to the op's file.
  // The tree is the source of truth — a failed commit logs, never 400s.
  const commitWrite = async (id: string, path: string, subject: string) => {
    if (!appOpts.commit) return;
    const message = `chore(docket): ${subject} (serve)\n\n${ctx.config.git.trailer}: ${id}\n`;
    await appOpts
      .commit({ paths: [path], message })
      .catch((error: Error) =>
        console.error(
          `docket serve — write landed but commit failed: ${error.message}`,
        ),
      );
  };

  const asError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  // Local structured writes widen status drag-and-drop: each
  // field edit lands in the working tree through core ops — one write path
  // with the CLI and MCP — and the next read reflects it.
  app.post("/api/tasks/:id/status", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      to?: unknown;
      note?: unknown;
    };
    if (typeof body.to !== "string" || !isStatus(body.to))
      return c.json({ error: `unknown status "${String(body.to)}"` }, 400);
    try {
      const result = await setStatus(
        ctx.store,
        ctx.config,
        c.req.param("id"),
        body.to,
        { note: typeof body.note === "string" ? body.note : undefined },
      );
      ctx.invalidate();
      await commitWrite(
        result.id,
        result.path,
        `${result.id} ${result.from} → ${result.to}`,
      );
      return c.json(result);
    } catch (error) {
      return c.json({ error: asError(error) }, 400);
    }
  });

  app.post("/api/tasks/:id/priority", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { to?: unknown };
    if (typeof body.to !== "string")
      return c.json({ error: `unknown priority "${String(body.to)}"` }, 400);
    try {
      const result = await setPriority(
        ctx.store,
        ctx.config,
        c.req.param("id"),
        body.to,
      );
      ctx.invalidate();
      await commitWrite(
        result.id,
        result.path,
        `${result.id} priority ${result.from} → ${result.to}`,
      );
      return c.json(result);
    } catch (error) {
      return c.json({ error: asError(error) }, 400);
    }
  });

  // Manual lane order: `to` is the new rank; null clears it. The
  // client computes the number (neighbor midpoint) — the server just persists.
  app.post("/api/tasks/:id/rank", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { to?: unknown };
    if (body.to !== null && typeof body.to !== "number")
      return c.json({ error: "rank must be a number or null" }, 400);
    try {
      const result = await setRank(
        ctx.store,
        ctx.config,
        c.req.param("id"),
        body.to,
      );
      ctx.invalidate();
      await commitWrite(
        result.id,
        result.path,
        `${result.id} rank ${result.from ?? "none"} → ${result.to ?? "none"}`,
      );
      return c.json(result);
    } catch (error) {
      return c.json({ error: asError(error) }, 400);
    }
  });

  // `to` is a bundle-absolute epic link; null (or "") clears the field.
  app.post("/api/tasks/:id/epic", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { to?: unknown };
    if (body.to !== null && typeof body.to !== "string")
      return c.json({ error: "epic must be a link or null" }, 400);
    try {
      const result = await setEpic(
        ctx.store,
        ctx.config,
        c.req.param("id"),
        body.to,
      );
      ctx.invalidate();
      await commitWrite(
        result.id,
        result.path,
        `${result.id} epic ${result.from ?? "none"} → ${result.to ?? "none"}`,
      );
      return c.json(result);
    } catch (error) {
      return c.json({ error: asError(error) }, 400);
    }
  });

  if (assets) {
    app.get("/assets/app.js", (c) =>
      c.body(assets.js, 200, { "content-type": "text/javascript" }),
    );
    app.get("*", (c) => c.html(page(assets)));
  }

  return app;
}

/** Type helper for tests and clients. */
export type { WorkItem };
