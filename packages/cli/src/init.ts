// docket init — adopt-in-place orchestration. Core owns the pure
// text transforms; this module owns filesystem and git: where the hook lives,
// what already exists, what gets written. Additive and idempotent — rerunning
// init reports "skip" for everything already in place.

import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  CONFIG_FILENAME,
  composeFreshnessBaseline,
  composeHook,
  composeManagedSection,
  DEFAULT_BUNDLE,
  DOCKET_WORKFLOWS,
  defaultConfigYaml,
  deriveProjectKey,
  ensureGitignore,
  hasAdapterMarker,
  type InitAction,
  isReserved,
  LocalFileStore,
  loadBundle,
  mergeClaudeSettings,
  mergeCodexConfig,
  mergeMcpJson,
  needsFrontmatter,
  parseConfig,
  proposeType,
  renderDocketSection,
  renderWorkflow,
  scaffoldFiles,
  workflowPath,
} from "@gitdocket/core";
import {
  AGENT_ADAPTERS,
  AGENT_TARGETS,
  type AgentTarget,
  renderTargetSkillStub,
} from "./agent-adapters";
import { refreshIndex } from "./indexing";

export {
  AGENT_ADAPTERS,
  AGENT_TARGETS,
  type AgentTarget,
} from "./agent-adapters";

export interface InitStep {
  step: string;
  path: string;
  action: InitAction;
  reason?: string;
  /** The target is gitignored — it exists locally but won't travel on clone. */
  gitignored?: boolean;
}

export interface InitReport {
  root: string;
  steps: InitStep[];
  /** Existing bundle markdown lacking `type` frontmatter — the agent's worklist. */
  adopt: { path: string; proposedType: string }[];
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const readIfPresent = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

/**
 * Where the prepare-commit-msg hook belongs. Respects core.hooksPath; husky's
 * `.husky/_` shim directory is regenerated, so user hooks go in `.husky/`.
 */
export function resolveHooksDir(
  root: string,
  hooksPath: string | undefined,
  hasGitDir: boolean,
): string | undefined {
  if (hooksPath) {
    const abs = hooksPath.startsWith("~")
      ? join(homedir(), hooksPath.slice(1))
      : isAbsolute(hooksPath)
        ? hooksPath
        : join(root, hooksPath);
    return /[/\\]\.husky[/\\]_$/.test(abs) ? join(abs, "..") : abs;
  }
  return hasGitDir ? join(root, ".git", "hooks") : undefined;
}

export async function runInit(
  cwd: string,
  opts: { project?: string; bundle?: string; agents: AgentTarget[] },
): Promise<InitReport> {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  const steps: InitStep[] = [];
  const targets = new Set(opts.agents);
  const record = (
    step: string,
    path: string,
    action: InitAction,
    reason?: string,
  ) => steps.push({ step, path, action, ...(reason ? { reason } : {}) });

  // docket.yaml — never rewritten once present.
  const configPath = join(root, CONFIG_FILENAME);
  let configSource = await readIfPresent(configPath);
  if (configSource === undefined) {
    configSource = defaultConfigYaml(
      opts.project ?? deriveProjectKey(basename(root)),
      opts.bundle ?? DEFAULT_BUNDLE,
    );
    await writeFile(configPath, configSource, "utf8");
    record("config", CONFIG_FILENAME, "create");
  } else {
    record("config", CONFIG_FILENAME, "skip", "already exists");
  }
  const config = parseConfig(configSource);

  const hasGitDir = git(root, ["rev-parse", "--git-dir"]) !== undefined;

  // Bundle scaffold: work/ dirs plus index.md/log.md — only what's missing.
  const bundleRoot = join(root, config.bundle);
  await mkdir(join(bundleRoot, "work/epics"), { recursive: true });
  await mkdir(join(bundleRoot, "work/tasks"), { recursive: true });
  const store = new LocalFileStore(bundleRoot);
  const today = new Date().toISOString().slice(0, 10);
  for (const file of scaffoldFiles(config.project, today)) {
    const path = join(config.bundle, file.path);
    if (await exists(join(bundleRoot, file.path))) {
      record("bundle", path, "skip", "already exists");
    } else {
      await store.write(file.path, file.content);
      record("bundle", path, "create");
    }
  }

  // Adoption is the freshness baseline, so init seeds the
  // watermark instead of lint demanding the ritual on a repo with nothing to
  // retrospect. Skips on a repo with no commits rather than write a sha-less
  // entry.
  {
    const logPath = join(config.bundle, "log.md");
    if (!hasGitDir) {
      record("freshness", logPath, "skip", "not a git repository");
    } else {
      const sha = git(root, ["rev-parse", "--short", "HEAD"]);
      const result = composeFreshnessBaseline(
        await store.read("log.md"),
        sha,
        today,
      );
      if (result.action !== "skip") await store.write("log.md", result.content);
      record("freshness", logPath, result.action, result.reason);
    }
  }

  // Workflows: the judgment procedures are bundle concepts — the
  // canonical content ships here, but once scaffolded the repo's copy is the
  // source of truth, so existing files are never touched.
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const w of DOCKET_WORKFLOWS) {
    const rel = workflowPath(w);
    const path = join(config.bundle, rel);
    if (await exists(join(bundleRoot, rel))) {
      record("workflow", path, "skip", "already exists");
    } else {
      await store.write(rel, renderWorkflow(w, now));
      record("workflow", path, "create");
    }
  }

