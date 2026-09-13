import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@gitdocket/core";
import { createApp } from "./app";
import { createRepoContext, type RepoContext } from "./state";

let root: string, ctx: RepoContext, app: ReturnType<typeof createApp>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-collections-"));
  await mkdir(join(root, "docs/tasks"), { recursive: true });
  await mkdir(join(root, "docs/reference"));
  await writeFile(
    join(root, "docs/epic.md"),
    "---\ntype: Epic\nid: DKT-2000\ntitle: Exact path epic\nstatus: todo\n---\n",
  );
  for (let start = 1; start <= 180; start += 30)
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => {
        const n = start + i;
        return writeFile(
          join(root, `docs/tasks/${n}.md`),
          `---\ntype: Task\nid: DKT-${n}\ntitle: Task ${String(n).padStart(3, "0")}\nstatus: todo\nrank: ${n * 10}\npriority: p${n % 4}\ntags: [${n % 2 ? "odd" : "even"}]\nepic: /epic.md\n---\n\nneedle ${"large prose ".repeat(300)}\n`,
        );
      }),
    );
  await writeFile(
    join(root, "docs/reference/guide.md"),
    "---\ntype: Reference\ntitle: Guide\n---\nneedle\n",
  );
  await writeFile(
    join(root, "docs/log.md"),
    `# Log\n${"2026-09-11 DKT-1 needle entry\n".repeat(3000)}`,
  );
  ctx = createRepoContext(root, parseConfig("bundle: docs/"));
  app = createApp(ctx);
});
afterEach(async () => {
  ctx?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
const get = async (path: string) => {
  const response = await app.request(`http://localhost/api/${path}`);
  expect(response.status).toBe(200);
  return response.json();
};
test("task filters and ordering cover the complete inventory before paging; full clients remain compatible", async () => {
  const first = await get("tasks?page=1&limit=7&tag=even&sort=title&dir=desc");
  expect(first.total).toBe(181);
  expect(first.page.total).toBe(90);
  expect(first.items.map((r: { id: string }) => r.id)).toEqual(
    [180, 178, 176, 174, 172, 170, 168].map((n) => `DKT-${n}`),
  );
  const all = [];
  for (let page = 1; page <= 13; page++) {
    const data = await get(
      `tasks?page=${page}&limit=7&tag=even&sort=title&dir=desc&generation=${first.page.generation}`,
    );
    all.push(...data.items);
  }
  expect(new Set(all.map((r) => r.id)).size).toBe(90);
  expect(all.at(-1)?.id).toBe("DKT-2");
  const legacy = await get("tasks");
  expect(legacy.items.length).toBe(181);
  expect(legacy.page).toBeUndefined();
  const tiny = await get("tasks?page=1&limit=1&q=Task%20001");
  expect(tiny.page.total).toBe(1);
  expect(tiny.items[0].id).toBe("DKT-1");
  expect(JSON.stringify(first).length).toBeLessThan(5000);
});
test("invalid bounds and outdated generation are rejected", async () => {
  const first = await get("tasks?page=1");
  for (const suffix of [
    "page=0",
    "page=-1",
    "page=1&limit=101",
    "page=1&limit=NaN",
    "page=1.5",
  ])
    expect(
      (await app.request(`http://localhost/api/tasks?${suffix}`)).status,
    ).toBe(400);
  await writeFile(
    join(root, "docs/tasks/1.md"),
    (await Bun.file(join(root, "docs/tasks/1.md")).text()).replace(
      "Task 001",
      "Changed",
    ),
  );
  ctx.invalidate();
  expect(
    (
      await app.request(
        `http://localhost/api/tasks?page=2&generation=${first.page.generation}`,
      )
    ).status,
  ).toBe(409);
});
test("epic rollup uses resolved path; board filters and sort are global; drag below a page tail uses its real next neighbor", async () => {
  const epics = await get("epics?page=1");
  expect(epics.epics[0].total).toBe(180);
  const first = await get("board?page=1&limit=10");
  expect(first.cards.map((r: { id: string }) => r.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => `DKT-${i + 1}`),
  );
  const filtered = await get("board?page=2&limit=10&tag=even");
  expect(
    filtered.columns.find((c: { status: string }) => c.status === "todo").page
      .total,
  ).toBe(90);
  expect(filtered.cards[0].id).toBe("DKT-22");
  const result = await app.request("http://localhost/api/tasks/DKT-5/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      beforeId: null,
      afterId: "DKT-10",
      status: "todo",
      query: "",
    }),
  });
  expect(result.status).toBe(200);
  const current = await get("concept/tasks/5.md");
  expect(current.fm.rank).toBe(105);
  const next = await get("board?page=2&limit=10");
  expect(next.cards[0].id).toBe("DKT-11");
});
test("source and relationship pages retain all content and reject a rewritten source cursor", async () => {
  const activity = await get("activity?page=1");
  expect(activity.log).toBe("");
  expect(activity.logPath).toBe("log.md");
  const detail = await get("concept/log.md?page=1");
  expect(detail.html).toBe("");
  expect(detail.sourcePath).toBe("log.md");
  let cursor: unknown;
  let text = "";
  do {
    const page = await get(
      `source/log.md${cursor ? `?cursor=${encodeURIComponent(JSON.stringify(cursor))}` : ""}`,
    );
    expect(page.text.length).toBeLessThanOrEqual(16384);
    expect(page.startLine).toBeGreaterThan(0);
    text += page.text;
    cursor = page.nextCursor;
  } while (cursor);
  expect(text).toBe(await Bun.file(join(root, "docs/log.md")).text());
  const initial = await get("source/log.md");
  await writeFile(join(root, "docs/log.md"), "# Changed\n");
  ctx.invalidate();
  expect(
    (
      await app.request(
        `http://localhost/api/source/log.md?cursor=${encodeURIComponent(JSON.stringify(initial.nextCursor))}`,
      )
    ).status,
  ).toBe(409);
  const epic = await get("concept/epic.md?page=2&limit=20");
  expect(epic.graph.children.length).toBe(20);
  expect(epic.relationPage.total).toBe(180);
  expect(epic.graph.children[0].id).toBe("DKT-21");
});
test("bounded search preserves full ranking and totals without hydrating graph neighborhoods", async () => {
  const first = await get("search?q=needle&page=1&limit=10");
  expect(first.page.total).toBe(182);
  expect(first.hits.length).toBe(10);
  expect(first.hits[0].links).toBeUndefined();
  const all = [];
  for (let page = 1; page <= 19; page++)
    all.push(...(await get(`search?q=needle&page=${page}&limit=10`)).hits);
  const oracle = (await ctx.state()).search.search("needle", { limit: 1000 });
  expect(all.map((r) => r.path)).toEqual(oracle.map((r) => r.path));
  expect(all.every((r) => r.text.length <= 240)).toBeTrue();
  const facets = await get("facets?field=epic&q=DKT-2000");
  expect(facets.options[0].path).toBe("epic.md");
  const nav = await get("nav?summary=1");
  expect(nav.html).toBeUndefined();
  expect(nav.sections).toContain("reference");
});

