// API tests against a throwaway bundle on disk — the same surface the SPA
// consumes. No git repo underneath, so activity comes back empty (the cache
// scan degrades gracefully); trailer-derived activity is covered by the CLI
// index tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@gitdocket/core";
import type { Hono } from "hono";
import { createApp } from "./app";
import { createRepoContext } from "./state";

let root: string;
let app: Hono;
const NOW = new Date("2026-08-21T20:00:00Z");

const FILES: Record<string, string> = {
  "index.md":
    "# Fixture\n\nA project introduction.\n\n*(Everything below the marker is generated — edit nothing there by hand; run `bun run docket index`.)*\n\n<!-- docket:generated -->\n\n- [Feature](/specs/feature.md)\n",
  "specs/feature.md":
    "---\ntype: Spec\ntitle: The Feature\n---\n\n# Feature\n\nShipped by [DKT-1](/work/tasks/DKT-1-do.md).\n",
  "work/epics/DKT-2-fixture-epic.md":
    "---\ntype: Epic\ntitle: Fixture epic\nid: DKT-2\nstatus: in-progress\n---\n\n# E\n",
  "work/tasks/DKT-1-do.md":
    "---\ntype: Task\ntitle: Do the thing\nid: DKT-1\nstatus: todo\nepic: /work/epics/DKT-2-fixture-epic.md\npriority: p1\n---\n\n# Context\n",
  "work/tasks/DKT-3-later.md":
    "---\ntype: Task\ntitle: Do it later\nid: DKT-3\nstatus: todo\nepic: /work/epics/DKT-2-fixture-epic.md\ndepends_on: [DKT-1]\n---\n\n# Context\n",
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-web-"));
  for (const [path, content] of Object.entries(FILES)) {
    const abs = join(root, "docs", path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  // ttl 0: every request sees the working tree as-is, like an agent editing alongside
  app = createApp(
    createRepoContext(root, parseConfig("bundle: docs/"), { ttlMs: 0 }),
    undefined,
    { now: NOW },
  );
});

afterEach(() => rm(root, { recursive: true, force: true }));

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
};

describe("local request boundary", () => {
  test("accepts loopback hostnames and rejects non-local Host values", async () => {
    for (const url of [
      "http://localhost/api/nav",
      "http://127.0.0.1/api/nav",
      "http://[::1]/api/nav",
    ]) {
      expect((await app.request(url)).status).toBe(200);
    }

    const rejected = await app.request("http://project.example/api/nav");
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({
      error: "docket serve accepts requests from this computer only",
    });
  });

  test("rejects cross-origin writes before they reach the working tree", async () => {
    const rejected = await app.request(
      "http://localhost/api/tasks/DKT-1/status",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: JSON.stringify({ to: "in-progress" }),
      },
    );
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({
      error: "docket serve rejects cross-origin writes",
    });
    expect(
      await readFile(join(root, "docs/work/tasks/DKT-1-do.md"), "utf8"),
    ).toContain("status: todo");
  });

  test("accepts same-origin browser writes and origin-less local clients", async () => {
    const sameOrigin = await app.request(
      "http://localhost/api/tasks/DKT-1/status",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
        },
        body: JSON.stringify({ to: "in-progress" }),
      },
    );
    expect(sameOrigin.status).toBe(200);

    const originLess = await app.request(
      "http://localhost/api/tasks/DKT-1/priority",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "p0" }),
      },
    );
    expect(originLess.status).toBe(200);
  });
});

