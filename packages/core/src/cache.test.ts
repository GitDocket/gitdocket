import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBundle } from "./bundle";
import { buildCache, gitCheckpoint, taskLinkedCommitsSince } from "./cache";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";

const config = parseConfig();

const files = {
  "specs/alpha.md": "---\ntype: Spec\ntitle: Alpha\n---\n\nx\n",
  "work/epics/DKT-1-e.md":
    "---\ntype: Epic\ntitle: E\nid: DKT-1\nstatus: in-progress\n---\n\nSee [spec](/specs/alpha.md).\n",
  "work/tasks/DKT-2-a.md":
    "---\ntype: Task\ntitle: A\nid: DKT-2\nstatus: done\nepic: /work/epics/DKT-1-e.md\n---\n\nPer [the epic](/work/epics/DKT-1-e.md) and [gone](/specs/gone.md).\n",
  "work/tasks/DKT-3-b.md":
    "---\ntype: Task\ntitle: B\nid: DKT-3\nstatus: todo\nepic: /work/epics/DKT-1-e.md\naliases: [TASK-xyz]\n---\n\nx\n",
  "work/tasks/DKT-4-c.md":
    "---\ntype: Task\ntitle: C\nid: DKT-4\nstatus: closed\nepic: /work/epics/DKT-1-e.md\n---\n\nx\n",
};

async function cache() {
  const bundle = await loadBundle(
    new InMemoryFileStore(new Map(Object.entries(files))),
    config,
  );
  const db = new Database(":memory:");
  buildCache(db, bundle, [
    {
      taskId: "DKT-2",
      sha: "abc123",
      date: "2026-07-21T00:00:00Z",
      subject: "feat: a",
    },
  ]);
  return db;
}

describe("buildCache", () => {
  test("backlinks resolve; broken targets stay unresolved", async () => {
    const db = await cache();
    const backs = db
      .query("SELECT from_path FROM backlinks WHERE path = ?")
      .all("work/epics/DKT-1-e.md");
    expect(backs).toEqual([{ from_path: "work/tasks/DKT-2-a.md" }]);
    const broken = db
      .query("SELECT to_path FROM links WHERE target = ?")
      .get("/specs/gone.md") as { to_path: string | null };
    expect(broken.to_path).toBeNull();
  });

  test("board and epic rollup views", async () => {
    const db = await cache();
    const board = db.query("SELECT id, status FROM board").all();
    expect(board).toEqual([
      { id: "DKT-4", status: "closed" },
      { id: "DKT-2", status: "done" },
      { id: "DKT-3", status: "todo" },
    ]);
    const rollup = db
      .query("SELECT epic_id, total, done, closed FROM epic_rollup")
      .all();
    expect(rollup).toEqual([
      { epic_id: "DKT-1", total: 3, done: 1, closed: 1 },
    ]);
  });

  test("epic rollup last_activity is the freshest epic-or-task timestamp", async () => {
    const bundle = await loadBundle(
      new InMemoryFileStore(
        new Map([
          [
            "work/epics/DKT-1-e.md",
            "---\ntype: Epic\ntitle: E\nid: DKT-1\nstatus: in-progress\ntimestamp: 2026-07-01T00:00:00Z\n---\n\nx\n",
          ],
          [
            "work/tasks/DKT-2-a.md",
            "---\ntype: Task\ntitle: A\nid: DKT-2\nstatus: done\nepic: /work/epics/DKT-1-e.md\ntimestamp: 2026-07-15T00:00:00Z\n---\n\nx\n",
          ],
          [
            "work/epics/DKT-3-f.md",
            "---\ntype: Epic\ntitle: F\nid: DKT-3\nstatus: todo\n---\n\nx\n",
          ],
        ]),
      ),
      config,
    );
    const db = new Database(":memory:");
    buildCache(db, bundle);
    const rows = db
      .query("SELECT epic_id, last_activity FROM epic_rollup ORDER BY epic_id")
      .all();
    expect(rows).toEqual([
      { epic_id: "DKT-1", last_activity: "2026-07-15T00:00:00Z" }, // task beats the epic's own stamp
      { epic_id: "DKT-3", last_activity: "" }, // nothing stamped anywhere
    ]);
  });

  test("board orders terminal history newest-first, active by priority", async () => {
    const task = (
      id: number,
      status: string,
      priority: string,
      ts: string,
    ): [string, string] => [
      `work/tasks/DKT-${id}-t.md`,
      `---\ntype: Task\ntitle: T${id}\nid: DKT-${id}\nstatus: ${status}\npriority: ${priority}\ntimestamp: ${ts}\n---\n\nx\n`,
    ];
    const bundle = await loadBundle(
      new InMemoryFileStore(
        new Map([
          task(1, "done", "p1", "2026-07-01T00:00:00Z"),
          task(2, "done", "p0", "2026-07-15T00:00:00Z"),
          task(3, "done", "p2", "2026-07-10T00:00:00Z"),
          task(6, "closed", "p2", "2026-07-12T00:00:00Z"),
          task(4, "todo", "p2", "2026-07-20T00:00:00Z"),
          task(5, "todo", "p0", "2026-07-01T00:00:00Z"),
        ]),
      ),
      config,
    );
    const db = new Database(":memory:");
    buildCache(db, bundle);
    const rows = db.query("SELECT id, status, timestamp FROM board").all() as {
      id: string;
      status: string;
      timestamp: string;
    }[];
    // done: newest close first regardless of priority; todo: priority first.
    expect(rows.map((r) => r.id)).toEqual([
      "DKT-6",
      "DKT-2",
      "DKT-3",
      "DKT-1",
      "DKT-5",
      "DKT-4",
    ]);
    expect(rows[0]?.timestamp).toBe("2026-07-12T00:00:00Z");
  });

  test("board leads active columns with rank; unranked trail by priority", async () => {
    const task = (
      id: number,
      status: string,
      priority: string,
      rank?: number,
    ): [string, string] => [
      `work/tasks/DKT-${id}-t.md`,
      `---\ntype: Task\ntitle: T${id}\nid: DKT-${id}\nstatus: ${status}\npriority: ${priority}\n${rank === undefined ? "" : `rank: ${rank}\n`}---\n\nx\n`,
    ];
    const bundle = await loadBundle(
      new InMemoryFileStore(
        new Map([
          task(1, "todo", "p0"), // unranked — after every ranked card despite p0
          task(2, "todo", "p2", 20),
          task(3, "todo", "p3", 5.5), // fractional midpoints sort numerically
          task(4, "todo", "p1"),
        ]),
      ),
      config,
    );
    const db = new Database(":memory:");
    buildCache(db, bundle);
    const rows = db.query("SELECT id FROM board").all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["DKT-3", "DKT-2", "DKT-1", "DKT-4"]);
  });

  test("activity rows are queryable per task; rebuild is idempotent", async () => {
    const db = await cache();
    const rows = db
      .query("SELECT sha, subject FROM activity WHERE task_id = ?")
      .all("DKT-2");
    expect(rows).toEqual([{ sha: "abc123", subject: "feat: a" }]);

    const bundle = await loadBundle(
      new InMemoryFileStore(new Map(Object.entries(files))),
      config,
    );
    buildCache(db, bundle); // rebuild from scratch drops old activity
    expect(db.query("SELECT COUNT(*) AS n FROM activity").get()).toEqual({
      n: 0,
    });
  });
});

