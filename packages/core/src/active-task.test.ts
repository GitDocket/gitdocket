import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopActiveTask, withActiveTaskLock } from "./active-task";

let root: string;
const marker = () => join(root, ".docket/active-task");
const token = () => join(root, ".docket/workflow-token");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-active-"));
  await mkdir(join(root, ".docket"));
});
afterEach(async () => {
  await chmod(join(root, ".docket"), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});
async function seed(id = "FLOW_APP-3", workflow = "original-workflow") {
  await writeFile(marker(), `${id}\n`);
  await writeFile(token(), `${workflow}\n`);
}
test("named and legacy cleanup distinguish desired clear state without inventing history", async () => {
  expect((await stopActiveTask(root)).cleanup.disposition).toBe(
    "no-active-marker",
  );
  expect(
    (
      await stopActiveTask(root, {
        id: "FLOW_APP-3",
        workflowToken: "original-workflow",
      })
    ).cleanup.disposition,
  ).toBe("already-clear");
  await seed();
  expect(
    await stopActiveTask(root, {
      id: "FLOW_APP-3",
      workflowToken: "original-workflow",
    }),
  ).toMatchObject({
    ok: true,
    mutation: "applied",
    paths: [".docket/active-task", ".docket/workflow-token"],
  });
  await seed();
  expect(await stopActiveTask(root)).toMatchObject({
    ok: true,
    changed: true,
    cleanup: { scoped: false },
  });
});
test("task and same-task workflow mismatches preserve both files", async () => {
  await seed();
  for (const [id, workflowToken, disposition] of [
    ["FLOW_APP-4", "original-workflow", "marker-mismatch"],
    ["FLOW_APP-3", "old-workflow", "workflow-mismatch"],
  ]) {
    expect(await stopActiveTask(root, { id, workflowToken })).toMatchObject({
      ok: false,
      mutation: "unchanged",
      cleanup: { disposition },
    });
    expect(await readFile(marker(), "utf8")).toBe("FLOW_APP-3\n");
    expect(await readFile(token(), "utf8")).toBe("original-workflow\n");
  }
});
test("unknown orphan token is preserved; exact workflow can recover its associated token", async () => {
  await writeFile(token(), "original-workflow\n");
  expect((await stopActiveTask(root)).cleanup.disposition).toBe("orphan-token");
  expect((await stopActiveTask(root, { id: "FLOW_APP-3" })).ok).toBe(false);
  expect(
    await stopActiveTask(root, {
      id: "FLOW_APP-3",
      workflowToken: "original-workflow",
    }),
  ).toMatchObject({
    ok: true,
    paths: [".docket/workflow-token"],
    cleanup: { disposition: "associated-token-cleared" },
  });
});
test("unsafe, malformed and over-budget state refuse before removal", async () => {
  for (const content of ["", "FLOW_APP-3\nFLOW_APP-4\n", "x".repeat(1024)]) {
    await seed();
    await writeFile(marker(), content);
    expect(await stopActiveTask(root, { id: "FLOW_APP-3" })).toMatchObject({
      ok: false,
      mutation: "unchanged",
      cleanup: { disposition: "state-unavailable" },
    });
    expect(await readFile(token(), "utf8")).toBe("original-workflow\n");
  }
  await rm(marker());
  await writeFile(join(root, "outside"), "FLOW_APP-3\n");
  await symlink(join(root, "outside"), marker());
  expect((await stopActiveTask(root, { id: "FLOW_APP-3" })).ok).toBe(false);
  expect(await readFile(join(root, "outside"), "utf8")).toBe("FLOW_APP-3\n");
  await rm(marker());
  await rm(join(root, ".docket"), { recursive: true });
  await mkdir(join(root, "foreign"));
  await symlink(join(root, "foreign"), join(root, ".docket"));
  expect((await stopActiveTask(root, { id: "FLOW_APP-3" })).ok).toBe(false);
});
test("readable state in an unwritable lifecycle directory does not claim cleanup", async () => {
  if (process.getuid?.() === 0) return;
  await seed();
  await chmod(join(root, ".docket"), 0o500);
  expect(await stopActiveTask(root, { id: "FLOW_APP-3" })).toMatchObject({
    ok: false,
    mutation: "unchanged",
  });
  expect(await readFile(marker(), "utf8")).toBe("FLOW_APP-3\n");
});
test("late external replacement is detected before cleanup", async () => {
  await seed();
  const result = await stopActiveTask(root, {
    id: "FLOW_APP-3",
    workflowToken: "original-workflow",
    verifyCommit: async () => {
      await writeFile(token(), "new-workflow\n");
    },
  });
  expect(result).toMatchObject({ ok: false, mutation: "unknown", paths: [] });
  expect(await readFile(marker(), "utf8")).toBe("FLOW_APP-3\n");
  expect(await readFile(token(), "utf8")).toBe("new-workflow\n");
});
test("failed removals use readback and exact-token recovery rather than rollback claims", async () => {
  for (const mode of [
    "before",
    "after-marker",
    "after-token",
    "unsafe-readback",
  ] as const) {
    await seed();
    const result = await stopActiveTask(root, {
      id: "FLOW_APP-3",
      workflowToken: "original-workflow",
      remove: async (path) => {
        if (mode === "before") throw new Error("denied");
        if (String(path).endsWith("active-task")) {
          await unlink(path);
          if (mode === "after-marker") throw new Error("interrupted");
          return;
        }
        if (mode === "after-token") {
          await unlink(path);
          throw new Error("interrupted");
        }
        if (mode === "unsafe-readback") {
          await unlink(path);
          await symlink(join(root, "unknown"), String(path));
        }
        throw new Error("denied");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.mutation).toBe(
      mode === "before"
        ? "unchanged"
        : mode === "unsafe-readback"
          ? "unknown"
          : mode === "after-token"
            ? "applied"
            : "partial",
    );
    if (mode === "after-marker") {
      expect(result.paths).toEqual([".docket/active-task"]);
      expect(
        (
          await stopActiveTask(root, {
            id: "FLOW_APP-3",
            workflowToken: "original-workflow",
          })
        ).cleanup.disposition,
      ).toBe("associated-token-cleared");
    }
    await rm(marker(), { force: true });
    await rm(token(), { force: true });
  }
});
test("pickup and cleanup share a lease; newer same-task workflow is never cleared", async () => {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pickup = withActiveTaskLock(root, async (lease) => {
    entered();
    await gate;
    await lease.write("FLOW_APP-3", "new-workflow");
  });
  await ready;
  const cleanup = stopActiveTask(root, {
    id: "FLOW_APP-3",
    workflowToken: "old-workflow",
  });
  release();
  await pickup;
  expect(await cleanup).toMatchObject({
    ok: false,
    cleanup: { disposition: "workflow-mismatch" },
  });
  expect(await readFile(token(), "utf8")).toBe("new-workflow\n");
});
test("commit refusal and invalid scope leave lifecycle state untouched", async () => {
  await seed();
  expect(
    (
      await stopActiveTask(root, {
        id: "FLOW_APP-3",
        verifyCommit: async () => {
          throw new Error("uncommitted");
        },
      })
    ).cleanup.disposition,
  ).toBe("commit-not-ready");
  expect(
    (await stopActiveTask(root, { workflowToken: "original-workflow" })).cleanup
      .disposition,
  ).toBe("invalid-request");
  expect(await readFile(marker(), "utf8")).toBe("FLOW_APP-3\n");
});

test("explicit empty scope or token cannot silently become a bare cleanup", async () => {
  await seed();
  for (const options of [
    { id: "" },
    { id: "x".repeat(20000) },
    { id: "FLOW_APP-3", workflowToken: "" },
  ])
    expect((await stopActiveTask(root, options)).cleanup.disposition).toBe(
      "invalid-request",
    );
  expect(await readFile(marker(), "utf8")).toBe("FLOW_APP-3\n");
});
