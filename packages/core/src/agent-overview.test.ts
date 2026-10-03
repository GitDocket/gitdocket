import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { projectAgentOverview } from "./agent-overview";
import { loadMetadataBundle } from "./bundle";
import { type ActivityRow, buildCache, type GitEvidence } from "./cache";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { deriveOverview } from "./overview";
import { parseStateOfPlay, presentStateOfPlay } from "./state-of-play";

const now = new Date("2026-09-23T12:00:00Z");
test("encoded agent overview stays below 16 KiB for large UTF-8 metadata while preserving the next identity and explicit omissions", async () => {
  const files: [string, string][] = [];
  for (let i = 1; i < 7; i++) {
    files.push(work(i * 100, "Epic", "in-progress"));
    files.push(
      work(i * 100 + 1, "Task", "todo", `epic: /work/${i * 100}.md\n`),
    );
    files.push(
      work(i * 100 + 2, "Task", "in-progress", `epic: /work/${i * 100}.md\n`),
    );
  }
  const { candidates } = await models(files);
  for (const s of candidates.workstreams.current) {
    s.epic.path = `${"私".repeat(900)}/${s.epic.id}.md`;
    for (const t of [...s.now, ...s.next])
      t.path = `${"私".repeat(900)}/${t.id}.md`;
  }
  const r = projectAgentOverview(candidates, unavailable);
  expect(Buffer.byteLength(JSON.stringify(r, null, 2))).toBeLessThanOrEqual(
    16384,
  );
  expect(r.upNext?.id).toBe(candidates.upNext?.id);
  expect(r.budget.omittedForBytes).toBeGreaterThan(0);
  expect(r.workstreams.omitted + r.workstreams.items.length).toBe(
    r.workstreams.total,
  );
  expect(r.details.cli).toBe("docket overview --json --full");
});
const unavailable: GitEvidence = {
  status: "history-unavailable",
  checkpoint: null,
  activity: [],
  unmergedActivity: [],
  worktrees: [],
  truncated: false,
  reason: "No repository",
};
function work(
  id: number,
  type: "Task" | "Epic",
  status: string,
  extra = "",
  text = "",
): [string, string] {
  return [
    `work/${id}.md`,
    `---\ntype: ${type}\nid: DKT-${id}\ntitle: Work ${id}\nstatus: ${status}\n${extra}---\n\n${text}`,
  ];
}
async function models(files: [string, string][], activity: ActivityRow[] = []) {
  const bundle = await loadMetadataBundle(
    new InMemoryFileStore(new Map(files)),
    parseConfig(),
  );
  expect(bundle.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const db = new Database(":memory:");
  try {
    buildCache(db, bundle, activity);
    const full = deriveOverview(bundle, db, { now });
    const candidates = deriveOverview(bundle, db, {
      now,
      agentCandidates: true,
    });
    const brief = projectAgentOverview(candidates, unavailable);
    expect(deriveOverview(bundle, db, { now })).toEqual(full);
    return { full, candidates, brief };
  } finally {
    db.close();
  }
}

test("ten thousand active tasks remain discoverable through bounded nested selection", async () => {
  const files: [string, string][] = [work(1, "Epic", "in-progress")];
  for (let i = 2; i < 10002; i++)
    files.push(
      work(
        i,
        "Task",
        i % 2 ? "in-review" : "in-progress",
        "epic: /work/1.md\n",
      ),
    );
  const { brief, full } = await models(files);
  expect(full.workstreams.current[0]?.now.length).toBe(5000);
  const active = brief.workstreams.items[0]?.active;
  expect(active?.total).toBe(10000);
  expect(active?.omitted).toBe(9997);
  expect(new Set(active?.items.map((t) => t.status))).toEqual(
    new Set(["in-review", "in-progress"]),
  );
  expect(brief.needsAttention.total).toBe(10000);
  expect(JSON.stringify(brief).length).toBeLessThan(12000);
  expect(brief.details.mcp.arguments.view).toBe("full");
}, 10000);

test("review-only epics and standalone work survive removal of the execution overlay", async () => {
  const { full, brief } = await models([
    work(1, "Epic", "in-progress"),
    work(2, "Task", "in-review", "epic: /work/1.md\n"),
    work(3, "Task", "in-review"),
    work(4, "Task", "in-progress"),
    work(5, "Task", "todo"),
  ]);
  expect(full.workstreams.current).toEqual([]);
  expect(brief.workstreams.items[0]?.active.items[0]?.id).toBe("DKT-2");
  expect(brief.loose?.active.items.map((t) => t.id)).toEqual([
    "DKT-3",
    "DKT-4",
  ]);
  expect(brief.upNext?.id).toBe("DKT-5");
});

test("stream selection reserves next-ready review active and blocked representatives", async () => {
  const files: [string, string][] = [];
  for (let i = 1; i <= 20; i++)
    files.push(
      work(i, "Epic", "todo"),
      work(i + 100, "Task", "in-progress", `epic: /work/${i}.md\n`),
    );
  files.push(
    work(30, "Epic", "todo"),
    work(130, "Task", "todo", "epic: /work/30.md\npriority: p0\n"),
  );
  files.push(
    work(31, "Epic", "todo"),
    work(131, "Task", "in-review", "epic: /work/31.md\n"),
  );
  files.push(
    work(32, "Epic", "todo"),
    work(132, "Task", "blocked", "epic: /work/32.md\n"),
  );
  const { brief } = await models(files, [
    {
      taskId: "DKT-132",
      sha: "a".repeat(40),
      date: now.toISOString(),
      subject: "Blocked",
    },
  ]);
  const ids = brief.workstreams.items.map((s) => s.epic.id);
  expect(ids).toContain("DKT-30");
  expect(ids).toContain("DKT-31");
  expect(ids).toContain("DKT-32");
  expect(brief.workstreams.total).toBe(23);
  expect(brief.workstreams.omitted).toBe(18);
});

test("attention totals include overflow while preserving all available reason categories", async () => {
  const files: [string, string][] = [];
  for (let i = 1; i <= 20; i++) files.push(work(i, "Task", "blocked"));
  files.push(
    work(21, "Task", "in-progress"),
    work(22, "Epic", "todo"),
    work(23, "Task", "done", "epic: /work/22.md\n"),
  );
  const { brief, full } = await models(files);
  expect(full.execution.needsAttention).toHaveLength(5);
  expect(brief.needsAttention.total).toBe(22);
  expect(brief.needsAttention.omitted).toBe(17);
  expect(new Set(brief.needsAttention.items.map((t) => t.reason))).toEqual(
    new Set(["blocked", "stale", "needs-cleanup"]),
  );
});

test("long titles and dated context appear once as bounded excerpts; partial Git stays explicit", async () => {
  const { candidates } = await models([
    work(1, "Task", "todo").map((v, i) =>
      i ? v.replace("Work 1", "X".repeat(10000)) : v,
    ) as [string, string],
  ]);
  const note = parseStateOfPlay(
    `---\nformat: re-entry/v2\nas_of: ${"a".repeat(40)}\nreviewed_at: 2020-01-01T00:00:00Z\n---\n# Project re-entry\n\n## What we've done recently\n\n${"Old claims. ".repeat(1000)}\n\n## What's up next\n\nOld task.\n`,
  ).note;
  if (!note) throw new Error("invalid fixture");
  const git: GitEvidence = {
    ...unavailable,
    status: "available",
    historyComplete: false,
    truncated: true,
    reason: "partial ".repeat(1000),
    unmergedActivity: Array.from({ length: 50 }, (_, i) => ({
      taskId: `DKT-${i}`,
      sha: "b".repeat(40),
      date: now.toISOString(),
      subject: "subject ".repeat(1000),
      mergedIntoCurrentHead: false,
      refs: [],
      worktrees: [],
    })),
  };
  const brief = projectAgentOverview(
    candidates,
    git,
    presentStateOfPlay(note, 30, { now }),
  );
  expect(brief.upNext?.title?.length).toBe(160);
  expect(brief.context?.review.status).toBe("needs-review");
  expect(brief.context?.excerpt.text.length).toBe(1200);
  expect(brief.context?.excerpt.truncated).toBe(true);
  expect(brief.git.historyComplete).toBe(false);
  expect(brief.git.truncated).toBe(true);
  expect(brief.git.unmerged.observedTotal).toBe(50);
  expect(brief.git.unmerged.omitted).toBe(47);
  expect(brief.git.reason?.truncated).toBe(true);
  expect(brief).not.toHaveProperty("execution");
  expect(brief.git).not.toHaveProperty("activity");
  expect(brief.context).not.toHaveProperty("body");
});

test("unreadable context is reported without suppressing live work or leaking the read error", async () => {
  const { deriveRepositoryOverview } = await import("./orientation");
  const store = new InMemoryFileStore(new Map([work(1, "Task", "todo")]));
  const bundle = await loadMetadataBundle(store, parseConfig());
  const read = store.read.bind(store);
  store.read = async (path) => {
    if (path === "overview.md")
      throw Object.assign(new Error("private path details"), {
        code: "EACCES",
      });
    return read(path);
  };
  const brief = await deriveRepositoryOverview({
    bundle,
    store,
    config: parseConfig(),
    view: "brief",
  });
  expect(brief.contextProblem).toBe("unavailable");
  expect(brief.context).toBeNull();
  expect(brief.upNext?.id).toBe("DKT-1");
  expect(JSON.stringify(brief)).not.toContain("private path details");
});

test("current state is a bounded authored checkpoint with source identity, never lifecycle authority", async () => {
  const { full, brief } = await models([
    work(
      1,
      "Epic",
      "in-progress",
      "",
      "# Current state\n\nAwaiting owner review.\n",
    ),
    work(
      2,
      "Task",
      "in-progress",
      "epic: /work/1.md\n",
      `# Log\n\n${"Old checkpoint. ".repeat(500)}\n\n# Current state\n\nDone according to prose. ${"雪".repeat(1000)}\n`,
    ),
    work(
      3,
      "Task",
      "todo",
      "depends_on: [DKT-2]\n",
      "# Current state\n\nClaimed ready in prose.\n",
    ),
    work(4, "Task", "todo"),
    work(
      5,
      "Task",
      "done",
      "description: Former description\n",
      "# Current state\n\nOld checkpoint.\n\n# Outcome\n\nFinal accepted result.\n",
    ),
  ]);
  const item = brief.workstreams.items[0]?.active.items[0];
  expect(item?.status).toBe("in-progress");
  expect(item?.currentState?.text).toStartWith("Done according to prose.");
  expect(item?.currentState?.truncated).toBe(true);
  expect(item?.sourceVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(item?.path).toBe("work/2.md");
  expect(brief.workstreams.items[0]?.epic.currentState).toEqual({
    text: "Awaiting owner review.",
    truncated: false,
  });
  expect(brief.upNext?.id).toBe("DKT-4");
  expect(brief.upNext).not.toHaveProperty("currentState");
  expect(full.execution.shipped.find((i) => i.id === "DKT-5")?.summary).toBe(
    "Final accepted result.",
  );
  expect(Buffer.byteLength(JSON.stringify(brief, null, 2))).toBeLessThanOrEqual(
    16384,
  );
});
