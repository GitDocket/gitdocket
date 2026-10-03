import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKDOWN_AUTHORING_RULE } from "@gitdocket/core";
import { runInit } from "./init";
import { runUpgrade } from "./upgrade";

test("upgrade replaces obsolete managed validation instructions and preserves authored host requirements", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-validation-upgrade-"));
  const authored =
    "Owner requirement: run docket lint --strict after final edits.\n";
  const old =
    "Do not hard-wrap Markdown prose. After authoring bundle content, run `docket lint --json`.";
  try {
    await runInit(root, {
      project: "VAL",
      agents: ["claude", "codex", "cursor"],
    });
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(root, name);
      const source = await readFile(path, "utf8");
      await writeFile(
        path,
        authored + source.replace(MARKDOWN_AUTHORING_RULE, old),
      );
    }
    const before = await readFile(join(root, "AGENTS.md"), "utf8");
    await runUpgrade(root, { dryRun: true });
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(before);
    await runUpgrade(root, {});
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const source = await readFile(join(root, name), "utf8");
      expect(source).toStartWith(authored);
      expect(source).toContain(MARKDOWN_AUTHORING_RULE);
      expect(source).not.toContain(old);
    }
    const upgraded = await readFile(join(root, "AGENTS.md"), "utf8");
    await runUpgrade(root, {});
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(upgraded);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh CLI adoption delivers writing guidance; strict lint catches wrapping without rewriting source", async () => {
  const root = await mkdtemp(join(tmpdir(), "docket-prose-"));
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "index.ts"), ...args],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    return { code: result.exitCode, stdout: result.stdout.toString() };
  };
  try {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(
      0,
    );
    expect(
      Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "--allow-empty",
          "-qm",
          "Baseline",
        ],
        { cwd: root },
      ).exitCode,
    ).toBe(0);
    expect(
      cli(
        "init",
        "--project",
        "PRO",
        "--agent",
        "claude",
        "--agent",
        "codex",
        "--json",
      ).code,
    ).toBe(0);
    for (const file of [
      "AGENTS.md",
      "CLAUDE.md",
      "docket/workflows/docket-task.md",
      "docket/workflows/docket-close.md",
    ])
      expect(await readFile(join(root, file), "utf8")).toContain(
        MARKDOWN_AUTHORING_RULE,
      );
    const long = "Long task prose remains on a single source line. "
      .repeat(8)
      .trim();
    const created = cli(
      "task",
      "create",
      "--title",
      long,
      "--description",
      long,
      "--json",
    );
    expect(created.code).toBe(0);
    const { path } = JSON.parse(created.stdout);
    const file = join(root, "docket", path);
    const source = await readFile(file, "utf8");
    expect(source).toContain(`title: ${long}\n`);
    expect(source).toContain(`description: ${long}\n`);
    const wrapped = `${source}\nA paragraph wrapped\nfor an arbitrary column limit.\n`;
    await writeFile(file, wrapped);
    const lint = cli("lint", "--json");
    expect(lint.code).toBe(0);
    expect(JSON.parse(lint.stdout)).toContainEqual(
      expect.objectContaining({
        path,
        severity: "warning",
        message: expect.stringContaining("hard-wrapped prose"),
      }),
    );
    expect(cli("lint", "--strict", "--json").code).toBe(1);
    expect(await readFile(file, "utf8")).toBe(wrapped);
    await writeFile(file, `${source}\n${long}\n\n- ${long}\n`);
    expect(cli("lint", "--strict", "--json").code).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