describe("wiki", () => {
  test("nav renders index.md with links rewritten to SPA routes", async () => {
    const { status, body } = await get("/api/nav");
    expect(status).toBe(200);
    expect(body.project).toBe("DKT");
    expect(body.html).toContain('href="#/c/specs/feature.md"');
    expect(body.sections).toEqual(["specs"]); // palette nav targets
  });

  test("concept page renders any file with frontmatter and backlinks", async () => {
    const { status, body } = await get("/api/concept/specs/feature.md");
    expect(status).toBe(200);
    expect(body.fm.type).toBe("Spec");
    expect(body.html).toContain('href="#/c/work/tasks/DKT-1-do.md"');
    expect(body.html).not.toContain("type: Spec"); // frontmatter stripped
    expect(body.verification).toBeNull(); // no verify config: fully dormant
  });

  test("task page carries readiness and backlinks from the graph", async () => {
    const { status, body } = await get("/api/concept/work/tasks/DKT-1-do.md");
    expect(status).toBe(200);
    expect(body.ready).toBe(true);
    // Inline edits read the configured state list from here.
    expect(body.states).toEqual([
      "todo",
      "in-progress",
      "blocked",
      "in-review",
      "done",
      "closed",
    ]);
    expect(body.backlinks).toEqual([
      { path: "specs/feature.md", title: "The Feature" },
    ]);
    expect(body.activity).toEqual([]);
  });

  test("task page carries epic breadcrumb and dependency statuses", async () => {
    const { body } = await get("/api/concept/work/tasks/DKT-3-later.md");
    expect(body.graph.epic).toEqual({
      path: "work/epics/DKT-2-fixture-epic.md",
      id: "DKT-2",
      title: "Fixture epic",
      status: "in-progress",
    });
    expect(body.graph.deps).toEqual([
      {
        path: "work/tasks/DKT-1-do.md",
        id: "DKT-1",
        title: "Do the thing",
        status: "todo",
      },
    ]);
    expect(body.graph.children).toEqual([]);
  });

  test("epic page derives its child tasks with status and readiness", async () => {
    const { body } = await get("/api/concept/work/epics/DKT-2-fixture-epic.md");
    expect(body.graph.epic).toBeNull();
    expect(body.graph.children).toEqual([
      {
        path: "work/tasks/DKT-1-do.md",
        id: "DKT-1",
        title: "Do the thing",
        status: "todo",
        ready: true,
      },
      {
        path: "work/tasks/DKT-3-later.md",
        id: "DKT-3",
        title: "Do it later",
        status: "todo",
        ready: false, // depends on DKT-1, which isn't done
      },
    ]);
  });

  test("non-work concepts carry no graph and render unchanged", async () => {
    const { body } = await get("/api/concept/specs/feature.md");
    expect(body.graph).toBeNull();
  });

  test("configured verification surfaces presence and the useful zero state", async () => {
    await writeFile(
      join(root, "docs", "specs", "bare.md"),
      "---\ntype: Spec\ntitle: Bare feature\n---\n\n# Bare\n",
    );
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(
      join(root, "tests", "feature.test.ts"),
      "// docket:verifies /specs/feature.md\n// docket:verifies /specs/feature.md#retry-behavior\n",
    );
    const configured = createApp(
      createRepoContext(
        root,
        parseConfig(
          'bundle: docs/\nverify:\n  tests:\n    - "tests/**/*.test.ts"\n',
        ),
        { ttlMs: 0 },
      ),
    );
    const configuredGet = async (path: string) => {
      const res = await configured.request(path);
      return { status: res.status, body: await res.json() };
    };

    const feature = (await configuredGet("/api/concept/specs/feature.md")).body;
    expect(feature.verification).toEqual({
      groups: [
        {
          kind: "test",
          anchors: [
            {
              anchor: null,
              sources: [{ path: "tests/feature.test.ts", line: 1 }],
            },
            {
              anchor: "retry-behavior",
              sources: [{ path: "tests/feature.test.ts", line: 2 }],
            },
          ],
        },
      ],
    });
    expect(Object.keys(feature.verification)).toEqual(["groups"]);

    const bare = (await configuredGet("/api/concept/specs/bare.md")).body;
    expect(bare.verification).toEqual({ groups: [] });

    const home = (await configuredGet("/api/home")).body;
    expect(home.unverifiedSpecs).toBeUndefined();
  });

  test("home API carries the note and compatible core model without display-only fields", async () => {
    const { status, body } = await get("/api/home");
    expect(status).toBe(200);

    // Hand-written preamble renders; the generated link dump does not.
    expect(body.preamble).toContain("Fixture");
    expect(body.preamble).toContain("project introduction");
    expect(body.preamble).not.toContain("feature.md");
    expect(body.preamble).not.toContain("docket index");
    expect(body.preamble).not.toContain("below the marker");
    expect(body.narrative).toBeNull(); // optional: no placeholder
    expect(body.unverifiedSpecs).toBeUndefined();

    // The API carries the core model as one value: DKT-1 is globally next and
    // is the fixture epic's only ready task; DKT-3 remains dependency-blocked.
    expect(body.inProgress).toBeUndefined();
    expect(body.ready).toBeUndefined();
    expect(body.overview.upNext.id).toBe("DKT-1");
    expect(body.overview.workstreams).toEqual({
      current: [
        expect.objectContaining({
          epic: expect.objectContaining({ id: "DKT-2" }),
          progress: { done: 0, total: 2 },
          now: [],
          next: [expect.objectContaining({ id: "DKT-1" })],
          nextTotal: 1,
          blockedOnly: false,
        }),
      ],
      recentOnly: [],
    });
    expect(body.overview.loose).toBeNull();
    expect(body.taskCounts).toBeUndefined();
    expect(body.epics).toBeUndefined();
    expect(body.activity).toBeUndefined();
    expect(body.sections).toBeUndefined();
  });

  test("home exposes structured product context above the skeleton payload", async () => {
    await mkdir(join(root, "docs", "decisions"), { recursive: true });
    await writeFile(
      join(root, "docs", "decisions", "DEC-1.md"),
      `---
type: Decision
title: One shared model
id: DEC-1
status: accepted
---

# Context

Duplicate summaries drift.

# Decision

Derive execution once in core.

# Consequences

Home and agents consume the same groups.
`,
    );
    await writeFile(
      join(root, "docs", "overview.md"),
      `---
format: re-entry/v2
as_of: abc1234
reviewed_at: 2026-08-20T20:00:00Z
---

## What we've done recently

- Shipped a **shared overview** for people and agents.

## What's up next

- Simplify the [Home briefing](/work/epics/DKT-92.md).

## Worth knowing

- [The model](/decisions/DEC-1.md)
`,
    );
    const { body } = await get("/api/home");
    expect(body.narrative).toEqual(
      expect.objectContaining({
        format: "re-entry/v2",
        asOf: "abc1234",
        reviewedAt: "2026-08-20T20:00:00Z",
        recent: "- Shipped a **shared overview** for people and agents.",
        next: "- Simplify the [Home briefing](/work/epics/DKT-92.md).",
        worthKnowing: "- [The model](/decisions/DEC-1.md)",
        decisionLinks: ["/decisions/DEC-1.md"],
        taskCommitsAgo: null, // fixture is deliberately not a Git repo
        review: expect.objectContaining({ status: "age-unavailable" }),
        sectionHtml: expect.objectContaining({
          recent:
            "<ul>\n<li>Shipped a <strong>shared overview</strong> for people and agents.</li>\n</ul>",
          next: expect.stringContaining("Home briefing"),
          worthKnowing: expect.stringContaining("The model"),
        }),
      }),
    );
    expect(body.overview.upNext.id).toBe("DKT-1");
    expect(body.overview.execution.decisions).toEqual([
      expect.objectContaining({
        id: "DEC-1",
        choice: "Derive execution once in core.",
        rationale: "Duplicate summaries drift.",
        consequence: "Home and agents consume the same groups.",
        curated: true,
      }),
    ]);
  });

  test("home keeps re-entry/v1 readable without presenting it as current", async () => {
    await writeFile(
      join(root, "docs", "overview.md"),
      `---
format: re-entry/v1
as_of: abc1234
reviewed_at: 2026-08-20T20:00:00Z
---

## Product orientation

Earlier orientation.

## Current outcome

Earlier outcome.

## Current bet

Earlier bet.

## Evidence and learning

Earlier evidence.

## Principal risk

Earlier risk.

## Next decision

Earlier decision.

## Material decisions

No linked decisions.
`,
    );
    const { body } = await get("/api/home");
    expect(body.narrative).toEqual(
      expect.objectContaining({
        format: "re-entry/v1",
        orientation: "Earlier orientation.",
        assessment: expect.objectContaining({ outcome: "Earlier outcome." }),
        review: expect.objectContaining({
          status: "needs-review",
          reasons: ["superseded-format", "git-age-unavailable"],
        }),
        html: expect.stringContaining("Product orientation"),
      }),
    );
    expect(body.narrative.sectionHtml).toBeUndefined();
    expect(body.overview.upNext.id).toBe("DKT-1");
  });

  test("malformed product context is ignored without suppressing live execution", async () => {
    await writeFile(join(root, "docs", "overview.md"), "No watermark.\n");
    const { body } = await get("/api/home");
    expect(body.narrative).toBeNull();
    expect(body.overview.upNext.id).toBe("DKT-1");
  });

  test("home ignores obsolete reader-baseline query state", async () => {
    const { body } = await get(
      "/api/home?after=definitely-invalid&afterTime=2026-08-20T00%3A00%3A00Z",
    );
    expect(body.overview.execution.scope.requested).toBeNull();
    expect(body.overview.execution.scope.mode).not.toBe("baseline-invalid");
    expect(body.overview.execution.upNext[0].id).toBe("DKT-1");
  });

  test("docs endpoint lists every section with its articles", async () => {
    const { status, body } = await get("/api/docs");
    expect(status).toBe(200);
    expect(body.sections).toEqual([
      {
        name: "specs",
        items: [
          { path: "specs/feature.md", title: "The Feature", description: null },
        ],
      },
    ]);
  });

  test("docs sections follow reading order; articles newest-first", async () => {
    const spec = (name: string, ts?: string) =>
      writeFile(
        join(root, "docs", "specs", `${name}.md`),
        `---\ntype: Spec\ntitle: ${name}\n${ts ? `timestamp: ${ts}\n` : ""}---\n\nx\n`,
      );
    await spec("older", "2026-07-01T00:00:00Z");
    await spec("newer", "2026-07-15T00:00:00Z");
    await mkdir(join(root, "docs", "decisions"), { recursive: true });
    await writeFile(
      join(root, "docs", "decisions", "DEC-1-x.md"),
      "---\ntype: Decision\ntitle: X\nid: DEC-1\n---\n\nx\n",
    );

    const { body } = await get("/api/docs");
    // specs lead decisions per SECTION_ORDER even though "d" < "s".
    expect(body.sections.map((s: { name: string }) => s.name)).toEqual([
      "specs",
      "decisions",
    ]);
    // feature.md has no timestamp, so it trails the stamped pair.
    expect(body.sections[0].items.map((i: { path: string }) => i.path)).toEqual(
      ["specs/newer.md", "specs/older.md", "specs/feature.md"],
    );
  });

  test("activity endpoint serves the full feed", async () => {
    const { status, body } = await get("/api/activity");
    expect(status).toBe(200);
    expect(body.activity).toEqual([]); // no git repo under the fixture
    expect(body.log).toBe(""); // no log.md either — degrades to feed-only
  });

  test("activity endpoint renders log.md with rewritten links", async () => {
    await writeFile(
      join(root, "docs", "log.md"),
      "# Log\n\n- **Create** — [The Feature](/specs/feature.md) filed.\n",
    );
    const { body } = await get("/api/activity");
    expect(body.log).toContain("<h1>Log</h1>");
    expect(body.log).toContain('href="#/c/specs/feature.md"');
  });

  test("search endpoint returns core-ranked hits", async () => {
    const { status, body } = await get("/api/search?q=do%20thing");
    expect(status).toBe(200);
    // Both terms hit DKT-1's title; the partial-match files rank below.
    expect(body.hits[0].id).toBe("DKT-1");
    expect(body.hits[0].title).toBe("Do the thing");
    expect((await get("/api/search?q=")).body.hits).toEqual([]);
  });

  test("missing files 404, traversal 400", async () => {
    expect((await get("/api/concept/nope.md")).status).toBe(404);
    // encoded slash survives URL normalization and only decodes at the param layer
    expect((await get("/api/concept/..%2Fdocket.yaml")).status).toBe(400);
  });
});