test("search rejects mixed generations; task activity retains commits with multiple task trailers", async () => {
  const first = await get("search?q=needle&page=1");
  const state = await ctx.state();
  state.db.run(
    "INSERT INTO activity (task_id,sha,date,subject) VALUES ('DKT-1','shared','2026-09-11','Shared'), ('DKT-2','shared','2026-09-11','Shared'), ('DKT-1','solo','2026-09-10','Solo')",
  );
  const secondTask = await get("activity?page=1&task=DKT-2");
  expect(secondTask.activityTotal).toBe(1);
  expect(secondTask.activity.map((row: { sha: string }) => row.sha)).toEqual([
    "shared",
  ]);
  await writeFile(
    join(root, "docs/reference/guide.md"),
    "---\ntype: Reference\ntitle: Changed\n---\nneedle\n",
  );
  ctx.invalidate();
  expect(
    (
      await app.request(
        `http://localhost/api/search?q=needle&page=2&generation=${first.page.generation}`,
      )
    ).status,
  ).toBe(409);
});

test("bounded detail excludes full dependency frontmatter and pages configured verification; large Home sources stay source-backed", async () => {
  // A fresh config enables verification; inserted cache rows model resolved
  // marker output independently of filesystem scanning fixture setup.
  await writeFile(
    join(root, "docket.yaml"),
    "bundle: docs/\nverify:\n  markers: ['test/**/*.ts']\n",
  );
  await writeFile(
    join(root, "docs/reference/guide.md"),
    "---\ntype: Spec\ntitle: Guide\n---\n# Guide\n",
  );
  await writeFile(
    join(root, "docs/tasks/1.md"),
    "---\ntype: Task\nid: DKT-1\ntitle: Many dependencies\nstatus: todo\ndepends_on: [" +
      Array.from({ length: 179 }, (_, i) => `DKT-${i + 2}`).join(",") +
      "]\n---\n",
  );
  await writeFile(
    join(root, "docs/overview.md"),
    `# Context\n${"retained prose\n".repeat(5000)}`,
  );
  ctx.invalidate();
  const state = await ctx.state();
  for (let i = 0; i < 140; i++)
    state.db.run(
      "INSERT INTO verifications(concept_path,kind,source_path,line,anchor) VALUES (?,?,?,?,?)",
      [
        "reference/guide.md",
        "test",
        `test/${String(i).padStart(3, "0")}.ts`,
        i + 1,
        null,
      ],
    );
  const detail = await get("concept/reference/guide.md?page=2&limit=20");
  expect(detail.verification.groups[0].anchors[0].sources).toHaveLength(20);
  expect(detail.verification.groups[0].anchors[0].sources[0].line).toBe(21);
  expect(detail.relationPage.total).toBe(140);
  const task = await get("concept/tasks/1.md?page=1&limit=20");
  expect(task.fm.depends_on).toBeUndefined();
  expect(task.graph.deps).toHaveLength(20);
  expect(task.relationPage.total).toBe(179);
  const home = await get("home?briefing=1");
  expect(home.narrativeSourcePath).toBe("overview.md");
  expect(home.narrative).toBeNull();
});