  // Brownfield adoption: surface files lacking type frontmatter with a
  // mechanical proposal. Agent-assisted from here — init never edits them.
  const adopt: InitReport["adopt"] = [];
  for (const path of await store.list()) {
    if (isReserved(path)) continue;
    if (needsFrontmatter(await store.read(path)))
      adopt.push({ path, proposedType: proposeType(path) });
  }

  // Hook install — compose with whatever hook manager is in place.
  const huskyDir = join(root, ".husky");
  const hooksPath =
    git(root, ["config", "core.hooksPath"]) ??
    ((await exists(huskyDir)) ? ".husky" : undefined);
  const hooksDir = resolveHooksDir(root, hooksPath, hasGitDir);
  if (!hooksDir) {
    record("hook", "prepare-commit-msg", "skip", "not a git repository");
  } else {
    const hookPath = join(hooksDir, "prepare-commit-msg");
    const result = composeHook(await readIfPresent(hookPath));
    if (result.action === "skip") {
      record("hook", hookPath, "skip", result.reason);
    } else {
      await mkdir(hooksDir, { recursive: true });
      await writeFile(hookPath, result.content, "utf8");
      await chmod(hookPath, 0o755);
      record("hook", hookPath, result.action);
    }
  }

  // Agent adapters are thin generated pointers at the bundle workflows.
  // AGENTS.md is the tool-neutral surface and is always composed; CLAUDE.md
  // only when it already exists (or Claude support is opted in below).
  const section = renderDocketSection(config.project, config.bundle);
  const composeInstructions = async (name: string, create: boolean) => {
    const path = join(root, name);
    const existing = await readIfPresent(path);
    if (existing === undefined && !create) return;
    const result = composeManagedSection(existing, section);
    if (result.action !== "skip") await writeFile(path, result.content, "utf8");
    record("agents", name, result.action, result.reason);
  };
  await composeInstructions("AGENTS.md", true);
  for (const target of AGENT_TARGETS) {
    const adapter = AGENT_ADAPTERS[target];
    if (adapter.instructions)
      await composeInstructions(adapter.instructions, targets.has(target));
  }

  // Native agent adapters — opt-in (the "offer" lives in the caller). Skill
  // generation is target-neutral; only discovery roots and config differ.
  for (const target of targets) {
    const adapter = AGENT_ADAPTERS[target];
    for (const w of DOCKET_WORKFLOWS) {
      const rel = join(adapter.skillsRoot, w.slug, "SKILL.md");
      const stubPath = join(root, rel);
      const existing = await readIfPresent(stubPath);
      const stub = renderTargetSkillStub(adapter, w, config.bundle);
      if (existing === stub) {
        record("skills", rel, "skip", "up to date");
      } else if (existing === undefined || hasAdapterMarker(existing)) {
        await mkdir(join(root, adapter.skillsRoot, w.slug), {
          recursive: true,
        });
        await writeFile(stubPath, stub, "utf8");
        record("skills", rel, existing === undefined ? "create" : "update");
      } else {
        record("skills", rel, "skip", "hand-authored — remove to regenerate");
      }
    }
  }

