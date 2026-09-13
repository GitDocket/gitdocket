// The Hono app: a thin JSON API over core plus the SPA shell. Every write
// goes through core ops (setStatus, setPriority, setEpic) — the same single
// write path as the CLI and MCP server — so the Phase 4 team UI is a client
// change, not a rewrite.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  type Bundle,
  DOCUMENT_EDIT_MAX_BYTES,
  type DocketConfig,
  DocumentEditError,
  documentEditingAvailability,
  editDocument,
  editGuidance,
  InMemoryFileStore,
  isStatus,
  isTerminalStatus,
  loadBundle,
  PROJECT_GUIDANCE_PATH,
  parseStateOfPlay,
  presentStateOfPlay,
  REENTRY_CONTEXT_FORMAT,
  REENTRY_CONTEXT_V1_FORMAT,
  readEditableDocument,
  readEditableGuidance,
  readProjectGuidance,
  renderIndex,
  resolveLink,
  type SourceCursor,
  STATE_OF_PLAY_PATH,
  setEpic,
  setPriority,
  setRank,
  setStatus,
  sourcePage,
  validateDocumentPath,
  type WorkItem,
} from "@gitdocket/core";
import { deriveOverview, epicNeedsCleanup } from "@gitdocket/core/overview";
import {
  type Operation,
  observeOperation,
  Telemetry,
} from "@gitdocket/core/telemetry";
import { type Handler, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { filterCards, parseBoardState } from "./client/board";
import { applyEpicList, parseEpicListState } from "./client/epiclist";
import { dropRank } from "./client/rank";
import { type SortMode, sortCards } from "./client/sort";
import { applyList, parseListState } from "./client/tasklist";
import type { Committer } from "./commit";
import { markdownHeadingOffsets, renderMarkdown } from "./render";
import type { RepoContext, RepoState } from "./state";
import { conceptHref, isTicketNumber } from "./urls";

function renderBundleMarkdown(
  repo: RepoState,
  path: string,
  source: string,
): string {
  return renderMarkdown(path, source, (target) => {
    const concept = conceptMap(repo.bundle).get(target);
    return conceptHref({ path: target, ...concept?.fm });
  });
}

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
  committerFor?: (bundle: string) => Committer;
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
  const parent = target ? conceptMap(bundle).get(target) : undefined;
  return parent?.kind === "work"
    ? {
        path: parent.path,
        id: parent.fm.id,
        title: parent.fm.title ?? null,
      }
    : null;
}

const conceptMaps = new WeakMap<
  Bundle,
  Map<string, Bundle["concepts"][number]>