test("Done history is complete and independently paged without changing other columns or filters", async () => {
  await Promise.all(
    Array.from({ length: 120 }, async (_, i) => {
      const path = join(root, `docs/tasks/${i + 1}.md`);
      await writeFile(
        path,
        (await Bun.file(path).text()).replace("status: todo", "status: done"),
      );
    }),
  );
  ctx.invalidate();
  const seen = new Set<string>();
  for (const page of [1, 2, 3]) {
    const data = await get(`board?page=1&epic=DKT-2000&column.done=${page}`);
    const done = data.columns.find(
      (column: { status: string }) => column.status === "done",
    );
    expect(done.page.total).toBe(120);
    expect(done.cards.length).toBeLessThanOrEqual(50);
    for (const card of done.cards) {
      expect(seen.has(card.id)).toBe(false);
      seen.add(card.id);
    }
    expect(
      data.columns.find(
        (column: { status: string }) => column.status === "todo",
      ).cards[0].id,
    ).toBe("DKT-121");
  }
  expect(seen.size).toBe(120);
  const empty = await get("board?page=1&epic=DKT-unknown");
  expect(empty.cards).toEqual([]);
});

test("readable log excerpts keep exact source, cursor identity and malformed-block fallback", async () => {
  const path = join(root, "docs/log.md");
  await writeFile(
    path,
    "# Project log\n\n## 2026-09-11\n\nAuthored **outcome** and [task](/tasks/1.md).\n",
  );
  ctx.invalidate();
  const first = await get("source/log.md?readable=1");
  expect(first.html).toContain("<strong>outcome</strong>");
  expect(first.html).toContain('href="#/work/1"');
  expect(first.text).toBe(await Bun.file(path).text());
  expect(first.partial).toBe(false);
  await writeFile(
    path,
    `# Project log\n\n\`\`\`\n${"unclosed code\n".repeat(3000)}`,
  );
  ctx.invalidate();
  const large = await get("source/log.md?readable=1");
  expect(large.html).toBeNull();
  expect(large.text.length).toBeLessThanOrEqual(16384);
  expect(large.nextCursor).toBeDefined();
});