describe("board and epics", () => {
  test("board serves cards from the cache in configured state order", async () => {
    const { status, body } = await get("/api/board");
    expect(status).toBe(200);
    expect(body.states).toEqual([
      "todo",
      "in-progress",
      "blocked",
      "in-review",
      "done",
      "closed",
    ]);
    // Epic/tags/assignee ride on each card for client-side filtering and
    // swimlanes.
    const epic = {
      path: "work/epics/DKT-2-fixture-epic.md",
      id: "DKT-2",
      title: "Fixture epic",
    };
    expect(body.cards).toEqual([
      {
        status: "todo",
        priority: "p1",
        rank: null,
        id: "DKT-1",
        title: "Do the thing",
        path: "work/tasks/DKT-1-do.md",
        timestamp: null,
        epic,
        tags: [],
        assignee: null,
      },
      {
        status: "todo",
        priority: "p2", // schema default
        rank: null,
        id: "DKT-3",
        title: "Do it later",
        path: "work/tasks/DKT-3-later.md",
        timestamp: null,
        epic,
        tags: [],
        assignee: null,
      },
    ]);
    expect(body.totals).toEqual({ todo: 2 });
  });

  test("board cards surface tags and assignee from frontmatter", async () => {
    await writeFile(
      join(root, "docs", "work", "tasks", "DKT-4-solo.md"),
      "---\ntype: Task\ntitle: Solo\nid: DKT-4\nstatus: todo\ntags: [web]\nassignee: agent\n---\n\nx\n",
    );
    const { body } = await get("/api/board");
    const solo = body.cards.find((c: { id: string }) => c.id === "DKT-4");
    expect(solo).toMatchObject({
      epic: null,
      tags: ["web"],
      assignee: "agent",
    });
  });

  test("terminal columns cap independently with true totals", async () => {
    for (let i = 10; i < 30; i++) {
      await writeFile(
        join(root, "docs", "work", "tasks", `DKT-${i}-t.md`),
        `---\ntype: Task\ntitle: T${i}\nid: DKT-${i}\nstatus: done\ntimestamp: 2026-07-${String(i - 9).padStart(2, "0")}T00:00:00Z\n---\n\nx\n`,
      );
    }
    for (let i = 30; i < 50; i++) {
      await writeFile(
        join(root, "docs", "work", "tasks", `DKT-${i}-t.md`),
        `---\ntype: Task\ntitle: T${i}\nid: DKT-${i}\nstatus: closed\ntimestamp: 2026-08-${String(i - 29).padStart(2, "0")}T00:00:00Z\n---\n\nx\n`,
      );
    }
    const { body } = await get("/api/board");
    const done = body.cards.filter(
      (card: { status: string }) => card.status === "done",
    );
    expect(done).toHaveLength(15);
    expect(body.totals.done).toBe(20);
    const closed = body.cards.filter(
      (card: { status: string }) => card.status === "closed",
    );
    expect(closed).toHaveLength(15);
    expect(body.totals.closed).toBe(20);
    // Newest close first; the five oldest fell off.
    expect(done[0].id).toBe("DKT-29");
    expect(done.some((card: { id: string }) => card.id === "DKT-10")).toBe(
      false,
    );
  });

  test("all-tasks listing carries every work item with facets", async () => {
    const { status, body } = await get("/api/tasks");
    expect(status).toBe(200);
    expect(body.states).toEqual([
      "todo",
      "in-progress",
      "blocked",
      "in-review",
      "done",
      "closed",
    ]);
    // Tasks AND epics, newest id first.
    expect(body.items).toEqual([
      {
        path: "work/tasks/DKT-3-later.md",
        id: "DKT-3",
        type: "Task",
        title: "Do it later",
        status: "todo",
        priority: "p2",
        tags: [],
        ready: false, // depends on DKT-1
        epic: {
          path: "work/epics/DKT-2-fixture-epic.md",
          id: "DKT-2",
          title: "Fixture epic",
        },
      },
      {
        path: "work/epics/DKT-2-fixture-epic.md",
        id: "DKT-2",
        type: "Epic",
        title: "Fixture epic",
        status: "in-progress",
        priority: "p2",
        tags: [],
        ready: false,
        epic: null,
      },
      {
        path: "work/tasks/DKT-1-do.md",
        id: "DKT-1",
        type: "Task",
        title: "Do the thing",
        status: "todo",
        priority: "p1",
        tags: [],
        ready: true,
        epic: {
          path: "work/epics/DKT-2-fixture-epic.md",
          id: "DKT-2",
          title: "Fixture epic",
        },
      },
    ]);
  });

  test("all-tasks listing surfaces tags from frontmatter", async () => {
    await writeFile(
      join(root, "docs", "work", "tasks", "DKT-4-tagged.md"),
      "---\ntype: Task\ntitle: Tagged\nid: DKT-4\nstatus: todo\ntags: [web, ux]\n---\n\nx\n",
    );
    const { body } = await get("/api/tasks");
    expect(body.items[0]).toMatchObject({ id: "DKT-4", tags: ["web", "ux"] });
  });

  test("epic rollup counts tasks and carries the list facets", async () => {
    const { body } = await get("/api/epics");
    expect(body.states).toContain("in-progress"); // status filter options
    expect(body.epics).toEqual([
      {
        path: "work/epics/DKT-2-fixture-epic.md",
        id: "DKT-2",
        title: "Fixture epic",
        status: "in-progress",
        priority: "p2",
        tags: [],
        total: 2,
        done: 0,
        closed: 0,
        needsCleanup: false,
        lastActivity: "", // nothing in the fixture is stamped
      },
    ]);
  });

  test("epic rollups refresh cleanup classification after status reconciliation", async () => {
    const move = (id: string, to: string) =>
      app.request(`/api/tasks/${id}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to }),
      });

    expect((await move("DKT-1", "done")).status).toBe(200);
    expect((await move("DKT-3", "done")).status).toBe(200);
    expect((await get("/api/epics")).body.epics[0]).toMatchObject({
      id: "DKT-2",
      status: "in-progress",
      done: 2,
      total: 2,
      needsCleanup: true,
    });

    expect((await move("DKT-2", "done")).status).toBe(200);
    expect((await get("/api/epics")).body.epics[0]).toMatchObject({
      id: "DKT-2",
      status: "done",
      needsCleanup: false,
    });
  });

  test("epics order open-first then most recent activity", async () => {
    const epic = (id: number, status: string, ts?: string) =>
      writeFile(
        join(root, "docs", "work", "epics", `DKT-${id}-e.md`),
        `---\ntype: Epic\ntitle: E${id}\nid: DKT-${id}\nstatus: ${status}\n${ts ? `timestamp: ${ts}\n` : ""}---\n\nx\n`,
      );
    await epic(40, "done", "2026-07-19T00:00:00Z");
    await epic(41, "in-progress", "2026-07-10T00:00:00Z");
    // A fresh task under DKT-41 outranks DKT-42's own newer epic stamp.
    await writeFile(
      join(root, "docs", "work", "tasks", "DKT-43-t.md"),
      "---\ntype: Task\ntitle: T\nid: DKT-43\nstatus: done\nepic: /work/epics/DKT-41-e.md\ntimestamp: 2026-07-20T00:00:00Z\n---\n\nx\n",
    );
    await epic(42, "todo", "2026-07-12T00:00:00Z");

    const { body } = await get("/api/epics");
    // Open epics by activity desc (fixture epic has no stamps → last of the
    // open group), then the done epic despite its recent stamp.
    expect(body.epics.map((e: { id: string }) => e.id)).toEqual([
      "DKT-41",
      "DKT-42",
      "DKT-2",
      "DKT-40",
    ]);

    // Home no longer fetches a second epic rollup; the full inventory stays
    // available from this dedicated endpoint.
    expect((await get("/api/home")).body.epics).toBeUndefined();
  });
});

describe("status writes", () => {
  const move = (id: string, to: unknown, note?: string) =>
    app.request(`/api/tasks/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, note }),
    });

  test("drag lands in the working tree through core ops", async () => {
    const res = await move("DKT-1", "in-progress");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: "todo", to: "in-progress" });

    const file = await readFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "utf8",
    );
    expect(file).toContain("status: in-progress");

    const board = await get("/api/board");
    expect(board.body.cards[0].status).toBe("in-progress");
  });

  test("closed writes require and preserve a disposition without satisfying dependencies", async () => {
    expect((await move("DKT-1", "closed")).status).toBe(400);
    const res = await move(
      "DKT-1",
      "closed",
      "The request was superseded before completion.",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: "todo", to: "closed" });
    expect(
      await readFile(join(root, "docs/work/tasks/DKT-1-do.md"), "utf8"),
    ).toContain("The request was superseded before completion.");

    const tasks = (await get("/api/tasks")).body.items as {
      id: string;
      ready: boolean;
    }[];
    expect(tasks.find((item) => item.id === "DKT-3")?.ready).toBe(false);
    expect((await move("DKT-1", "todo", "reopen")).status).toBe(400);
  });

  test("with a committer wired, a write commits its own file", async () => {
    const calls: { paths: string[]; message: string }[] = [];
    const committing = createApp(
      createRepoContext(root, parseConfig("bundle: docs/"), { ttlMs: 0 }),
      undefined,
      {
        commit: async (op) => {
          calls.push(op);
        },
      },
    );
    const res = await committing.request("/api/tasks/DKT-1/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "in-progress" }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.paths).toEqual(["work/tasks/DKT-1-do.md"]);
    expect(calls[0]?.message).toStartWith(
      "chore(docket): DKT-1 todo → in-progress (serve)",
    );
    expect(calls[0]?.message).toContain("Task: DKT-1");
  });

  test("rejected ops never reach the committer; a failing committer never fails the op", async () => {
    let attempts = 0;
    const failing = createApp(
      createRepoContext(root, parseConfig("bundle: docs/"), { ttlMs: 0 }),
      undefined,
      {
        commit: async () => {
          attempts++;
          throw new Error("no git identity");
        },
      },
    );
    const post = (to: string) =>
      failing.request("/api/tasks/DKT-1/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to }),
      });

    expect((await post("bogus")).status).toBe(400);
    expect(attempts).toBe(0); // invalid op: no commit attempt

    const ok = await post("in-progress");
    expect(ok.status).toBe(200); // write landed; commit failure only logs
    expect(attempts).toBe(1);
    const file = await readFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "utf8",
    );
    expect(file).toContain("status: in-progress");
  });

  test("state machine rejects invalid transitions and unknown statuses", async () => {
    const invalid = await move("DKT-1", "in-review"); // todo → in-review isn't in the table
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toContain("invalid transition");

    expect((await move("DKT-1", "bogus")).status).toBe(400);
    expect((await move("DKT-99", "in-progress")).status).toBe(400);
  });
});

