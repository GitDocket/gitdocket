import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@gitdocket/core";
import {
  serveRouteId,
  TELEMETRY_COVERAGE,
  TelemetryStore,
} from "@gitdocket/core/telemetry";
import { createApp } from "./app";
import { createRepoContext } from "./state";

test("Serve records API boundaries, refresh attribution, mutations and validation without changing responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-web-telemetry-"));
  const root = join(dir, "project");
  const old = process.env.DOCKET_TELEMETRY_DIR;
  process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs/task.md"),
    "---\ntype: Task\nid: DKT-1\ntitle: PRIVATE_TITLE\nstatus: todo\n---\nPRIVATE_BODY",
  );
  const ctx = createRepoContext(root, parseConfig("bundle: docs/"));
  const app = createApp(ctx);
  const store = new TelemetryStore(root);
  try {
    const disabled = await (await app.request("/api/tasks")).text();
    expect(store.events()).toEqual([]);
    store.enable();
    expect(await (await app.request("/api/tasks")).text()).toBe(disabled);
    await app.request("/api/search?q=PRIVATE_BODY", {
      headers: { "X-Docket-Trigger": "explicit" },
    });
    await app.request("/api/search?q=zzz-no-such-term", {
      headers: { "X-Docket-Trigger": "explicit" },
    });
    await app.request("/api/tasks", {
      headers: { "X-Docket-Trigger": "background" },
    });
    const result = await app.request("/api/tasks/DKT-1/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Docket-Trigger": "explicit",
      },
      body: JSON.stringify({ to: "in-progress" }),
    });
    expect(result.status).toBe(200);
    expect((await app.request("/api/tasks?page=-1")).status).toBe(400);
    expect((await app.request("/api/concept/missing.md")).status).toBe(404);
    const events = store.events().filter((e) => e.kind === "operation");
    expect(events).toHaveLength(7);
    expect(events.filter((e) => e.trigger === "background")).toHaveLength(1);
    expect(events.filter((e) => e.error === "validation")).toHaveLength(1);
    expect(events.filter((e) => e.error === "not_found")).toHaveLength(1);
    const searches = events.filter((e) => e.operation === "search");
    expect(searches[0]?.resultCount).toBeGreaterThan(0);
    expect(searches[1]?.resultCount).toBe(0);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|DKT-1|missing\.md/);
    store.disable();
    expect((await app.request("/api/tasks")).status).toBe(200);
    expect(store.events().filter((e) => e.kind === "operation")).toHaveLength(
      7,
    );
    await rm(join(dir, "usage"), { recursive: true, force: true });
    await writeFile(join(dir, "usage"), "unavailable");
    expect((await app.request("/api/tasks")).status).toBe(200);
  } finally {
    ctx.close();
    if (old === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Serve request headers attribute mixed callers without inferring browser humans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-web-attr-"));
  const root = join(dir, "project");
  const old = process.env.DOCKET_TELEMETRY_DIR;
  const oldActor = process.env.DOCKET_TELEMETRY_ACTOR;
  const oldHost = process.env.DOCKET_TELEMETRY_HOST;
  const oldWorkflow = process.env.DOCKET_TELEMETRY_WORKFLOW;
  process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
  process.env.DOCKET_TELEMETRY_ACTOR = "agent";
  process.env.DOCKET_TELEMETRY_HOST = "codex";
  process.env.DOCKET_TELEMETRY_WORKFLOW = "launch-wide";
  await mkdir(join(root, ".docket"), { recursive: true });
  await writeFile(join(root, ".docket", "workflow-token"), "shared-checkout\n");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs/task.md"),
    "---\ntype: Task\nid: DKT-1\ntitle: PRIVATE_TITLE\nstatus: todo\n---\n",
  );
  const ctx = createRepoContext(root, parseConfig("bundle: docs/"));
  const app = createApp(ctx);
  const store = new TelemetryStore(root);
  try {
    store.enable();
    await app.request("/api/tasks", {
      headers: { "X-Docket-Trigger": "explicit" },
    });
    await app.request("/api/tasks", {
      headers: {
        "X-Docket-Trigger": "explicit",
        "X-Docket-Actor": "agent",
        "X-Docket-Host": "cursor",
      },
    });
    await app.request("/api/tasks", {
      headers: {
        "X-Docket-Actor": "human",
        "X-Docket-Host": "other",
        "X-Docket-Workflow": "explicit-a",
      },
    });
    const events = store.events().filter((event) => event.kind === "operation");
    expect(
      events.map((event) => [event.actor, event.host, event.trigger]),
    ).toEqual([
      ["unknown", "unknown", "explicit"],
      ["agent", "cursor", "explicit"],
      ["human", "other", "unknown"],
    ]);
    expect(events[0]?.workflow).toBeNull();
    expect(events[1]?.workflow).toBeNull();
    expect(events[2]?.workflow).toBeTruthy();
  } finally {
    ctx.close();
    if (old === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = old;
    if (oldActor === undefined) delete process.env.DOCKET_TELEMETRY_ACTOR;
    else process.env.DOCKET_TELEMETRY_ACTOR = oldActor;
    if (oldHost === undefined) delete process.env.DOCKET_TELEMETRY_HOST;
    else process.env.DOCKET_TELEMETRY_HOST = oldHost;
    if (oldWorkflow === undefined) delete process.env.DOCKET_TELEMETRY_WORKFLOW;
    else process.env.DOCKET_TELEMETRY_WORKFLOW = oldWorkflow;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Serve records editor open/preview/save and guidance without content or paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-web-edit-tel-"));
  const root = join(dir, "project");
  const old = process.env.DOCKET_TELEMETRY_DIR;
  process.env.DOCKET_TELEMETRY_DIR = join(dir, "usage");
  await mkdir(join(root, "docs/reference"), { recursive: true });
  const source =
    "---\ntype: Reference\ntitle: PRIVATE_TITLE\n---\n\nPRIVATE_BODY\n";
  await writeFile(join(root, "docs/reference/edit.md"), source);
  const ctx = createRepoContext(root, parseConfig("bundle: docs/"));
  const app = createApp(ctx);
  const store = new TelemetryStore(root);
  try {
    store.enable();
    const opened = await app.request("/api/edit-source/reference/edit.md", {
      headers: { "X-Docket-Trigger": "explicit" },
    });
    expect(opened.status).toBe(200);
    const draft = await opened.json();
    const preview = await app.request("/api/edit-preview/reference/edit.md", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Docket-Trigger": "explicit",
      },
      body: JSON.stringify({ body: "PRIVATE_PREVIEW" }),
    });
    expect(preview.status).toBe(200);
    const saved = await app.request("/api/edit-source/reference/edit.md", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Docket-Trigger": "explicit",
      },
      body: JSON.stringify({
        sourceScope: draft.sourceScope,
        expectedVersion: draft.version,
        patch: { body: "PRIVATE_SAVED" },
      }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).saveState).toBe("saved_locally");
    expect(
      (
        await app.request("/api/guidance", {
          headers: { "X-Docket-Trigger": "explicit" },
        })
      ).status,
    ).toBe(200);
    const conflict = await app.request("/api/edit-source/reference/edit.md", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Docket-Trigger": "explicit",
      },
      body: JSON.stringify({
        sourceScope: draft.sourceScope,
        expectedVersion: draft.version,
        patch: { body: "stale" },
      }),
    });
    expect(conflict.status).toBe(409);
    const events = store.events().filter((event) => event.kind === "operation");
    expect(events.map((event) => event.operation)).toEqual([
      "edit_open",
      "edit_preview",
      "edit_save",
      "project_guidance",
      "edit_save",
    ]);
    expect(events[2]?.saveState).toBe("saved_locally");
    expect(events.at(-1)?.error).toBe("conflict");
    expect(events.at(-1)?.saveState).toBeNull();
    expect(events.every((event) => event.trigger === "explicit")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE|edit\.md|reference\/edit/,
    );
  } finally {
    ctx.close();
    if (old === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Serve API handlers are inventoried so new routes cannot skip coverage review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docket-web-coverage-"));
  const root = join(dir, "project");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs/task.md"),
    "---\ntype: Task\nid: DKT-1\ntitle: T\nstatus: todo\n---\n",
  );
  const ctx = createRepoContext(root, parseConfig("bundle: docs/"));
  const app = createApp(ctx);
  try {
    const ids = [
      ...new Set(
        app.routes
          .filter((route) => route.method === "GET" || route.method === "POST")
          .map((route) => serveRouteId(route.method, route.path)),
      ),
    ].sort();
    const inventoried = TELEMETRY_COVERAGE.filter(
      (entry) =>
        entry.surface === "serve" &&
        entry.status !== "uninstrumented" &&
        !entry.id.endsWith("*") &&
        entry.id !== "GET /" &&
        entry.id !== "GET /assets/app.js" &&
        entry.id !== "HEAD *",
    )
      .map((entry) => entry.id)
      .sort();
    expect(ids).toEqual(inventoried);
  } finally {
    ctx.close();
    await rm(dir, { recursive: true, force: true });
  }
});
