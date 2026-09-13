import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeHook, parseConfig } from "@gitdocket/core";
import { createApp } from "./app";
import { createCommitter } from "./commit";
import { createRepoContext } from "./state";

let root: string;
let ctx: ReturnType<typeof createRepoContext>;
let app: ReturnType<typeof createApp>;
const path = "reference/edit.md";
const source =
  "---\ntype: Reference\ntitle: Before\ncustom: [one, two]\n---\n\nOriginal body\n";
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "editing-http-"));
  await mkdir(join(root, "docs/reference"), { recursive: true });
  await writeFile(join(root, "docs", path), source);
  ctx = createRepoContext(root, parseConfig("bundle: docs/"), { ttlMs: 0 });
  app = createApp(ctx);
});
afterEach(async () => {
  ctx.close();
  await rm(root, { recursive: true, force: true });
});
const read = async () => (await app.request(`/api/edit-source/${path}`)).json();
test("guidance uses shared creation, source editing and live discovery without deleting procedure sources", async () => {
  const guidancePath = "reference/project-guidance.md";
  const view = async () => (await app.request("/api/guidance")).json();
  expect((await view()).guidance.status).toBe("absent");
  const draft = await (
    await app.request(`/api/edit-source/${guidancePath}`)
  ).json();
  expect((await view()).guidance.status).toBe("absent");
  const saveGuidance = (version: string, body: string) =>
    app.request(`/api/edit-source/${guidancePath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: version,
        sourceScope: draft.sourceScope,
        patch: { body },
      }),
    });
  const response = await saveGuidance(
    draft.version,
    "- Requirement: use GraphQL. Scope: API changes.\n\n- Procedure: [Existing](/reference/edit.md). Scope: requested rehearsals.\n",
  );
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.saveState).toBe("saved_locally");
  expect(saved.taskId).toBeNull();
  const present = await view();
  expect(present.guidance.status).toBe("present");
  expect(present.html).toContain("Scope: API changes");
  expect(present.guidance.links[0].status).toBe("available");
  expect((await saveGuidance(draft.version, "stale")).status).toBe(409);
  expect(
    (
      await saveGuidance(
        saved.document.version,
        "<!-- Retired guidance entry: replace old API standard. -->\n",
      )
    ).status,
  ).toBe(200);
  expect((await view()).guidance.links).toEqual([]);
  expect(await readFile(join(root, "docs", path), "utf8")).toBe(source);
  await expect(readFile(join(root, ".docket/active-task"))).rejects.toThrow();
  expect(
    (await app.request("/api/edit-source/reference/arbitrary-new.md")).status,
  ).toBe(404);
});
const save = async (
  draft: { version: string; sourceScope: string },
  patch: unknown,
) =>
  app.request(`/api/edit-source/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceScope: draft.sourceScope,
      expectedVersion: draft.version,
      patch,
    }),
  });

test("complete source saves refresh concept, search, backlinks and navigation", async () => {
  const body = `${"雪".repeat(40000)}\n[Target](/reference/target.md)`;
  await writeFile(
    join(root, "docs/reference/target.md"),
    "---\ntype: Spec\ntitle: Target\n---\n",
  );
  const result = await (
    await save(await read(), {
      title: "Findablequartz",
      description: "New description",
      body,
    })
  ).json();
  expect(result.saveState).toBe("saved_locally");
  expect(result.document.body).toBe(body);
  const detail = await (
    await app.request(`/api/concept/${path}?page=1`)
  ).json();
  expect(detail.fm.title).toBe("Findablequartz");
  expect(detail.sourcePath).toBe(path);
  const excerpt = await (await app.request(`/api/source/${path}`)).json();
  expect(excerpt.text.length).toBeLessThanOrEqual(16384);
  expect((await read()).body).toBe(body);
  const search = await (
    await app.request("/api/search?q=Findablequartz")
  ).json();
  expect(JSON.stringify(search)).toContain("Findablequartz");
  const target = await (
    await app.request("/api/concept/reference/target.md?page=1")
  ).json();
  expect(JSON.stringify(target.backlinks)).toContain(path);
  expect(await (await app.request("/api/nav")).text()).toContain(
    "Findablequartz",
  );
});

test("stale/invalid/oversized/unsupported requests preserve source and report structured errors", async () => {
  const draft = await read();
  await writeFile(join(root, "docs", path), source + "agent change");
  const stale = await save(draft, { body: "stale" });
  expect(stale.status).toBe(409);
  expect((await stale.json()).code).toBe("conflict");
  const fresh = await read();
  expect((await save(fresh, { status: "done" })).status).toBe(400);
  expect((await save(fresh, { body: "x".repeat(262144) })).status).toBe(413);
  expect(
    (await save({ ...fresh, sourceScope: "other-project" }, { body: "wrong" }))
      .status,
  ).toBe(409);
  expect(await readFile(join(root, "docs", path), "utf8")).toBe(
    source + "agent change",
  );
  expect((await app.request("/api/edit-source/index.md")).status).toBe(422);
  expect((await app.request("/api/edit-source/missing.md")).status).toBe(404);
  expect(
    (await app.request("/api/edit-source/reference%2f..%2fsecret.md")).status,
  ).toBe(400);
  const cross = await app.request(`/api/edit-source/${path}`, {
    method: "POST",
    headers: { Origin: "https://untrusted.example" },
    body: "{}",
  });
  expect(cross.status).toBe(403);
  expect(
    (await app.request(`http://hostile.example/api/edit-source/${path}`))
      .status,
  ).toBe(403);
});

