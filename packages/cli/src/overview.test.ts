import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OverviewExecutionSummary,
  OverviewModel,
} from "@docket/core/overview";
import { renderOverview } from "./overview";

const CLI = join(import.meta.dir, "index.ts");

const task = (id: string, title: string, priority = "p2") => ({
  path: `work/tasks/${id}.md`,
  id,
  title,
  status: "todo" as const,
  priority: priority as "p2",
  rank: null,
});

const emptyExecution = (): OverviewExecutionSummary => ({
  checkpoint: { revision: null, time: null },
  scope: {
    mode: "history-unavailable",
    after: null,
    requested: null,
    fallback: "history-unavailable",
  },
  shipped: [],
  inFlight: [],
  upNext: [],
  needsAttention: [],
  changes: [],
  decisions: [],
});

describe("renderOverview", () => {
  test("renders a terse state instead of a derived dashboard when no note exists", () => {
    const next = task("DKT-3", "First");
    const model: OverviewModel = {
      upNext: next,
      workstreams: {
        current: [
          {
            epic: {
              path: "work/epics/DKT-1.md",
              id: "DKT-1",
              title: "Main stream",
              status: "in-progress",
              priority: "p1",
            },
            progress: { done: 1, total: 4 },
            needsCleanup: false,
            now: [{ ...task("DKT-2", "Moving", "p1"), status: "in-progress" }],
            next: [next, task("DKT-4", "Second")],
            nextTotal: 3,
            blockedOnly: false,
            lastActivity: "2026-08-06T00:00:00Z",
          },
        ],
        recentOnly: [],
      },
      loose: {
        now: [],
        next: [task("DKT-8", "Unparented")],
        nextTotal: 1,
        blockedOnly: false,
        lastActivity: null,
      },
      execution: emptyExecution(),
    };

    expect(renderOverview(model)).toBe(
      "Project re-entry\nNo usable project re-entry note is available.",
    );
  });

  test("does not resurrect blocked or recently moved sections without a note", () => {
    expect(
      renderOverview({
        upNext: null,
        workstreams: {
          current: [
            {
              epic: {
                path: "work/epics/DKT-1.md",
                id: "DKT-1",
                title: "Blocked",
                status: "blocked",
                priority: "p2",
              },
              progress: { done: 0, total: 1 },
              needsCleanup: false,
              now: [],
              next: [],
              nextTotal: 0,
              blockedOnly: true,
              lastActivity: null,
            },
          ],
          recentOnly: [
            {
              epic: {
                path: "work/epics/DKT-2.md",
                id: "DKT-2",
                title: "Recent",
                status: "todo",
                priority: "p2",
              },
              progress: { done: 1, total: 1 },
              needsCleanup: true,
              now: [],
              next: [],
              nextTotal: 0,
              blockedOnly: false,
              lastActivity: "2026-08-06T00:00:00Z",
            },
          ],
        },
        loose: null,
        execution: emptyExecution(),
      }),
    ).toBe("Project re-entry\nNo usable project re-entry note is available.");
  });

  test("renders structured product context and freshness as the whole briefing", () => {
    const rendered = renderOverview(
      {
        upNext: null,
        workstreams: { current: [], recentOnly: [] },
        loose: null,
        execution: emptyExecution(),
      },
      {
        format: "re-entry/v2",
        asOf: "abcdef0123456789",
        reviewedAt: "2026-08-20T00:00:00Z",
        body: "structured source",
        recent: "- Shipped the shared overview.",
        next: "- Run the re-entry probe.",
        worthKnowing: "- [One model](/decisions/DEC-1.md).",
        links: ["/decisions/DEC-1.md"],
        decisionLinks: ["/decisions/DEC-1.md"],
        taskCommitsAgo: 3,
        review: {
          status: "current",
          reasons: [],
          reviewedDaysAgo: 1,
          maxDays: 14,
        },
      },
    );
    expect(rendered).toStartWith(
      "Project re-entry\nWhat we've done recently\n- Shipped the shared overview.\n\nWhat's up next\n- Run the re-entry probe.\n\nWorth knowing\n- [One model](/decisions/DEC-1.md).",
    );
    expect(rendered).toEndWith(
      "as of abcdef0, 3 task-linked commits ago; reviewed 2026-08-20T00:00:00Z",
    );
    expect(rendered).not.toContain("Execution summary");
    expect(rendered).not.toContain("Up next  nothing ready");
  });

  test("keeps re-entry/v1 readable and explicitly superseded", () => {
    const rendered = renderOverview(
      {
        upNext: null,
        workstreams: { current: [], recentOnly: [] },
        loose: null,
        execution: emptyExecution(),
      },
      {
        format: "re-entry/v1",
        asOf: "abcdef0123456789",
        reviewedAt: "2026-08-20T00:00:00Z",
        body: "## Product orientation\n\nEarlier structured context.",
        orientation: "Earlier structured context.",
        assessment: {
          outcome: "Earlier outcome.",
          bet: "Earlier bet.",
          evidence: "Earlier evidence.",
          risk: "Earlier risk.",
          nextDecision: "Earlier decision.",
          decisions: "No links.",
          decisionLinks: [],
        },
        taskCommitsAgo: 0,
        review: {
          status: "needs-review",
          reasons: ["superseded-format"],
          reviewedDaysAgo: 1,
          maxDays: 14,
        },
      },
    );
    expect(rendered).toStartWith(
      "Earlier product context — context needs review\n## Product orientation\n\nEarlier structured context.",
    );
  });
});