  // MCP registration and permissions are harness-specific capabilities. A
  // dead command is never registered, but other useful adapter files land.
  const hasMcp = Bun.which("docket-mcp") !== null;
  if (targets.has("claude")) {
    // .mcp.json registers `command: "docket-mcp"` — a dead entry if the
    // binary isn't installed. Keep the outcome honest: skip
    // with the install hint rather than silently write broken config.
    const mcpPath = join(root, ".mcp.json");
    if (!hasMcp) {
      record(
        "claude",
        ".mcp.json",
        "skip",
        "docket-mcp not on PATH — install @gitdocket/mcp, then rerun `docket init --agent claude`",
      );
    } else {
      const mcp = mergeMcpJson(await readIfPresent(mcpPath));
      if (mcp.action !== "skip") await writeFile(mcpPath, mcp.content, "utf8");
      record("claude", ".mcp.json", mcp.action, mcp.reason);
    }

    const settingsPath = join(root, ".claude", "settings.json");
    const settings = mergeClaudeSettings(await readIfPresent(settingsPath));
    if (settings.action !== "skip") {
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(settingsPath, settings.content, "utf8");
    }
    record("claude", ".claude/settings.json", settings.action, settings.reason);
  }

  if (targets.has("codex")) {
    const rel = join(".codex", "config.toml");
    const path = join(root, rel);
    if (!hasMcp) {
      record(
        "codex",
        rel,
        "skip",
        "docket-mcp not on PATH — install @gitdocket/mcp, then rerun `docket init --agent codex`",
      );
    } else {
      const existing = await readIfPresent(path);
      let invalid: string | undefined;
      let alreadyRegistered = false;
      if (existing !== undefined) {
        try {
          const parsed = Bun.TOML.parse(existing) as Record<string, unknown>;
          const servers = parsed.mcp_servers;
          alreadyRegistered =
            typeof servers === "object" &&
            servers !== null &&
            "docket" in servers;
        } catch {
          invalid = "not valid TOML";
        }
      }
      if (invalid) {
        record("codex", rel, "skip", invalid);
      } else if (alreadyRegistered) {
        record("codex", rel, "skip", "already registered");
      } else {
        const result = mergeCodexConfig(existing);
        if (result.action !== "skip") {
          await mkdir(join(root, ".codex"), { recursive: true });
          await writeFile(path, result.content, "utf8");
        }
        record("codex", rel, result.action, result.reason);
      }
    }
  }

  // .docket/ holds per-checkout state (active task, cache) — never tracked.
  if (hasGitDir) {
    const gitignorePath = join(root, ".gitignore");
    const ignore = ensureGitignore(await readIfPresent(gitignorePath));
    if (ignore.action !== "skip")
      await writeFile(gitignorePath, ignore.content, "utf8");
    record("gitignore", ".gitignore", ignore.action, ignore.reason);
  } else {
    record("gitignore", ".gitignore", "skip", "not a git repository");
  }

  // Finish the mechanical setup: generate the committed index and
  // disposable cache from every concept that is valid today. Brownfield files
  // awaiting type frontmatter remain in the adoption worklist and are simply
  // absent until a later index pass.
  {
    const result = await refreshIndex(
      root,
      store,
      config,
      await loadBundle(store, config),
    );
    record(
      "index",
      join(config.bundle, "index.md"),
      result.indexChanged ? "update" : "skip",
      result.indexChanged ? undefined : "index unchanged; cache rebuilt",
    );
  }

  // Honesty pass: flag every touched path the repo gitignores — the
  // file landed, but it won't travel on clone. The hook lives under .git (or
  // a hooks dir) and is local by design, so it's exempt.
  const checkable = steps.filter((s) => s.step !== "hook");
  if (hasGitDir && checkable.length > 0) {
    const ignored = git(root, [
      "check-ignore",
      "--",
      ...checkable.map((s) => s.path),
    ]);
    if (ignored) {
      const flagged = new Set(ignored.split("\n"));
      for (const s of checkable) if (flagged.has(s.path)) s.gitignored = true;
    }
  }

  return { root, steps, adopt };
}
