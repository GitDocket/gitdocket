import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@gitdocket/core";
import { TelemetryStore } from "@gitdocket/core/telemetry";
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
    expect(events).toHaveLength(6);
    expect(events.filter((e) => e.trigger === "background")).toHaveLength(1);
    expect(events.filter((e) => e.error === "validation")).toHaveLength(1);
    expect(events.filter((e) => e.error === "not_found")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|DKT-1|missing\.md/);
    store.disable();
    expect((await app.request("/api/tasks")).status).toBe(200);
    expect(store.events().filter((e) => e.kind === "operation")).toHaveLength(
      6,
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
