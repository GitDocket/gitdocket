// End-to-end: run the real CLI against throwaway git repos. Covers the
// Greenfield scaffold and brownfield adoption coverage.
// report, hook composition, and native Claude/Codex adapter writes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InitReport } from "./init";

const CLI = join(import.meta.dir, "index.ts");

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "docket-init-"));
});

afterEach(() => rm(repo, { recursive: true, force: true }));

function sh(
  args: string[],
  env?: Record<string, string>,
): { code: number; stdout: string } {
  const result = Bun.spawnSync(args, {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

function init(...flags: string[]): InitReport {
  return initEnv(undefined, ...flags);
}

function initEnv(
  env: Record<string, string> | undefined,
  ...flags: string[]
): InitReport {
  const result = sh(["bun", CLI, "init", "--json", ...flags], env);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout);
}

// The .mcp.json step resolves docket-mcp on PATH, so tests pin PATH instead
// of inheriting whatever the machine happens to have linked. The base keeps
// git and bun reachable and nothing else.
const BASE_PATH = [
  dirname(Bun.which("git") ?? "/usr/bin/git"),
  dirname(process.execPath),
  "/usr/bin",
  "/bin",
].join(":");

const pinnedEnv = (path: string) => ({
  PATH: path,
  HOME: process.env.HOME ?? "",
});

/** Drop a fake executable docket-mcp into the repo, return its dir. */
async function fakeMcpBin(): Promise<string> {
  const dir = join(repo, ".fake-bin");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "docket-mcp"), "#!/bin/sh\nexit 0\n");
  await chmod(join(dir, "docket-mcp"), 0o755);
  return dir;
}

const action = (report: InitReport, step: string, path: string) =>
  report.steps.find((s) => s.step === step && s.path.endsWith(path))?.action;