test("preview uses the safe reading renderer without writing", async () => {
  const response = await app.request(`/api/edit-preview/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: "# Preview\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n[local](/reference/edit.md)\n\n![bad](data:text/html,hello)",
    }),
  });
  const { html } = await response.json();
  expect(html).toContain('<h1 id="preview">Preview</h1>');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("data:text");
  expect(html).toContain('href="#/c/reference/edit.md"');
  expect(await readFile(join(root, "docs", path), "utf8")).toBe(source);
});

async function setupGit() {
  git("init", "-q");
  git("config", "user.name", "Editor test");
  git("config", "user.email", "editor@test.local");
  git("add", "docs");
  git("commit", "-qm", "initial");
  await mkdir(join(root, ".docket"), { recursive: true });
  await writeFile(join(root, ".docket/active-task"), "DKT-999\n");
  await writeFile(
    join(root, ".git/hooks/prepare-commit-msg"),
    composeHook(undefined).content ?? "",
  );
  await chmod(join(root, ".git/hooks/prepare-commit-msg"), 0o755);
  app = createApp(ctx, undefined, { commit: createCommitter(root, "docs") });
}
test("optional commits preserve unrelated staged work and exclude active-task attribution on docs", async () => {
  await setupGit();
  await writeFile(join(root, "unrelated.txt"), "staged\n");
  git("add", "unrelated.txt");
  await writeFile(join(root, "unrelated.txt"), "unstaged\n");
  const index = git("ls-files", "--stage", "--", "unrelated.txt");
  const result = await (
    await save(await read(), { title: "Committed" })
  ).json();
  expect(result.saveState).toBe("committed");
  expect(git("log", "-1", "--format=%B")).not.toContain("Task:");
  expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe(
    "docs/reference/edit.md",
  );
  expect(git("ls-files", "--stage", "--", "unrelated.txt")).toBe(index);
  expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  const before = git("rev-parse", "HEAD");
  expect(
    (await (await save(await read(), { title: "Committed" })).json()).saveState,
  ).toBe("unchanged");
  expect(git("rev-parse", "HEAD")).toBe(before);
});
test("work source commits carry their own ID, and hook failure reports saved source with failed commit", async () => {
  await writeFile(
    join(root, "docs", path),
    "---\ntype: Task\nid: DKT-1\nstatus: todo\ntitle: Task\n---\n- [ ] Do it",
  );
  await setupGit();
  expect(
    (await (await save(await read(), { body: "- [x] Wording" })).json())
      .saveState,
  ).toBe("committed");
  expect(git("log", "-1", "--format=%B")).toContain("Task: DKT-1");
  expect(git("log", "-1", "--format=%B")).not.toContain("999");
  await writeFile(
    join(root, ".git/hooks/commit-msg"),
    '#!/bin/sh\necho "test hook failure" >&2\nexit 1\n',
  );
  await chmod(join(root, ".git/hooks/commit-msg"), 0o755);
  const head = git("rev-parse", "HEAD");
  const response = await save(await read(), {
    title: "Saved despite commit failure",
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.saveState).toBe("commit_failed");
  expect(result.commitError).toContain("test hook failure");
  expect(result.document.title).toBe("Saved despite commit failure");
  expect((await read()).version).toBe(result.document.version);
  expect(git("rev-parse", "HEAD")).toBe(head);
});

test("one source contract covers every authored type, retains lifecycle and provenance, and refreshes work routes", async () => {
  for (const type of [
    "Task",
    "Epic",
    "Spec",
    "Reference",
    "Playbook",
    "Decision",
    "Workflow",
    "ProjectCustom",
  ]) {
    const work = type === "Task" || type === "Epic";
    const identity = work
      ? "id: DKT-12\nstatus: todo\n"
      : type === "Decision"
        ? "id: DEC-1\nstatus: accepted\n"
        : "";
    const before = `---\ntype: ${type}\ntitle: Before\n${identity}origin: custom@0.2.1\ntimestamp: old\nreviewed_at: never\nevidence: retained\nunknown:\n  exact: [one, two] # preserve\n---\n\n- [ ] Acceptance wording\n`;
    await writeFile(join(root, "docs", path), before);
    const detail = await (
      await app.request(`/api/concept/${path}?page=1`)
    ).json();
    expect(detail.editing.editable).toBe(true);
    const result = await (
      await save(await read(), {
        title: `Edited ${type}`,
        description: "Added description",
        body: "- [x] Revised wording\n",
      })
    ).json();
    expect(result.saveState).toBe("saved_locally");
    const after = await readFile(join(root, "docs", path), "utf8");
    expect(after).toContain(`type: ${type}`);
    expect(after).toContain(
      "origin: custom@0.2.1\ntimestamp: old\nreviewed_at: never\nevidence: retained\nunknown:\n  exact: [one, two] # preserve",
    );
    if (work) {
      expect(after).toContain("id: DKT-12\nstatus: todo");
      const route = await (await app.request("/api/work/12?page=1")).json();
      expect(route.fm.title).toBe(`Edited ${type}`);
      expect(route.fm.status).toBe("todo");
    }
    if (type === "Decision")
      expect(after).toContain("id: DEC-1\nstatus: accepted");
  }
});
test("detail projects visible read-only reasons for reserved, malformed and oversized sources", async () => {
  for (const [p, text, reason] of [
    ["index.md", "# Project\n\n<!-- docket:generated -->\n", "read-only"],
    ["overview.md", "# Briefing\n\nreviewed_at: old\n", "read-only"],
    ["log.md", "# Log\n", "read-only"],
    ["reference/broken.md", "not valid frontmatter", "frontmatter"],
    ["reference/huge.md", source + "x".repeat(262144), "256 KiB"],
  ]) {
    await writeFile(join(root, "docs", p ?? ""), text ?? "");
    const detail = await (await app.request(`/api/concept/${p}?page=1`)).json();
    expect(detail.editing.editable).toBe(false);
    expect(detail.editing.reason).toContain(reason);
  }
});