describe("field writes", () => {
  const post = (id: string, field: string, to: unknown) =>
    app.request(`/api/tasks/${id}/${field}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    });

  test("priority edit lands in the file and the next read reflects it", async () => {
    const res = await post("DKT-1", "priority", "p0");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: "p1", to: "p0" });

    const file = await readFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "utf8",
    );
    expect(file).toContain("priority: p0");

    const tasks = await get("/api/tasks");
    expect(
      tasks.body.items.find((i: { id: string }) => i.id === "DKT-1").priority,
    ).toBe("p0");
  });

  test("rank write persists, orders the board, and clears", async () => {
    // DKT-3 above DKT-1 despite DKT-1's higher priority — rank wins.
    expect((await post("DKT-3", "rank", 10)).status).toBe(200);
    const res = await post("DKT-1", "rank", 20);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ from: null, to: 20 });
    expect(
      await readFile(join(root, "docs/work/tasks/DKT-1-do.md"), "utf8"),
    ).toContain("priority: p1\nrank: 20\n");

    const board = await get("/api/board");
    expect(
      board.body.cards
        .filter((c: { status: string }) => c.status === "todo")
        .map((c: { id: string }) => c.id),
    ).toEqual(["DKT-3", "DKT-1"]);

    const cleared = await post("DKT-1", "rank", null);
    expect(await cleared.json()).toMatchObject({ from: 20, to: null });
    expect(
      await readFile(join(root, "docs/work/tasks/DKT-1-do.md"), "utf8"),
    ).not.toContain("rank:");
  });

  test("epic edit clears and re-links through core ops", async () => {
    const cleared = await post("DKT-1", "epic", null);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      from: "/work/epics/DKT-2-fixture-epic.md",
      to: null,
    });
    expect(
      await readFile(join(root, "docs/work/tasks/DKT-1-do.md"), "utf8"),
    ).not.toContain("epic:");

    const relinked = await post(
      "DKT-1",
      "epic",
      "/work/epics/DKT-2-fixture-epic.md",
    );
    expect(relinked.status).toBe(200);
    expect(
      await readFile(join(root, "docs/work/tasks/DKT-1-do.md"), "utf8"),
    ).toContain("epic: /work/epics/DKT-2-fixture-epic.md");
  });

  test("invalid values are rejected server-side, nothing written", async () => {
    expect((await post("DKT-1", "priority", "p9")).status).toBe(400);
    expect((await post("DKT-1", "priority", 3)).status).toBe(400);
    expect((await post("DKT-1", "rank", "top")).status).toBe(400); // numbers only
    expect((await post("DKT-2", "rank", 10)).status).toBe(400); // epics don't rank

    const missing = await post("DKT-1", "epic", "/work/epics/nope.md");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("no epic at");

    // Epics don't nest; a task is not a valid epic target.
    expect(
      (await post("DKT-2", "epic", "/work/epics/DKT-2-fixture-epic.md")).status,
    ).toBe(400);
    expect(
      (await post("DKT-1", "epic", "/work/tasks/DKT-3-later.md")).status,
    ).toBe(400);

    const file = await readFile(
      join(root, "docs/work/tasks/DKT-1-do.md"),
      "utf8",
    );
    expect(file).toContain("priority: p1"); // untouched
    expect(file).toContain("epic: /work/epics/DKT-2-fixture-epic.md");
  });

  test("field writes carry descriptive audit-commit subjects", async () => {
    const calls: { paths: string[]; message: string }[] = [];
    const committing = createApp(
      createRepoContext(root, parseConfig("bundle: docs/"), { ttlMs: 0 }),
      undefined,
      {
        commit: async (op) => {
          calls.push(op);
        },
      },
    );
    const res = await committing.request("/api/tasks/DKT-1/priority", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "p2" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.message).toStartWith(
      "chore(docket): DKT-1 priority p1 → p2 (serve)",
    );
    expect(calls[0]?.message).toContain("Task: DKT-1");
  });
});