describe("docket init", () => {
  test("greenfield: scaffolds config, bundle, and hook; idempotent on rerun", async () => {
    sh(["git", "init", "-q"]);

    const first = init("--project", "ACME");
    expect(action(first, "config", "docket.yaml")).toBe("create");
    expect(action(first, "bundle", "index.md")).toBe("create");
    expect(action(first, "index", "index.md")).toBe("update");
    expect(action(first, "bundle", "log.md")).toBe("create");
    expect(action(first, "hook", "prepare-commit-msg")).toBe("create");
    expect(first.adopt).toEqual([]);

    const config = await readFile(join(repo, "docket.yaml"), "utf8");
    expect(config).toContain("project: ACME");
    expect(
      await readFile(join(repo, ".docket", "cache.sqlite")),
    ).not.toHaveLength(0);

    const rerun = init();
    expect(rerun.steps.every((s) => s.action === "skip")).toBe(true);
  });

  test("freshness: baseline watermark stamped once a commit exists, idempotent", async () => {
    sh(["git", "init", "-q"]);
    sh(["git", "config", "user.email", "t@e.st"]);
    sh(["git", "config", "user.name", "t"]);

    // Zero commits: skip with a reason instead of writing a sha-less entry.
    const empty = init();
    const skipped = empty.steps.find((s) => s.step === "freshness");
    expect(skipped?.action).toBe("skip");
    expect(skipped?.reason).toBe("no commits yet");

    sh(["git", "add", "."]);
    sh(["git", "commit", "-q", "-m", "adopt docket"]);

    const stamped = init();
    expect(action(stamped, "freshness", "docket/log.md")).toBe("create");
    const sha = sh(["git", "rev-parse", "--short", "HEAD"]).stdout.trim();
    const log = await readFile(join(repo, "docket", "log.md"), "utf8");
    expect(log).toContain(
      `- **Freshness** — baseline at adoption; reviewed through \`${sha}\` (nothing to review before Docket).`,
    );

    const rerun = init();
    const step = rerun.steps.find((s) => s.step === "freshness");
    expect(step?.action).toBe("skip");
    expect(step?.reason).toBe("already stamped");
  });

  test("installed hook injects the active task trailer on commit", async () => {
    sh(["git", "init", "-q"]);
    sh(["git", "config", "user.email", "t@e.st"]);
    sh(["git", "config", "user.name", "t"]);
    init();

    await mkdir(join(repo, ".docket"), { recursive: true });
    await writeFile(join(repo, ".docket", "active-task"), "ACME-7\n");
    await writeFile(join(repo, "a.txt"), "x\n");
    sh(["git", "add", "."]);
    sh(["git", "commit", "-q", "-m", "test commit"]);

    const log = sh(["git", "log", "-1", "--format=%(trailers)"]);
    expect(log.stdout).toContain("Task: ACME-7");
  });

  test("brownfield: proposes types for typeless markdown, never edits it", async () => {
    sh(["git", "init", "-q"]);
    const spec = join(repo, "docket", "specs");
    await mkdir(spec, { recursive: true });
    await writeFile(join(spec, "api.md"), "# API\n");
    await writeFile(
      join(repo, "docket", "typed.md"),
      "---\ntype: Doc\n---\n# ok\n",
    );

    const report = init();
    expect(report.adopt).toEqual([
      { path: "specs/api.md", proposedType: "Spec" },
    ]);
    expect(await readFile(join(spec, "api.md"), "utf8")).toBe("# API\n");
    const initialIndex = await readFile(
      join(repo, "docket", "index.md"),
      "utf8",
    );
    expect(initialIndex).toContain("[typed.md](/typed.md)");
    expect(initialIndex).not.toContain("api.md");

    await writeFile(
      join(spec, "api.md"),
      "---\ntype: Spec\ntitle: API\n---\n\n# API\n",
    );
    const indexed = sh(["bun", CLI, "index"]);
    expect(indexed.code).toBe(0);
    expect(await readFile(join(repo, "docket", "index.md"), "utf8")).toContain(
      "[API](/specs/api.md)",
    );
  });

  test("human next hint starts at judgment or commit, never another index command", async () => {
    sh(["git", "init", "-q"]);
    const greenfield = sh(["bun", CLI, "init"]);
    expect(greenfield.code).toBe(0);
    expect(greenfield.stdout).toContain("next: commit the new files");
    expect(greenfield.stdout).not.toContain("next: `docket index`");

    const brownfield = await mkdtemp(join(tmpdir(), "docket-init-brownfield-"));
    const originalRepo = repo;
    repo = brownfield;
    try {
      sh(["git", "init", "-q"]);
      await mkdir(join(repo, "docket", "notes"), { recursive: true });
      await writeFile(join(repo, "docket", "notes", "legacy.md"), "# Legacy\n");
      const result = sh(["bun", CLI, "init"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "next: review and apply the adoption worklist above, then commit the new files",
      );
      expect(result.stdout).not.toContain("next: `docket index`");
    } finally {
      repo = originalRepo;
      await rm(brownfield, { recursive: true, force: true });
    }
  });

  test("composes with an existing hook and with core.hooksPath", async () => {
    sh(["git", "init", "-q"]);
    sh(["git", "config", "core.hooksPath", ".githooks"]);
    await mkdir(join(repo, ".githooks"), { recursive: true });
    const hookPath = join(repo, ".githooks", "prepare-commit-msg");
    await writeFile(hookPath, "#!/bin/sh\necho existing-hook\n");

    const report = init();
    expect(action(report, "hook", ".githooks/prepare-commit-msg")).toBe(
      "update",
    );
    const hook = await readFile(hookPath, "utf8");
    expect(hook).toContain("echo existing-hook");
    expect(hook).toContain("docket prepare-commit-msg");

    const rerun = init();
    expect(action(rerun, "hook", "prepare-commit-msg")).toBe("skip");
  });

  test("husky: hooksPath .husky/_ redirects the hook to .husky/", async () => {
    sh(["git", "init", "-q"]);
    sh(["git", "config", "core.hooksPath", ".husky/_"]);
    await mkdir(join(repo, ".husky", "_"), { recursive: true });

    const report = init();
    const step = report.steps.find((s) => s.step === "hook");
    expect(step?.action).toBe("create");
    expect(step?.path.endsWith(join(".husky", "prepare-commit-msg"))).toBe(
      true,
    );
  });

  test("--claude merges pre-approval into existing files without clobbering", async () => {
    sh(["git", "init", "-q"]);
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    await mkdir(join(repo, ".claude"), { recursive: true });
    await writeFile(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }),
    );

    const report = initEnv(
      pinnedEnv(`${await fakeMcpBin()}:${BASE_PATH}`),
      "--claude",
    );
    expect(action(report, "claude", ".mcp.json")).toBe("update");
    expect(action(report, "claude", ".claude/settings.json")).toBe("update");

    const mcp = JSON.parse(await readFile(join(repo, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.other.command).toBe("x");
    expect(mcp.mcpServers.docket.command).toBe("docket-mcp");

    const settings = JSON.parse(
      await readFile(join(repo, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.permissions.allow).toContain("Bash(ls:*)");
    expect(settings.permissions.allow).toContain("mcp__docket");
    expect(settings.permissions.allow).toContain("Bash(docket:*)");
    expect(settings.enableAllProjectMcpServers).toBe(true);
  });

  test("--claude skips .mcp.json when docket-mcp is not on PATH", async () => {
    sh(["git", "init", "-q"]);

    // No docket-mcp anywhere on PATH: refuse to register a dead command.
    const report = initEnv(pinnedEnv(BASE_PATH), "--claude");
    const step = report.steps.find((s) => s.path === ".mcp.json");
    expect(step?.action).toBe("skip");
    expect(step?.reason).toContain("docket-mcp not on PATH");
    expect(
      await readFile(join(repo, ".mcp.json"), "utf8").catch(() => ""),
    ).toBe("");
    // The CLI itself still works, so the settings pre-approval still lands.
    expect(action(report, "claude", ".claude/settings.json")).toBe("create");

    // Once the binary resolves, a rerun registers it.
    const rerun = initEnv(
      pinnedEnv(`${await fakeMcpBin()}:${BASE_PATH}`),
      "--claude",
    );
    expect(action(rerun, "claude", ".mcp.json")).toBe("create");
    const mcp = JSON.parse(await readFile(join(repo, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.docket.command).toBe("docket-mcp");
  });

  test("scaffolds bundle workflows and an AGENTS.md section; both idempotent", async () => {
    sh(["git", "init", "-q"]);

    const report = init("--project", "ACME");
    expect(action(report, "workflow", "docket/workflows/docket-task.md")).toBe(
      "create",
    );
    expect(action(report, "agents", "AGENTS.md")).toBe("create");
    expect(report.steps.some((s) => s.path === "CLAUDE.md")).toBe(false);

    const workflow = await readFile(
      join(repo, "docket", "workflows", "docket-close.md"),
      "utf8",
    );
    expect(workflow).toContain("type: Workflow");
    const groom = await readFile(
      join(repo, "docket", "workflows", "docket-groom.md"),
      "utf8",
    );
    expect(groom).toContain("ranked tasks first by ascending `rank`");
    expect(groom).toContain("ascending task ID as the stable fallback");
    expect(groom).not.toContain("dependency depth");
    const agents = await readFile(join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("docket/workflows/docket-task.md");
    expect(agents).toContain("Task: ACME-<n>");
    expect(agents).toContain("the `docket-pickup` workflow");
    expect(agents).toContain("**Direct and tracked work**");
    expect(agents).toContain("concrete direct request proceeds");
    expect(agents).toContain("generic implementation language");
    expect(agents).toContain("supplies a Docket ID");
    expect(agents).toContain("reference remains ambiguous");
    expect(agents).toContain("never fall back");
    expect(agents).toContain(
      "permitted only for explicit next-Docket-task or backlog selection",
    );
    expect(agents).toContain("the `docket-epic` workflow");
    expect(agents).toContain("mandatory serial path");
    expect(agents).toContain("`suggestedSessionTitle`");
    expect(agents).toContain("`docket overview --json`");
    expect(agents).toContain("an ordinary review");
    expect(agents).toContain("MCP-only client");

    const rerun = init();
    expect(action(rerun, "workflow", "docket-task.md")).toBe("skip");
    expect(action(rerun, "agents", "AGENTS.md")).toBe("skip");
  });

  test("composes the section into an existing CLAUDE.md without clobbering", async () => {
    sh(["git", "init", "-q"]);
    await writeFile(join(repo, "CLAUDE.md"), "# House rules\n\nBe kind.\n");

    const report = init();
    expect(action(report, "agents", "CLAUDE.md")).toBe("update");
    const claudeMd = await readFile(join(repo, "CLAUDE.md"), "utf8");
    expect(claudeMd.startsWith("# House rules\n\nBe kind.\n")).toBe(true);
    expect(claudeMd).toContain("## Docket");
    expect(claudeMd).toContain("`docket overview --json`");
  });

  test("--claude writes skill stubs, overwrites stale stubs, spares hand-authored skills", async () => {
    sh(["git", "init", "-q"]);
    const skills = join(repo, ".claude", "skills");
    await mkdir(join(skills, "docket-task"), { recursive: true });
    await writeFile(
      join(skills, "docket-task", "SKILL.md"),
      "---\nname: docket-task\n---\n\nMy own version.\n",
    );

    const first = init("--claude");
    expect(action(first, "skills", "docket-task/SKILL.md")).toBe("skip");
    expect(action(first, "skills", "docket-groom/SKILL.md")).toBe("create");
    const stub = await readFile(
      join(skills, "docket-groom", "SKILL.md"),
      "utf8",
    );
    expect(stub).toContain("generated by docket init");
    expect(stub).toContain("docket/workflows/docket-groom.md");
    expect(stub).toContain("Full backlog hygiene audit");

    // A marker-carrying stub is regenerable: stale edits get overwritten.
    await writeFile(join(skills, "docket-groom", "SKILL.md"), `${stub}\nx\n`);
    const second = init("--claude");
    expect(action(second, "skills", "docket-groom/SKILL.md")).toBe("update");
    expect(action(second, "skills", "docket-close/SKILL.md")).toBe("skip");
    expect(
      await readFile(join(skills, "docket-task", "SKILL.md"), "utf8"),
    ).toContain("My own version.");
  });

  test("--agent codex preserves project config, writes skills, and is idempotent", async () => {
    sh(["git", "init", "-q"]);
    await mkdir(join(repo, ".codex"), { recursive: true });
    const original =
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n';
    await writeFile(join(repo, ".codex", "config.toml"), original);
    const skills = join(repo, ".agents", "skills");
    await mkdir(join(skills, "docket-task"), { recursive: true });
    await writeFile(
      join(skills, "docket-task", "SKILL.md"),
      "---\nname: docket-task\n---\n\nMy Codex-specific version.\n",
    );

    const first = initEnv(
      pinnedEnv(`${await fakeMcpBin()}:${BASE_PATH}`),
      "--agent",
      "codex",
    );
    expect(action(first, "codex", ".codex/config.toml")).toBe("update");
    expect(
      first.steps.find((s) => s.path === ".agents/skills/docket-task/SKILL.md")
        ?.action,
    ).toBe("skip");
    expect(
      first.steps.find((s) => s.path === ".agents/skills/docket-groom/SKILL.md")
        ?.action,
    ).toBe("create");
    const config = await readFile(join(repo, ".codex", "config.toml"), "utf8");
    expect(config.startsWith(original)).toBe(true);
    expect(config).toContain("[mcp_servers.docket]");
    const parsed = Bun.TOML.parse(config) as {
      mcp_servers: { docket: { command: string } };
    };
    expect(parsed.mcp_servers.docket.command).toBe("docket-mcp");
    expect(
      await readFile(join(skills, "docket-task", "SKILL.md"), "utf8"),
    ).toContain("My Codex-specific version.");
    expect(
      await readFile(join(skills, "docket-groom", "SKILL.md"), "utf8"),
    ).toContain("Full backlog hygiene audit");
    const pickup = await readFile(
      join(skills, "docket-pickup", "SKILL.md"),
      "utf8",
    );
    expect(pickup).toContain("explicitly tracked Docket work only");
    expect(pickup).toContain("direct work bypasses Docket");
    expect(pickup).toContain("ambiguous references require resolution");
    expect(pickup).toContain("codex_app__set_thread_title");
    expect(pickup).toContain("Omit `threadId`");
    const epic = await readFile(
      join(skills, "docket-epic", "SKILL.md"),
      "utf8",
    );
    expect(epic).toContain("`Epic <ID> — <title>`");
    expect(epic).toContain("codex_app__set_thread_title");
    expect(epic).toContain("omit `threadId`");
    expect(epic).toContain("after every successful child pickup");
    expect(epic).toContain("before the completion or blocker receipt");
    expect(epic).toContain(
      "never apply the manager title to an isolated child",
    );
    expect(epic).toContain("one app task in an isolated Git worktree");
    expect(epic).toContain("wait cursor");
    expect(epic).toContain("canonical serial fallback");

    const second = initEnv(
      pinnedEnv(`${await fakeMcpBin()}:${BASE_PATH}`),
      "--codex",
    );
    expect(action(second, "codex", ".codex/config.toml")).toBe("skip");
    expect(
      second.steps
        .filter((s) => s.path.startsWith(".agents/skills/"))
        .every((s) => s.action === "skip"),
    ).toBe(true);
  });

  test("multiple --agent flags install Claude and Codex together", async () => {
    sh(["git", "init", "-q"]);
    const report = initEnv(
      pinnedEnv(`${await fakeMcpBin()}:${BASE_PATH}`),
      "--agent",
      "claude",
      "--agent",
      "codex",
    );
    expect(action(report, "claude", ".mcp.json")).toBe("create");
    expect(action(report, "codex", ".codex/config.toml")).toBe("create");
    expect(
      report.steps.some((s) =>
        s.path.startsWith(".claude/skills/docket-task/"),
      ),
    ).toBe(true);
    expect(
      report.steps.some((s) =>
        s.path.startsWith(".agents/skills/docket-task/"),
      ),
    ).toBe(true);
    expect(
      report.steps.filter(
        (s) => s.step === "workflow" && s.path.endsWith("docket-pickup.md"),
      ),
    ).toHaveLength(1);
    const claudePickup = await readFile(
      join(repo, ".claude", "skills", "docket-pickup", "SKILL.md"),
      "utf8",
    );
    const codexPickup = await readFile(
      join(repo, ".agents", "skills", "docket-pickup", "SKILL.md"),
      "utf8",
    );
    expect(claudePickup).toContain("rename unsupported");
    expect(claudePickup).toContain("explicitly tracked Docket work only");
    expect(claudePickup).toContain("direct work bypasses Docket");
    expect(claudePickup).toContain("ambiguous references require resolution");
    expect(claudePickup).not.toContain("codex_app__");
    expect(codexPickup).toContain("explicitly tracked Docket work only");
    expect(codexPickup).toContain("direct work bypasses Docket");
    expect(codexPickup).toContain("ambiguous references require resolution");
    expect(codexPickup).toContain("codex_app__set_thread_title");
    const claudeEpic = await readFile(
      join(repo, ".claude", "skills", "docket-epic", "SKILL.md"),
      "utf8",
    );
    const codexEpic = await readFile(
      join(repo, ".agents", "skills", "docket-epic", "SKILL.md"),
      "utf8",
    );
    expect(claudeEpic).toContain("current-session rename unsupported");
    expect(claudeEpic).not.toContain("codex_app__");
    expect(codexEpic).toContain("`Epic <ID> — <title>`");
    expect(codexEpic).toContain("codex_app__set_thread_title");
    expect(claudeEpic).toContain("no verified native worker lifecycle binding");
    expect(claudeEpic).toContain("serially in the calling session");
    expect(codexEpic).toContain("one app task in an isolated Git worktree");
  });

  test("Codex skips malformed project TOML without clobbering it", async () => {
    sh(["git", "init", "-q"]);
    await mkdir(join(repo, ".codex"), { recursive: true });
    const malformed = "[mcp_servers.docket\ncommand = nope\n";
    await writeFile(join(repo, ".codex", "config.toml"), malformed);

    const report = initEnv(
      pinnedEnv(`${await fakeMcpBin()}:${BASE_PATH}`),
      "--agent",
      "codex",
    );
    const step = report.steps.find((s) => s.path === ".codex/config.toml");
    expect(step?.action).toBe("skip");
    expect(step?.reason).toBe("not valid TOML");
    expect(await readFile(join(repo, ".codex", "config.toml"), "utf8")).toBe(
      malformed,
    );
    expect(
      action(report, "skills", ".agents/skills/docket-task/SKILL.md"),
    ).toBe("create");
  });

  test("Codex skips MCP config when docket-mcp is not on PATH", async () => {
    sh(["git", "init", "-q"]);
    const report = initEnv(pinnedEnv(BASE_PATH), "--agent", "codex");
    const step = report.steps.find((s) => s.path === ".codex/config.toml");
    expect(step?.action).toBe("skip");
    expect(step?.reason).toContain("docket-mcp not on PATH");
    expect(
      await readFile(join(repo, ".codex", "config.toml"), "utf8").catch(
        () => "",
      ),
    ).toBe("");
    expect(
      action(report, "skills", ".agents/skills/docket-task/SKILL.md"),
    ).toBe("create");
  });

  test("adds .docket/ to .gitignore without touching existing rules; idempotent", async () => {
    sh(["git", "init", "-q"]);
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");

    const report = init();
    expect(action(report, "gitignore", ".gitignore")).toBe("update");
    const gitignore = await readFile(join(repo, ".gitignore"), "utf8");
    expect(gitignore.startsWith("node_modules/\n")).toBe(true);
    expect(gitignore).toContain(".docket/\n");

    const rerun = init();
    expect(action(rerun, "gitignore", ".gitignore")).toBe("skip");
  });

  test("flags gitignored pre-approval targets in the report", async () => {
    sh(["git", "init", "-q"]);
    await writeFile(
      join(repo, ".gitignore"),
      ".claude/\n.mcp.json\n.agents/\n.codex/\n",
    );

    const report = init("--claude", "--codex");
    const flagged = (path: string) =>
      report.steps.find((s) => s.path.endsWith(path))?.gitignored;
    expect(flagged(".mcp.json")).toBe(true);
    expect(flagged(".claude/settings.json")).toBe(true);
    expect(flagged("docket-task/SKILL.md")).toBe(true);
    expect(flagged(".codex/config.toml")).toBe(true);
    expect(
      report.steps.find((s) => s.path === ".agents/skills/docket-task/SKILL.md")
        ?.gitignored,
    ).toBe(true);
    expect(flagged("docket.yaml")).toBeUndefined();
    expect(flagged("AGENTS.md")).toBeUndefined();
    expect(flagged("docket/workflows/docket-task.md")).toBeUndefined();

    // Human output carries the flag and the tracked-alternative warning.
    const human = sh(["bun", CLI, "init", "--claude", "--codex"]);
    expect(human.stdout).toContain("gitignored — local only");
    expect(human.stdout).toContain("bundle workflows + AGENTS.md");
  });

  test("without git: config and bundle land, hook is skipped with a reason", () => {
    const report = init();
    expect(action(report, "config", "docket.yaml")).toBe("create");
    const hook = report.steps.find((s) => s.step === "hook");
    expect(hook?.action).toBe("skip");
    expect(hook?.reason).toBe("not a git repository");
    expect(action(report, "gitignore", ".gitignore")).toBe("skip");
  });
});