describe("docket overview", () => {
  let repo: string | undefined;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = undefined;
  });

  test("emits the core model verbatim as JSON without writing repo state", async () => {
    repo = await mkdtemp(join(tmpdir(), "docket-overview-"));
    await mkdir(join(repo, "docket", "work", "epics"), { recursive: true });
    await mkdir(join(repo, "docket", "work", "tasks"), { recursive: true });
    await writeFile(
      join(repo, "docket.yaml"),
      "bundle: docket/\nproject: DKT\n",
    );
    await writeFile(
      join(repo, "docket", "work", "epics", "DKT-1-main.md"),
      "---\ntype: Epic\ntitle: Main\nid: DKT-1\nstatus: todo\n---\n",
    );
    await writeFile(
      join(repo, "docket", "work", "tasks", "DKT-2-moving.md"),
      "---\ntype: Task\ntitle: Moving\nid: DKT-2\nstatus: in-progress\nepic: /work/epics/DKT-1-main.md\npriority: p1\n---\n",
    );
    await writeFile(
      join(repo, "docket", "work", "tasks", "DKT-3-next.md"),
      "---\ntype: Task\ntitle: Next\nid: DKT-3\nstatus: todo\nepic: /work/epics/DKT-1-main.md\npriority: p2\n---\n",
    );

    const result = Bun.spawnSync(["bun", CLI, "overview", "--json"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      upNext: {
        path: "work/tasks/DKT-3-next.md",
        id: "DKT-3",
        title: "Next",
        status: "todo",
        priority: "p2",
        rank: null,
      },
      workstreams: {
        current: [
          {
            epic: {
              path: "work/epics/DKT-1-main.md",
              id: "DKT-1",
              title: "Main",
              status: "todo",
              priority: "p2",
            },
            progress: { done: 0, total: 2 },
            needsCleanup: false,
            now: [
              {
                path: "work/tasks/DKT-2-moving.md",
                id: "DKT-2",
                title: "Moving",
                status: "in-progress",
                priority: "p1",
                rank: null,
              },
            ],
            next: [
              {
                path: "work/tasks/DKT-3-next.md",
                id: "DKT-3",
                title: "Next",
                status: "todo",
                priority: "p2",
                rank: null,
              },
            ],
            nextTotal: 1,
            blockedOnly: false,
            lastActivity: null,
          },
        ],
        recentOnly: [],
      },
      loose: null,
      execution: {
        ...emptyExecution(),
        inFlight: [
          {
            path: "work/tasks/DKT-2-moving.md",
            id: "DKT-2",
            title: "Moving",
            status: "in-progress",
            summary: "Moving",
            occurredAt: null,
            supportingConcepts: [
              {
                path: "work/epics/DKT-1-main.md",
                id: "DKT-1",
                title: "Main",
              },
            ],
          },
        ],
        upNext: [
          {
            path: "work/tasks/DKT-3-next.md",
            id: "DKT-3",
            title: "Next",
            status: "todo",
            summary: "Next",
            occurredAt: null,
            supportingConcepts: [
              {
                path: "work/epics/DKT-1-main.md",
                id: "DKT-1",
                title: "Main",
              },
            ],
          },
        ],
        needsAttention: [
          {
            path: "work/tasks/DKT-2-moving.md",
            id: "DKT-2",
            title: "Moving",
            status: "in-progress",
            summary: "Moving",
            occurredAt: null,
            supportingConcepts: [
              {
                path: "work/epics/DKT-1-main.md",
                id: "DKT-1",
                title: "Main",
              },
            ],
            reason: "stale",
          },
        ],
      },
    });
    expect(
      await stat(join(repo, ".docket")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("includes a watermarked note in JSON and text when present", async () => {
    repo = await mkdtemp(join(tmpdir(), "docket-overview-note-"));
    await mkdir(join(repo, "docket", "work", "tasks"), { recursive: true });
    await writeFile(
      join(repo, "docket.yaml"),
      "bundle: docket/\nproject: DKT\n",
    );
    await writeFile(
      join(repo, "docket", "work", "tasks", "DKT-1-next.md"),
      "---\ntype: Task\ntitle: Next\nid: DKT-1\nstatus: todo\n---\n",
    );
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Docket Test",
          GIT_AUTHOR_EMAIL: "docket@example.test",
          GIT_COMMITTER_NAME: "Docket Test",
          GIT_COMMITTER_EMAIL: "docket@example.test",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    expect(git("init", "-q").exitCode).toBe(0);
    expect(git("add", ".").exitCode).toBe(0);
    expect(git("commit", "-qm", "baseline").exitCode).toBe(0);
    const asOf = git("rev-parse", "HEAD").stdout.toString().trim();
    await writeFile(
      join(repo, "docket", "overview.md"),
      `---\nas_of: ${asOf}\n---\n\nThe work is converging around one release.\n`,
    );
    expect(git("add", ".").exitCode).toBe(0);
    expect(git("commit", "-qm", "state of play").exitCode).toBe(0);

    const json = Bun.spawnSync(["bun", CLI, "overview", "--json"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout.toString()).narrative).toEqual({
      format: "legacy",
      asOf,
      body: "The work is converging around one release.",
      taskCommitsAgo: 0,
      review: {
        status: "needs-review",
        reasons: ["legacy-format"],
        reviewedDaysAgo: null,
        maxDays: 14,
      },
    });

    const text = Bun.spawnSync(["bun", CLI, "overview"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(text.exitCode).toBe(0);
    expect(text.stdout.toString()).toStartWith(
      "Earlier state of play — context needs review\n",
    );
  });
});
