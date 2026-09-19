import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gitMerge3 } from "../packages/cli/src/upgrade";
import {
  DOCKET_WORKFLOWS,
  editDocument,
  LocalFileStore,
  parseConfig,
  readEditableDocument,
  renderWorkflow,
  upgradeWorkflowFile,
} from "../packages/core/src/index";

test("saved authored edits remain compatible with retained MCP, CLI pickup/index/search, guidance reads and workflow upgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "editor-compatibility-"));
  const client = new Client({ name: "editor-compatibility", version: "1" });
  const config = parseConfig();
  const store = new LocalFileStore(join(root, "docket"));
  const path = "work/tasks/DKT-1-edit.md";
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../packages/cli/src/index.ts"),
        ...args,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return JSON.parse(
      (result.content as { text: string }[])[0]?.text ?? "null",
    );
  };
  const edit = async (sourcePath: string, patch: unknown) => {
    const source = await readEditableDocument(store, config, sourcePath);
    return editDocument(store, config, sourcePath, {
      expectedVersion: source.version,
      patch,
    });
  };
  try {
    await mkdir(join(root, "docket/work/tasks"), { recursive: true });
    await mkdir(join(root, "docket/reference"), { recursive: true });
    await mkdir(join(root, "docket/workflows"), { recursive: true });
    await writeFile(
      join(root, "docket.yaml"),
      "project: DKT\nbundle: docket\n",
    );
    await store.write(
      path,
      "---\ntype: Task\nid: DKT-1\nstatus: todo\ntitle: Original\n---\n\n# Context\n\nOriginal body\n",
    );
    await store.write(
      "reference/project-guidance.md",
      "---\ntype: Reference\ntitle: Project guidance\n---\n\n# General standards\n\nUse clear words.\n",
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, "../packages/mcp/src/index.ts")],
        cwd: root,
        stderr: "pipe",
      }),
    );
    expect((await call("task_get", { id: "DKT-1" })).frontmatter.title).toBe(
      "Original",
    );
    await edit(path, {
      title: "Editedquartz task",
      body: "# Context\n\nEdited source kept in Git.\n\n# Acceptance Criteria\n\n- [x] Wording only\n",
    });
    const observed = await call("task_get", { id: "DKT-1" });
    expect(observed.frontmatter.title).toBe("Editedquartz task");
    expect(observed.frontmatter.status).toBe("todo");
    expect(observed.source).toContain("Wording only");
    const picked = JSON.parse(cli("task", "start", "DKT-1", "--json"));
    expect(picked.task.fm.title).toBe("Editedquartz task");
    expect(picked.task.fm.status).toBe("in-progress");
    expect((await call("task_get", { id: "DKT-1" })).frontmatter.status).toBe(
      "in-progress",
    );
    cli("task", "stop");
    cli("index");
    expect(await readFile(join(root, "docket/index.md"), "utf8")).toContain(
      "Editedquartz task",
    );
    expect(cli("search", "Editedquartz", "--json")).toContain(
      "Editedquartz task",
    );
    await edit("reference/project-guidance.md", {
      body: "# General standards\n\nKeep user-facing wording concise.\n",
    });
    expect(JSON.stringify(await call("project_guidance", {}))).toContain(
      "Keep user-facing wording concise.",
    );
    expect(cli("guidance", "--json")).toContain(
      "Keep user-facing wording concise.",
    );
    const workflow = DOCKET_WORKFLOWS[0];
    if (!workflow) throw new Error("Missing shipped workflow");
    const original = renderWorkflow(workflow, "2026-01-01T00:00:00Z");
    await store.write("workflows/customized.md", original);
    const base = await readEditableDocument(
      store,
      config,
      "workflows/customized.md",
    );
    await edit("workflows/customized.md", {
      body: `${base.body}\nProject-specific clarification.\n`,
    });
    const customized = await store.read("workflows/customized.md");
    const upgraded = upgradeWorkflowFile(customized, {
      merge3: gitMerge3({
        base: "base",
        ours: "edited source",
        theirs: "shipped",
      }),
    });
    expect(upgraded.action).toBe("up-to-date");
    expect(upgraded.content).toBe(customized);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