describe("verifications", () => {
  test("resolved markers become rows; unresolved are skipped; results table exists empty", async () => {
    const bundle = await loadBundle(
      new InMemoryFileStore(new Map(Object.entries(files))),
      config,
    );
    const db = new Database(":memory:");
    buildCache(
      db,
      bundle,
      [],
      [
        {
          source: "a.test.ts",
          line: 2,
          target: "/specs/alpha.md#x",
          spec: "specs/alpha.md",
          anchor: "x",
        },
        { source: "b.test.ts", line: 1, target: "/specs/gone.md" },
      ],
    );
    expect(db.query("SELECT * FROM verifications").all()).toEqual([
      {
        concept_path: "specs/alpha.md",
        kind: "test",
        source_path: "a.test.ts",
        line: 2,
        anchor: "x",
      },
    ]);
    expect(
      db.query("SELECT COUNT(*) AS n FROM verification_results").get(),
    ).toEqual({ n: 0 });
  });
});

describe("taskLinkedCommitsSince", () => {
  let repo: string | undefined;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = undefined;
  });

  test("counts only Task-trailered commits after the watermark", async () => {
    repo = await mkdtemp(join(tmpdir(), "docket-note-age-"));
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
    await writeFile(join(repo, "x"), "base\n");
    expect(git("add", "x").exitCode).toBe(0);
    expect(git("commit", "-qm", "base").exitCode).toBe(0);
    const watermark = git("rev-parse", "HEAD").stdout.toString().trim();

    await writeFile(join(repo, "x"), "unlinked\n");
    expect(git("commit", "-qam", "docs only").exitCode).toBe(0);
    await writeFile(join(repo, "x"), "linked one\n");
    expect(git("commit", "-qam", "work one\n\nTask: DKT-1").exitCode).toBe(0);
    await writeFile(join(repo, "x"), "linked two\n");
    expect(
      git("commit", "-qam", "work two\n\nTask: DKT-2\nTask: DKT-3").exitCode,
    ).toBe(0);

    expect(taskLinkedCommitsSince(repo, "Task", watermark)).toBe(2);
    expect(taskLinkedCommitsSince(repo, "Task", "not-a-sha")).toBeUndefined();
    expect(gitCheckpoint(repo)).toEqual(
      expect.objectContaining({
        revision: expect.any(String),
        time: expect.any(String),
      }),
    );
  });
});