>();
function conceptMap(bundle: Bundle) {
  let map = conceptMaps.get(bundle);
  if (!map) {
    map = new Map(bundle.concepts.map((c) => [c.path, c]));
    conceptMaps.set(bundle, map);
  }
  return map;
}
// Cache only fixed projections on their owning generation; arbitrary user
// queries are evaluated over these summaries and are not retained.
const projections = new WeakMap<RepoState, Map<string, unknown>>();
function memo<T>(repo: RepoState, key: string, build: () => T): T {
  let cache = projections.get(repo);
  if (!cache) {
    cache = new Map();
    projections.set(repo, cache);
  }
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key) as T;
}
function paging(query: Record<string, string>) {
  const page = Number(query.page ?? 1);
  const limit = Number(query.limit ?? 50);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new HTTPException(400, {
      message: "page must be positive; limit must be 1–100",
    });
  return { page, limit, offset: (page - 1) * limit };
}
function pageRows<T>(
  rows: T[],
  query: Record<string, string>,
  generation: number,
) {
  const { page, limit, offset } = paging(query);
  if (query.generation && Number(query.generation) !== generation)
    throw new HTTPException(409, {
      message: "collection changed; restart pagination",
    });
  return {
    items: rows.slice(offset, offset + limit),
    page: {
      number: page,
      limit,
      total: rows.length,
      generation,
      next: offset + limit < rows.length ? page + 1 : null,
    },
  };
}
function taskRows(repo: RepoState) {
  return memo(repo, "tasks", () => {
    const ready = new Set(repo.bundle.readyIds());
    return repo.bundle.workItems
      .map((w) => ({
        path: w.path,
        id: w.fm.id,
        type: w.fm.type,
        title: w.fm.title ?? null,
        status: w.fm.status,
        priority: w.fm.priority,
        tags: w.fm.tags,
        ready: ready.has(w.fm.id),
        epic: epicRefOf(repo.bundle, w),
      }))
      .sort(
        (a, z) => Number(z.id.split("-").pop()) - Number(a.id.split("-").pop()),
      );
  });
}
function boardRows(repo: RepoState) {
  return memo(repo, "board", () =>
    (repo.db.query("SELECT * FROM board").all() as BoardRow[]).map((card) => {
      const w = conceptMap(repo.bundle).get(card.path);
      return {
        ...card,
        epic: w?.kind === "work" ? epicRefOf(repo.bundle, w) : null,
        tags: w?.fm.tags ?? [],
        assignee: typeof w?.fm.assignee === "string" ? w.fm.assignee : null,
      };
    }),
  );
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
  page?: { limit: number; offset: number },
): VerificationKindGroup[] {
  const rows = db
    .query(
      `SELECT kind, source_path AS source, line, anchor
       FROM verifications WHERE concept_path = ?
       ORDER BY kind, anchor IS NOT NULL, anchor, source_path, line${page ? " LIMIT ? OFFSET ?" : ""}`,
    )
    .all(
      ...(page ? [path, page.limit, page.offset] : [path]),
    ) as VerificationRow[];
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
  FROM epic_rollup r JOIN concepts c ON c.path = r.epic_path
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
) {
  const app = new Hono<{ Variables: { repo: RepoState } }>();

  const telemetry = new Telemetry(ctx.root, "serve");
  app.use("/api/*", async (c, next) => {
    const route = c.req.path;
    const reads: Record<string, Operation> = {
      "/api/nav": "docs",
      "/api/home": "overview",
      "/api/docs": "docs",
      "/api/activity": "activity",
      "/api/search": "search",
      "/api/board": "board",
      "/api/epics": "epics",
      "/api/tasks": "task_list",
      "/api/facets": "config",
    };
    const mutations: Record<string, Operation> = {
      status: "set_status",
      priority: "set_priority",
      reorder: "set_rank",
      rank: "set_rank",
      epic: "set_epic",
    };
    const mutation =
      /^\/api\/tasks\/[^/]+\/(status|priority|reorder|rank|epic)$/.exec(route);
    const operation =
      c.req.method === "POST" && mutation
        ? mutations[mutation[1] ?? ""]
        : c.req.method === "GET"
          ? (reads[route] ??
            (route.startsWith("/api/source/")
              ? "source_page"
              : route.startsWith("/api/concept/") ||
                  route.startsWith("/api/work/")
                ? "task_get"
                : undefined))
          : undefined;
    if (!operation) return next();
    const trigger = c.req.header("X-Docket-Trigger");
    await observeOperation(telemetry, operation, next, {
      dimensions: () => ctx.telemetryDimensions?.() ?? {},
      attribution: {
        trigger:
          trigger === "background" || trigger === "explicit"
            ? trigger
            : "unknown",
        workflow: c.req.header("X-Docket-Workflow"),
        actor: c.req.header("X-Docket-Actor"),
        host: c.req.header("X-Docket-Host"),
      },
      resultError: () =>
        c.res.status < 400
          ? "none"
          : c.res.status === 400
            ? "validation"
            : c.res.status === 404
              ? "not_found"
              : c.res.status === 409
                ? "conflict"
                : c.res.status === 403
                  ? "permission"
                  : "internal",
    });
  });

  app.use("*", async (c, next) => {
    const error = localRequestBoundary(c.req.raw);
    if (error) return c.json({ error }, 403);
    await next();
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const lease = await ctx.acquire();
    c.set("repo", lease.state);
    c.header("X-Docket-Generation", String(lease.state.generation));
    c.header("X-Docket-Freshness", lease.error ? "stale" : "current");
    try {
      if (
        c.req.query("page") &&
        c.req.query("generation") &&
        Number(c.req.query("generation")) !== lease.state.generation
      )
        return c.json({ error: "collection changed; restart pagination" }, 409);
      await next();
    } finally {
      lease.release();
    }
  });

  // Wiki nav: the generated index rendered like any other page. Falls back to
  // an in-memory render so serve works before `docket index` has ever run.
  app.get("/api/nav", async (c) => {
    const { bundle, sources } = c.get("repo");
    const summary = c.req.query("summary") === "1";
    const source = summary
      ? ""
      : (sources.get("index.md") ?? renderIndex(bundle));
    // Doc directories in reading order — the command palette lists
    // them as navigation targets.
    const sections = [...docSections(bundle).keys()].sort(
      (a, z) => sectionRank(a) - sectionRank(z) || a.localeCompare(z),
    );
    return c.json({
      project: c.get("repo").config.project,
      ...(summary
        ? {}
        : {
            html: memo(c.get("repo"), "navHtml", () =>
              renderBundleMarkdown(c.get("repo"), "index.md", source),
            ),
          }),
      sections: summary ? sections.slice(0, 50) : sections,
      sectionTotal: sections.length,
    });
  });

  // Composed home briefing. index.md stays the
  // git-facing artifact; only its hand-written preamble renders here.
  app.get("/api/home", async (c) => {
    const { bundle, db, git } = c.get("repo");

    const source = c.get("repo").sources.get("index.md") ?? "";
    const preamble = homePreamble(source);

    const narrativeSource = c.get("repo").sources.get(STATE_OF_PLAY_PATH);
    const brief = c.req.query("briefing") === "1";
    const largeNarrative =
      brief && !!narrativeSource && narrativeSource.length > 32768;
    const largePreamble = brief && preamble.length > 32768;
    const note =
      narrativeSource && !largeNarrative
        ? parseStateOfPlay(narrativeSource).note
        : undefined;
    const narrative = note
      ? await (async () => {
          const presented = presentStateOfPlay(
            note,
            await c.get("repo").countSince(note.asOf),
            { now: appOpts.now },
          );
          return {
            ...presented,
            // Whole-body HTML keeps superseded formats readable. Current
            // consumers use sectionHtml for the small linked note.
            html: renderBundleMarkdown(
              c.get("repo"),
              STATE_OF_PLAY_PATH,
              note.body,
            ),
            ...(note.format === REENTRY_CONTEXT_FORMAT
              ? {
                  sectionHtml: {
                    recent: renderBundleMarkdown(
                      c.get("repo"),
                      STATE_OF_PLAY_PATH,
                      note.recent,
                    ),
                    next: renderBundleMarkdown(
                      c.get("repo"),
                      STATE_OF_PLAY_PATH,
                      note.next,
                    ),
                    ...(note.worthKnowing
                      ? {
                          worthKnowing: renderBundleMarkdown(
                            c.get("repo"),
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
      project: c.get("repo").config.project,
      preamble:
        !largePreamble && preamble.trim()
          ? renderBundleMarkdown(c.get("repo"), "index.md", preamble)
          : "",
      ...(largePreamble ? { preambleSourcePath: "index.md" } : {}),
      ...(largeNarrative ? { narrativeSourcePath: STATE_OF_PLAY_PATH } : {}),
      narrative,
      ...(!narrative && !largeNarrative
        ? {
            narrativeProblem:
              narrativeSource === undefined ? "missing" : "malformed",
          }
        : {}),
      ...(c.req.query("briefing") === "1"
        ? {}
        : {
            overview: {
              ...deriveOverview(bundle, db, {
                checkpoint: git.checkpoint ?? undefined,
                historyAvailable:
                  git.status === "available" && git.historyComplete !== false,
                decisionLinks:
                  note?.format === REENTRY_CONTEXT_FORMAT
                    ? note.decisionLinks
                    : note?.format === REENTRY_CONTEXT_V1_FORMAT
                      ? note.assessment.decisionLinks
                      : undefined,
              }),
              git,
            },
          }),
    });
  });

  // Every section with its articles in one response — the Docs view's
  // sidebar and listings render from this, replacing the older
  // per-directory listing).
  app.get("/api/docs", async (c) => {
    const { bundle } = c.get("repo");
    let sections = [
      ...memo(c.get("repo"), "docs", () => docSections(bundle)).entries(),
    ]
      .sort(([a], [z]) => sectionRank(a) - sectionRank(z) || a.localeCompare(z))
      .map(([name, items]) => ({ name, items }));
    if (c.req.query("preview") === "1") {
      const result = pageRows(
        sections,
        { ...c.req.query(), limit: "12" },
        c.get("repo").generation,
      );
      return c.json({
        page: result.page,
        sections: result.items.map((section) => ({
          ...section,
          total: section.items.length,
          items: section.items.slice(0, 3),
        })),
      });
    }
    if (c.req.query("page")) {
      if (c.req.query("section"))
        sections = sections.filter(
          (section) => section.name === c.req.query("section"),
        );
      const rows = sections.flatMap((section) =>
        section.items.map((item) => ({ ...item, section: section.name })),
      );
      const result = pageRows(rows, c.req.query(), c.get("repo").generation);
      return c.json({
        sections: sections
          .filter((section) =>
            result.items.some((item) => item.section === section.name),
          )
          .map((section) => ({
            name: section.name,
            total: section.items.length,
            items: result.items.filter((item) => item.section === section.name),
          })),
        page: result.page,
      });
    }
    return c.json({ sections });
  });

  // The whole task-linked commit feed. The hand-written log.md narrative
  // rides alongside — it's a reserved root file the doc sections
  // skip, so this remains its one surface.
  app.get("/api/activity", async (c) => {
    const { db, git } = c.get("repo");
    const source = c.get("repo").sources.get("log.md") ?? "";
    if (c.req.query("page")) {
      const { page, limit, offset } = paging(c.req.query());
      const task = c.req.query("task");
      const where = task ? " WHERE task_id = ?" : "";
      const bindings = task ? [task] : [];
      const total = (
        db
          .query(`SELECT COUNT(DISTINCT sha) AS total FROM activity${where}`)
          .get(...bindings) as { total: number }
      ).total;
      const activity = db
        .query(
          `SELECT sha,date,subject,MIN(task_id) AS taskId FROM activity${where} GROUP BY sha ORDER BY date DESC,sha LIMIT ? OFFSET ?`,
        )
        .all(...bindings, limit, offset);
      const unmerged = task
        ? git.unmergedActivity.filter((row) => row.taskId === task)
        : git.unmergedActivity;
      const size = Math.max(total, unmerged.length);
      return c.json({
        activity,
        activityTotal: total,
        unmergedTotal: unmerged.length,
        page: {
          number: page,
          limit,
          total: size,
          next: offset + limit < size ? page + 1 : null,
          generation: c.get("repo").generation,
        },
        git: {
          ...git,
          unmergedActivity: unmerged.slice(offset, offset + limit),
        },
        log: "",
        logPath: source ? "log.md" : null,
      });
    }
    const activity = memo(c.get("repo"), "activity", () =>
      db
        .query(
          "SELECT sha,date,subject,MIN(task_id) AS taskId FROM activity GROUP BY sha ORDER BY date DESC,sha",
        )
        .all(),
    );
    return c.json({
      activity,
      git,
      log: source.trim()
        ? renderBundleMarkdown(c.get("repo"), "log.md", source)
        : "",
    });
  });

  app.get("/api/source/:path{.+}", (c) => {
    const path = c.req.param("path");
    if (path.split("/").includes(".."))
      return c.json({ error: "bad path" }, 400);
    try {
      const rawCursor = c.req.query("cursor");
      const cursor = rawCursor
        ? (JSON.parse(rawCursor) as SourceCursor)
        : undefined;
      const repo = c.get("repo");
      let page = sourcePage(repo.sources, path, { cursor });
      if (!page) return c.json({ error: "not found" }, 404);
      const anchor = c.req.query("anchor");
      if (anchor && !cursor) {
        const offsets = memo(repo, `headings:${path}`, () =>
          markdownHeadingOffsets(repo.sources.get(path) ?? ""),
        );
        const offset = offsets.get(anchor);
        if (offset !== undefined)
          page =
            sourcePage(repo.sources, path, {
              cursor: { path, sourceHash: page.sourceHash, offset },
            }) ?? page;
      }
      if (c.req.query("readable") === "1") {
        // Render only the bounded excerpt. Fenced blocks may cross a cursor
        // boundary; preserve exact text instead of guessing their context.
        const partial = !!cursor || !!page.nextCursor;
        const fallback = partial && /^\s*(```|~~~)/m.test(page.text);
        return c.json({
          ...page,
          html: fallback
            ? null
            : renderBundleMarkdown(c.get("repo"), path, page.text),
          partial,
        });
      }
      return c.json(page);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });

  const conceptDetail: Handler<{ Variables: { repo: RepoState } }> = async (
    c,
  ) => {
    const repo = c.get("repo");
    const number = c.req.param("number");
    let path = c.req.param("path") ?? "";
    if (number !== undefined) {
      const item = isTicketNumber(number)
        ? repo.bundle.byId(`${repo.config.project}-${number}`)
        : undefined;
      if (item?.kind !== "work")
        return c.json(
          {
            error: `Work item not found: ${number || "(empty ticket number)"}`,
          },
          404,
        );
      path = item.path;
    }
    if (path.split("/").includes(".."))
      return c.json({ error: "bad path" }, 400);
    const source = c.get("repo").sources.get(path);
    if (source === undefined)
      return c.json({ error: `not found: ${path}` }, 404);

    const { bundle, db, git } = c.get("repo");
    const concept = conceptMap(bundle).get(path);
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
        const c = p ? conceptMap(bundle).get(p) : undefined;
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
                .sort(
                  (a, z) =>
                    Number(isTerminalStatus(a.status ?? "")) -
                      Number(isTerminalStatus(z.status ?? "")) ||
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

    const bounded = c.req.query("page") !== undefined;
    const bounds = bounded ? paging(c.req.query()) : undefined;
    // The config key is the feature switch. Every configured Spec gets a
    // card, including the intentionally useful empty card; other concepts
    // and unconfigured bundles stay entirely quiet.
    const verification =
      c.get("repo").config.verify && concept?.fm.type === "Spec"
        ? { groups: verificationGroups(db, path, bounds) }
        : null;

    const relations = {
      backlinks: backlinks.map((b) => {
        const linked = conceptMap(bundle).get(b.from_path);
        return {
          path: b.from_path,
          title: b.title,
          ...(linked?.kind === "work"
            ? { id: linked.fm.id, type: linked.fm.type }
            : {}),
        };
      }),
      activity,
      unmergedActivity: id
        ? git.unmergedActivity.filter((entry) => entry.taskId === id)
        : [],
      deps: graph?.deps ?? [],
      children: graph?.children ?? [],
    };
    const relationPages = bounded
      ? Object.fromEntries(
          Object.entries(relations).map(([key, rows]) => [
            key,
            pageRows(
              rows as unknown[],
              c.req.query(),
              c.get("repo").generation,
            ),
          ]),
        )
      : undefined;
    const paged = <T>(key: string, rows: T[]): T[] =>
      relationPages ? (relationPages[key]?.items as T[]) : rows;
    const relationTotal = Math.max(
      0,
      ...Object.values(relations).map((rows) => rows.length),
      verification
        ? (
            db
              .query(
                "SELECT COUNT(*) AS total FROM verifications WHERE concept_path=?",
              )
              .get(path) as { total: number }
          ).total
        : 0,
    );
    const relationPage = bounded
      ? {
          ...paging(c.req.query()),
          number: paging(c.req.query()).page,
          total: relationTotal,
          generation: c.get("repo").generation,
          next:
            paging(c.req.query()).offset + paging(c.req.query()).limit <
            relationTotal
              ? paging(c.req.query()).page + 1
              : null,
        }
      : undefined;
    const largeSource = bounded && source.length > 32768;
    return c.json({
      path,
      editScope: sourceScope(repo.store.root),
      editing: memo(repo, `editing:${path}`, () =>
        documentEditingAvailability(path, source, repo.config),
      ),
      fm: concept
        ? bounded
          ? {
              type: concept.fm.type,
              id: concept.fm.id,
              title: concept.fm.title,
              status: concept.fm.status,
              priority: concept.fm.priority,
              epic: concept.fm.epic,
            }
          : concept.fm
        : null,
      // Inline edits need the configured state list for the select.
      states: c.get("repo").config.workflow.states,
      ready: id ? bundle.readyIds().includes(id) : false,
      html: largeSource
        ? ""
        : renderBundleMarkdown(c.get("repo"), path, source),
      ...(largeSource ? { sourcePath: path } : {}),
      ...(relationPage ? { relationPage } : {}),
      backlinks: paged("backlinks", relations.backlinks),
      activity: paged("activity", relations.activity),
      unmergedActivity: paged("unmergedActivity", relations.unmergedActivity),
      graph: graph
        ? {
            ...graph,
            deps: paged("deps", graph.deps),
            children: paged("children", graph.children),
          }
        : null,
      verification,
    });
  };
  app.get("/api/concept/:path{.+}", conceptDetail);
  app.get("/api/work/:number{.*}", conceptDetail);

  // Search delegates wholesale to core's ranked engine —
  // no web-side ranking, same definition as CLI and MCP.
  app.get("/api/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.min(50, Number(c.req.query("limit")) || 10);
    const { search } = c.get("repo");
    if (c.req.query("page")) {
      const { page, limit, offset } = paging(c.req.query());
      const result = search.searchPage(q, {
        limit,
        offset,
        includeGraph: false,
        maxSnippetChars: 240,
      });
      return c.json({
        hits: result.hits.map((hit) => {
          const concept = conceptMap(c.get("repo").bundle).get(hit.path);
          return {
            ...hit,
            type: concept && "fm" in concept ? concept.fm.type : undefined,
          };
        }),
        page: {
          number: page,
          limit,
          total: result.total,
          next: offset + limit < result.total ? page + 1 : null,
          generation: c.get("repo").generation,
        },
      });
    }
    return c.json({
      hits: search.search(q, { limit }),
    });
  });

  app.get("/api/board", (c) => {
    const repo = c.get("repo");
    const all = boardRows(repo);
    const totals: Record<string, number> = {};
    for (const card of all)
      totals[card.status] = (totals[card.status] ?? 0) + 1;
    if (c.req.query("page")) {
      const filtered = filterCards(
        all,
        parseBoardState(new URL(c.req.url).search.slice(1)),
      );
      let modes: Record<string, SortMode> = {};
      try {
        modes = JSON.parse(c.req.query("sorts") ?? "{}");
      } catch {
        throw new HTTPException(400, { message: "invalid board sorts" });
      }
      for (const mode of Object.values(modes))
        if (
          mode &&
          (!["priority", "recency", "id"].includes(mode.key) ||
            !["asc", "desc"].includes(mode.dir))
        )
          throw new HTTPException(400, { message: "invalid board sort" });
      const columns = repo.config.workflow.states.map((status) => {
        const result = pageRows(
          sortCards(
            filtered.filter((row) => row.status === status),
            modes[status] ?? null,
          ),
          {
            ...c.req.query(),
            page: c.req.query(`column.${status}`) ?? c.req.query("page") ?? "1",
          },
          repo.generation,
        );
        return { status, cards: result.items, page: result.page };
      });
      return c.json({
        states: repo.config.workflow.states,
        cards: columns.flatMap((column) => column.cards),
        totals,
        columns,
      });
    }
    const shown: Record<string, number> = {};
    const cards = all.filter((card) => {
      if (!isTerminalStatus(card.status)) return true;
      shown[card.status] = (shown[card.status] ?? 0) + 1;
      return (shown[card.status] ?? 0) <= TERMINAL_LIMIT;
    });
    return c.json({ states: repo.config.workflow.states, cards, totals });
  });

  // Rollups with the facets the epics page filters and sorts on.
  app.get("/api/epics", async (c) => {
    const { bundle, db } = c.get("repo");
    const epics = memo(c.get("repo"), "epics", () =>
      epicTags(bundle, db.query(EPICS_SQL).all() as RollupRow[]),
    );
    if (c.req.query("page")) {
      const result = pageRows(
        applyEpicList(
          epics,
          parseEpicListState(new URL(c.req.url).search.slice(1)),
        ),
        c.req.query(),
        c.get("repo").generation,
      );
      return c.json({
        states: c.get("repo").config.workflow.states,
        epics: result.items,
        page: result.page,
        total: epics.length,
      });
    }
    return c.json({ states: c.get("repo").config.workflow.states, epics });
  });

  // Flat all-tasks listing: every work item — tasks and epics — with
  // the facets the list view filters on. Newest id first; the client re-sorts.
  app.get("/api/tasks", async (c) => {
    const repo = c.get("repo");
    const items = taskRows(repo);
    if (c.req.query("page")) {
      const result = pageRows(
        applyList(
          items,
          repo.config.workflow.states,
          parseListState(new URL(c.req.url).search.slice(1)),
        ),
        c.req.query(),
        repo.generation,
      );
      return c.json({
        states: repo.config.workflow.states,
        items: result.items,
        page: result.page,
        total: items.length,
      });
    }
    return c.json({ states: repo.config.workflow.states, items });
  });

  // Facets search the complete summary inventory; only a small option page is
  // sent, avoiding one option per epic on every row editor.
  app.get("/api/facets", (c) => {
    const repo = c.get("repo");
    const field = c.req.query("field");
    const rows = taskRows(repo);
    let options: { value: string; label: string }[];
    if (field === "epic")
      options = rows
        .filter((r) => r.type === "Epic")
        .map((r) => ({ value: r.id, label: r.title ?? r.id, path: r.path }));
    else if (field === "assignee")
      options = [
        ...new Set(
          boardRows(repo).flatMap((r) => (r.assignee ? [r.assignee] : [])),
        ),
      ]
        .sort()
        .map((value) => ({ value, label: value }));
    else if (field === "tag" || field === "type" || field === "priority")
      options = [
        ...new Set(
          rows.flatMap((r) => (field === "tag" ? r.tags : [r[field]])),
        ),
      ]
        .sort()
        .map((value) => ({ value, label: value }));
    else return c.json({ error: "unknown facet" }, 400);
    const q = (c.req.query("q") ?? "").toLowerCase();
    const result = pageRows(
      options.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(q)),
      { ...c.req.query(), limit: "30" },
      repo.generation,
    );
    return c.json({ options: result.items, page: result.page });
  });

  // Opt-in audit-log commit: pathspec-limited to the op's file.
  // The tree is the source of truth — a failed commit logs, never 400s.
  const commitWrite = async (
    id: string,
    path: string,
    subject: string,
    config: DocketConfig,
  ) => {
    const commit = appOpts.commit ?? appOpts.committerFor?.(config.bundle);
    if (!commit) return;
    const message = `chore(docket): ${subject} (serve)\n\n${config.git.trailer}: ${id}\n`;
    await commit({ paths: [path], message }).catch((error: Error) =>
      console.error(
        `docket serve — write landed but commit failed: ${error.message}`,
      ),
    );
    ctx.invalidateGit();
  };

  const asError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const sourceScope = (root: string) =>
    createHash("sha256").update(root).digest("hex");
  const editFailure = (error: unknown) => ({
    error: asError(error),
    code: error instanceof DocumentEditError ? error.code : "unavailable",
  });
  const editStatus = (error: unknown) =>
    error instanceof DocumentEditError
      ? error.code === "conflict"
        ? 409
        : error.code === "not_found"
          ? 404
          : error.code === "too_large"
            ? 413
            : error.code === "unsupported"
              ? 422
              : 400
      : 503;

  app.use(
    "/api/edit-source/*",
    bodyLimit({
      maxSize: DOCUMENT_EDIT_MAX_BYTES * 6 + 65536,
      onError: (c) =>
        c.json(
          {
            code: "too_large",
            error: "Request is too large. Your draft has not been saved.",
          },
          413,
        ),
    }),
  );
  app.get("/api/guidance", async (c) => {
    const repo = c.get("repo");
    const guidance = await readProjectGuidance(
      new InMemoryFileStore(new Map(repo.sources)),
      repo.config,
    );
    const source = repo.sources.get(PROJECT_GUIDANCE_PATH);
    return c.json({
      guidance,
      editScope: sourceScope(repo.store.root),
      editing:
        source === undefined
          ? { editable: true }
          : documentEditingAvailability(
              PROJECT_GUIDANCE_PATH,
              source,
              repo.config,
            ),
      html:
        source !== undefined && source.length <= 32768
          ? renderBundleMarkdown(repo, PROJECT_GUIDANCE_PATH, source)
          : null,
    });
  });
  app.get("/api/edit-source/:path{.+}", async (c) => {
    const repo = c.get("repo");
    try {
      const path = c.req.param("path");
      const document =
        path === PROJECT_GUIDANCE_PATH
          ? await readEditableGuidance(repo.store, repo.config)
          : await readEditableDocument(repo.store, repo.config, path);
      c.header("Cache-Control", "no-store");
      return c.json({ ...document, sourceScope: sourceScope(repo.store.root) });
    } catch (error) {
      return c.json(editFailure(error), editStatus(error));
    }
  });
  app.post("/api/edit-source/:path{.+}", async (c) => {
    try {
      const input = await c.req.json();
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new DocumentEditError(
          "invalid",
          "Provide a versioned source edit.",
        );
      const { sourceScope: expectedScope, ...request } = input;
      const result = await ctx.mutate(async (store, config) => {
        if (expectedScope !== sourceScope(store.root))
          throw new DocumentEditError(
            "conflict",
            "The project source changed. Reopen this document in the current project before saving.",
          );
        const path = c.req.param("path");
        const result =
          path === PROJECT_GUIDANCE_PATH
            ? await editGuidance(store, config, request)
            : await editDocument(store, config, path, request);
        let saveState:
          | "saved_locally"
          | "committed"
          | "commit_failed"
          | "unchanged" = result.changed ? "saved_locally" : "unchanged";
        let commitError: string | undefined;
        const commit = appOpts.commit ?? appOpts.committerFor?.(config.bundle);
        if (commit && result.changed) {
          try {
            const subject = result.taskId ?? result.document.path;
            await commit({
              paths: result.paths,
              message: `chore(docket): edit ${subject} content (serve)\n`,
              taskTrailer: { key: config.git.trailer, id: result.taskId },
            });
            saveState = "committed";
          } catch (error) {
            saveState = "commit_failed";
            commitError = asError(error);
          } finally {
            ctx.invalidateGit();
          }
        }
        return {
          ...result,
          document: {
            ...result.document,
            sourceScope: sourceScope(store.root),
          },
          saveState,
          ...(commitError ? { commitError } : {}),
        };
      });
      return c.json(result);
    } catch (error) {
      return c.json(
        editFailure(error),
        error instanceof SyntaxError ? 400 : editStatus(error),
      );
    }
  });
  app.use(
    "/api/edit-preview/*",
    bodyLimit({
      maxSize: DOCUMENT_EDIT_MAX_BYTES * 6 + 65536,
      onError: (c) => c.json({ error: "Preview is too large." }, 413),
    }),
  );
  app.post("/api/edit-preview/:path{.+}", async (c) => {
    try {
      const path = c.req.param("path");
      validateDocumentPath(path);
      const input = await c.req.json();
      if (
        !input ||
        typeof input.body !== "string" ||
        Buffer.byteLength(input.body) > DOCUMENT_EDIT_MAX_BYTES
      )
        return c.json(
          { error: "Preview supports Markdown bodies up to 256 KiB." },
          400,
        );
      const lease = await ctx.acquire();
      try {
        return c.json({
          html: renderBundleMarkdown(lease.state, path, input.body),
        });
      } finally {
        lease.release();
      }
    } catch (error) {
      return c.json(editFailure(error), 400);
    }
  });

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
    const to = body.to;
    try {
      const result = await ctx.mutate(async (store, config) => {
        const result = await setStatus(store, config, c.req.param("id"), to, {
          note: typeof body.note === "string" ? body.note : undefined,
        });
        await commitWrite(
          result.id,
          result.path,
          `${result.id} ${result.from} → ${result.to}`,
          config,
        );
        return result;
      });
      return c.json(result);
    } catch (error) {
      return c.json({ error: asError(error) }, 400);
    }
  });

  app.post("/api/tasks/:id/priority", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { to?: unknown };
    if (typeof body.to !== "string")
      return c.json({ error: `unknown priority "${String(body.to)}"` }, 400);
    const to = body.to;
    try {
      const result = await ctx.mutate(async (store, config) => {
        const result = await setPriority(store, config, c.req.param("id"), to);
        await commitWrite(
          result.id,
          result.path,
          `${result.id} priority ${result.from} → ${result.to}`,
          config,
        );
        return result;
      });
      return c.json(result);
    } catch (error) {
      return c.json({ error: asError(error) }, 400);
    }
  });

  app.post("/api/tasks/:id/reorder", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      beforeId?: unknown;
      afterId?: unknown;
      status?: unknown;
      query?: unknown;
      epic?: unknown;
    };
    if (
      (body.beforeId !== null && typeof body.beforeId !== "string") ||
      typeof body.status !== "string" ||
      typeof body.query !== "string"
    )
      return c.json({ error: "invalid reorder" }, 400);
    try {
      const result = await ctx.mutate(async (store, config) => {
        const bundle = await loadBundle(store, config);
        const work = bundle.byId(c.req.param("id"));
        if (
          work?.kind !== "work" ||
          work.fm.type !== "Task" ||
          work.fm.status !== body.status
        )
          throw new Error("task moved; refresh the board");
        const cards = bundle.workItems
          .filter((w) => w.fm.type === "Task" && w.fm.status === body.status)
          .sort((a, b) => {
            if (isTerminalStatus(a.fm.status)) {
              const time = String(b.fm.timestamp ?? "").localeCompare(
                String(a.fm.timestamp ?? ""),
              );
              if (time) return time;
            }
            return (
              Number(a.fm.rank === undefined) -
                Number(b.fm.rank === undefined) ||
              (a.fm.rank ?? 0) - (b.fm.rank ?? 0) ||
              a.fm.priority.localeCompare(b.fm.priority) ||
              a.fm.id.localeCompare(b.fm.id)
            );
          })
          .map((w) => ({
            id: w.fm.id,
            rank: w.fm.rank ?? null,
            epic: epicRefOf(bundle, w),
            tags: w.fm.tags,
            assignee: typeof w.fm.assignee === "string" ? w.fm.assignee : null,
          }));
        let lane = filterCards(cards, parseBoardState(body.query as string));
        if (typeof body.epic === "string")
          lane = lane.filter((card) => (card.epic?.id ?? "") === body.epic);
        if (
          !lane.some((card) => card.id === work.fm.id) ||
          (body.beforeId !== null &&
            !lane.some((card) => card.id === body.beforeId))
        )
          throw new Error("reorder anchor changed; refresh the board");
        let beforeId = body.beforeId as string | null;
        if (body.afterId !== undefined) {
          if (typeof body.afterId !== "string")
            throw new Error("invalid reorder anchor");
          const rest = lane.filter((card) => card.id !== work.fm.id);
          const at = rest.findIndex((card) => card.id === body.afterId);
          if (at < 0)
            throw new Error("reorder anchor changed; refresh the board");
          beforeId = rest[at + 1]?.id ?? null;
        }
        const rank = dropRank(lane, work.fm.id, beforeId);
        if (rank === null) return { id: work.fm.id, unchanged: true };
        const result = await setRank(store, config, work.fm.id, rank);
        await commitWrite(
          result.id,
          result.path,
          `${result.id} reordered`,
          config,
        );
        return result;
      });
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
    const to = body.to;
    try {
      const result = await ctx.mutate(async (store, config) => {
        const result = await setRank(store, config, c.req.param("id"), to);
        await commitWrite(
          result.id,
          result.path,
          `${result.id} rank ${result.from ?? "none"} → ${result.to ?? "none"}`,
          config,
        );
        return result;
      });
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
    const to = body.to;
    try {
      const result = await ctx.mutate(async (store, config) => {
        const result = await setEpic(store, config, c.req.param("id"), to);
        await commitWrite(
          result.id,
          result.path,
          `${result.id} epic ${result.from ?? "none"} → ${result.to ?? "none"}`,
          config,
        );
        return result;
      });
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
