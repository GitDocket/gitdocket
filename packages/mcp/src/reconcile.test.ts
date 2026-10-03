import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStore, parseConfig } from "@gitdocket/core";
import { TelemetryStore } from "@gitdocket/core/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDocketServer } from "./server";

test("MCP reconciliation uses bound checkout, retains typed recovery receipts and records content-free operation coverage", async () => {
  const temp = await mkdtemp(join(tmpdir(), "docket-mcp-reconcile-"));
  const root = join(temp, "main"),
    worker = join(temp, "worker");
  const old = process.env.DOCKET_TELEMETRY_DIR;
  process.env.DOCKET_TELEMETRY_DIR = join(temp, "telemetry");
  const git = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code) throw new Error(err);
    return out.trim();
  };
  const source = (status: string, body: string) =>
    `---\ntype: Task\nid: RS-501\ntitle: PRIVATE_TITLE\nstatus: ${status}\n---\n\n# Outcome\n\n${body}\n`;
  await mkdir(join(root, "docket/work/tasks"), { recursive: true });
  await writeFile(join(root, "docket.yaml"), "project: RS\nbundle: docket\n");
  const path = "work/tasks/private-item.md";
  await writeFile(join(root, "docket", path), source("todo", ""));
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  await git(root, "worktree", "add", "-qb", "PRIVATE_REF", worker);
  await writeFile(
    join(worker, "docket", path),
    source("done", "PRIVATE_ACCEPTANCE_BODY"),
  );
  for (let n = 0; n < 10; n++) {
    await writeFile(
      join(worker, "docket/work/tasks", "followup.md"),
      `---\ntype: Reference\ntitle: PRIVATE_FOLLOWUP\n---\n\nCloseout record ${n}.\n`,
    );
    await git(worker, "add", ".");
    await git(worker, "commit", "-qm", "documentation closeout");
  }
  const config = parseConfig("project: RS\nbundle: docket\n"),
    store = new LocalFileStore(join(root, "docket"));
  const observations = new TelemetryStore(root);
  observations.enable();
  const server = createDocketServer(store, config, root),
    client = new Client({ name: "fixture", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({
        name,
        arguments: args,
        _meta: { "docket/target": { root } },
      });
      const text = (result.content as { text: string }[])
        .map((c) => c.text)
        .join("");
      return {
        result,
        bytes: Buffer.byteLength(text),
        value: JSON.parse(text),
      };
    };
    const selection = { sourceRef: "PRIVATE_REF", paths: [path] };
    const plan = await call("reconcile_plan", { selection });
    expect(plan.result.isError).not.toBe(true);
    expect(plan.bytes).toBeLessThan(8192);
    expect(plan.value.items[0]).toMatchObject({
      incomingStatus: "done",
      localStatus: "todo",
      classification: "semantic-review",
    });
    expect(await readFile(join(root, "docket", path), "utf8")).toContain(
      "status: todo",
    );
    const page = await call("reconcile_source", {
      selection,
      expectedVersion: plan.value.version,
      path,
      side: "incoming",
    });
    expect(page.value.text).toContain("PRIVATE_ACCEPTANCE_BODY");
    const request = {
      selection,
      expectedVersion: plan.value.version,
      choices: [
        {
          path,
          disposition: "take-incoming",
          reason: "PRIVATE_REVIEW_REASON",
          acceptCompletion: true,
        },
      ],
    };
    const applied = await call("reconcile_apply", request);
    expect(applied.result.isError).not.toBe(true);
    expect(applied.value.state).toBe("applied");
    expect(applied.value.checkout).toMatchObject({
      root: await realpath(root),
      matched: true,
    });
    const recovered = await call("reconcile_recover", {
      token: applied.value.recoveryToken,
    });
    expect(recovered.value.state).toBe("noop");
    const conflict = await call("reconcile_apply", {
      ...request,
      expectedVersion: "a".repeat(64),
    });
    expect(conflict.result.isError).toBe(true);
    expect(conflict.value).toMatchObject({
      mutation: "unchanged",
      error: { code: "source-conflict" },
    });
    const events = observations.events().filter((e) => e.kind === "operation");
    expect(events.map((e) => e.operation)).toEqual([
      "reconcile_plan",
      "reconcile_source",
      "reconcile_apply",
      "reconcile_recover",
      "reconcile_apply",
    ]);
    expect(events.at(-1)?.error).toBe("conflict");
    expect(
      events.find(
        (e) => e.operation === "reconcile_apply" && e.outcome === "success",
      )?.saveState,
    ).toBe("saved_locally");
    const encoded = JSON.stringify(events);
    for (const privateValue of [
      "RS-501",
      "PRIVATE_REF",
      "PRIVATE_TITLE",
      "PRIVATE_ACCEPTANCE_BODY",
      "PRIVATE_REVIEW_REASON",
      root,
      path,
      plan.value.version,
      applied.value.recoveryToken,
    ])
      expect(encoded).not.toContain(privateValue);
    expect(await git(worker, "status", "--porcelain")).toBe("");
  } finally {
    await client.close();
    await server.close();
    if (old === undefined) delete process.env.DOCKET_TELEMETRY_DIR;
    else process.env.DOCKET_TELEMETRY_DIR = old;
    await rm(temp, { recursive: true, force: true });
  }
});
