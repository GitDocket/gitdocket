// docket upgrade — orchestration. Core owns the per-file transforms
// (upgradeAdapter, upgradeWorkflowFile, upgradeHookBlock); this module owns
// the filesystem walk, the `git merge-file` bridge, and the optional
// reconcile-task filing. Same shape as init: additive, idempotent, reports
// every item it considered.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  composeManagedSection,
  createWorkItem,
  DOCKET_VERSION,
  DOCKET_WORKFLOWS,
  findRepoRoot,
  hasDocketSection,
  LocalFileStore,
  type Merge3,
  markerVersion,
  parseConfig,
  renderDocketSection,
  renderWorkflow,
  type ShippedHistory,
  type UpgradeAction,
  upgradeAdapter,
  upgradeCodexConfig,
  upgradeHookBlock,
  upgradeWorkflowFile,
  WORKFLOWS_DIR,
} from "@docket/core";
import { AGENT_ADAPTERS, renderTargetSkillStub } from "./agent-adapters";
import { resolveHooksDir } from "./init";

export interface UpgradeItem {
  kind: "workflow" | "skill" | "config" | "section" | "hook";
  path: string;
  action: UpgradeAction;
  /** Provenance version before the upgrade; absent for pre-stamp markers. */
  from?: string;
  reason?: string;
}

export interface UpgradeReport {
  root: string;
  /** The version upgraded to. */
  available: string;
  dryRun: boolean;
  items: UpgradeItem[];
  conflicts: string[];
  /** Reconcile task filed for the conflicts (--file-task). */
  filedTask?: { id: string; path: string };
}

/**
 * Three-way merge via `git merge-file -p` — works on plain files, no repo
 * needed. Exit status is the conflict count (negative on error, which
 * execFileSync surfaces as a throw carrying stdout).
 */
export function gitMerge3(labels: {
  ours: string;
  base: string;
  theirs: string;
}): Merge3 {
  return (base, ours, theirs) => {
    const dir = mkdtempSync(join(tmpdir(), "docket-merge-"));
    try {
      const paths = {
        base: join(dir, "base"),
        ours: join(dir, "ours"),
        theirs: join(dir, "theirs"),
      };
      writeFileSync(paths.base, `${base}\n`);
      writeFileSync(paths.ours, `${ours}\n`);
      writeFileSync(paths.theirs, `${theirs}\n`);
      const args = [
        "merge-file",
        "-p",
        "-L",
        labels.ours,
        "-L",
        labels.base,
        "-L",
        labels.theirs,
        paths.ours,
        paths.base,
        paths.theirs,
      ];
      try {
        return {
          content: execFileSync("git", args, { encoding: "utf8" }),
          conflict: false,
        };
      } catch (error) {
        const e = error as { status?: number | null; stdout?: string };
        if (
          typeof e.status === "number" &&
          e.status > 0 &&
          e.stdout !== undefined
        )
          return { content: e.stdout, conflict: true };
        throw error;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const readIfPresent = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch(() => undefined);

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

export async function runUpgrade(
  cwd: string,
  opts: { dryRun?: boolean; fileTask?: boolean },
  /** Test seam: alternate shipped history / target version. */
  override?: { history?: ShippedHistory; available?: string },
): Promise<UpgradeReport> {
  const root = await findRepoRoot(cwd);
  if (!root)
    throw new Error("no docket.yaml found here or in any parent directory");
  const config = parseConfig(await readFile(join(root, "docket.yaml"), "utf8"));
  const store = new LocalFileStore(join(root, config.bundle));
  const history = override?.history;
  const available = override?.available ?? DOCKET_VERSION;
  const dryRun = opts.dryRun ?? false;

  const items: UpgradeItem[] = [];
  const conflicts: string[] = [];
  const apply = async (
    item: UpgradeItem,
    content: string,
    write: (content: string) => Promise<void>,
  ) => {
    items.push(item);
    if (item.action === "conflict") conflicts.push(item.path);
    const writes: UpgradeAction[] = [
      "regenerated",
      "replaced",
      "merged",
      "conflict",
    ];
    if (!dryRun && writes.includes(item.action)) await write(content);
  };

  // Workflows: every bundle file under workflows/ that is provably ours —
  // stamped with origin, recoverable by text match, or named after a shipped
  // slug (those get a skip with a reason; genuinely user-authored workflows
  // stay invisible to upgrade).
  const shippedSlugs = new Set(
    history
      ? history.flatMap((h) => Object.keys(h.bodies))
      : DOCKET_WORKFLOWS.map((w) => w.slug),
  );
  const workflowFiles = (await store.list()).filter((p) =>
    p.startsWith(`${WORKFLOWS_DIR}/`),
  );
  for (const rel of workflowFiles) {
    const source = await store.read(rel);
    const slug = basename(rel, ".md");
    const ours = /^origin:/m.test(source) || shippedSlugs.has(slug);
    const result = upgradeWorkflowFile(source, {
      history,
      current: available,
      merge3: gitMerge3({
        ours: `${config.bundle}${rel} (this repo)`,
        base: "shipped base",
        theirs: `docket ${available}`,
      }),
    });
    // recoverOrigin inside may still have claimed an unstamped, unlisted file.
    if (!ours && result.action === "skipped") continue;
    await apply(
      {
        kind: "workflow",
        path: join(config.bundle, rel),
        action: result.action,
        ...(result.from ? { from: result.from } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      },
      result.content,
      (content) => store.write(rel, content),
    );
  }

  // Required additive workflow surfaces. Unlike a deleted historical
  // workflow, these can be absent because older releases never shipped them.
  // Install them during a real current upgrade so regenerated guidance never
  // points at a missing canonical procedure.
  const additiveWorkflows = [
    {
      slug: "docket-pickup",
      workflowReason: "installed new canonical pickup workflow",
      skillReason: "installed new pickup binding",
    },
    {
      slug: "docket-epic",
      workflowReason: "installed new canonical epic-supervision workflow",
      skillReason: "installed new epic-supervision binding",
    },
  ] as const;
  for (const additive of additiveWorkflows) {
    const workflow = DOCKET_WORKFLOWS.find(
      (candidate) => candidate.slug === additive.slug,
    );
    const rel = join(WORKFLOWS_DIR, `${additive.slug}.md`);
    if (
      !workflow ||
      available !== DOCKET_VERSION ||
      workflowFiles.includes(rel)
    )
      continue;
    const content = renderWorkflow(
      workflow,
      new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    );
    await apply(
      {
        kind: "workflow",
        path: join(config.bundle, rel),
        action: "regenerated",
        reason: additive.workflowReason,
      },
      content,
      (next) => store.write(rel, next),
    );
  }

  // Skill stubs: existing marked files regenerate. Required additive adapters
  // are also installed into a discovered target root; all other absent skills
  // remain deliberate deletions and stay absent.
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    const { skillsRoot } = adapter;
    const installed = await stat(join(root, skillsRoot)).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    for (const w of DOCKET_WORKFLOWS) {
      const rel = join(skillsRoot, w.slug, "SKILL.md");
      const path = join(root, rel);
      const existing = await readIfPresent(path);
      const generated = renderTargetSkillStub(adapter, w, config.bundle);
      if (existing === undefined) {
        const additive = additiveWorkflows.find(
          (candidate) => candidate.slug === w.slug,
        );
        if (!installed || !additive || available !== DOCKET_VERSION) continue;
        await apply(
          {
            kind: "skill",
            path: rel,
            action: "regenerated",
            reason: additive.skillReason,
          },
          generated,
          async (content) => {
            await mkdir(join(root, skillsRoot, w.slug), { recursive: true });
            await writeFile(path, content, "utf8");
          },
        );
        continue;
      }
      const result = upgradeAdapter(existing, generated);
      await apply(
        {
          kind: "skill",
          path: rel,
          action: result.action,
          ...(result.from ? { from: result.from } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        },
        result.content,
        (content) => writeFile(path, content, "utf8"),
      );
    }
  }

  // Codex MCP config: only marker-managed blocks are upgrade-owned. Validate
  // the full TOML document first so regeneration never compounds a bad file.
  const codexConfigRel = join(".codex", "config.toml");
  const codexConfigPath = join(root, codexConfigRel);
  const codexConfig = await readIfPresent(codexConfigPath);
  if (codexConfig?.includes("# >>> docket mcp")) {
    let invalid = false;
    try {
      Bun.TOML.parse(codexConfig);
    } catch {
      invalid = true;
    }
    if (invalid) {
      items.push({
        kind: "config",
        path: codexConfigRel,
        action: "skipped",
        reason: "not valid TOML",
      });
    } else {
      const result = upgradeCodexConfig(codexConfig);
      await apply(
        {
          kind: "config",
          path: codexConfigRel,
          action: result.action === "update" ? "regenerated" : "up-to-date",
          ...(markerVersion(codexConfig)
            ? { from: markerVersion(codexConfig) }
            : {}),
        },
        result.content,
        (content) => writeFile(codexConfigPath, content, "utf8"),
      );
    }
  }

  // Instruction sections: regenerate existing marked spans only.
  const section = renderDocketSection(config.project, config.bundle);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(root, name);
    const existing = await readIfPresent(path);
    if (existing === undefined || !hasDocketSection(existing)) continue;
    const composed = composeManagedSection(existing, section);
    await apply(
      {
        kind: "section",
        path: name,
        action: composed.action === "skip" ? "up-to-date" : "regenerated",
        ...(markerVersion(existing) ? { from: markerVersion(existing) } : {}),
      },
      composed.content,
      (content) => writeFile(path, content, "utf8"),
    );
  }

  // Hook block: regenerate the marked span in place.
  const hasGitDir = git(root, ["rev-parse", "--git-dir"]) !== undefined;
  const hooksPath = git(root, ["config", "core.hooksPath"]);
  const hooksDir = resolveHooksDir(root, hooksPath, hasGitDir);
  if (hooksDir) {
    const hookPath = join(hooksDir, "prepare-commit-msg");
    const existing = await readIfPresent(hookPath);
    if (existing !== undefined) {
      const result = upgradeHookBlock(existing);
      await apply(
        {
          kind: "hook",
          path: hookPath,
          action:
            result.action === "update"
              ? "regenerated"
              : result.reason === "up to date"
                ? "up-to-date"
                : "skipped",
          ...(markerVersion(existing) ? { from: markerVersion(existing) } : {}),
          ...(result.action === "skip" && result.reason !== "up to date"
            ? { reason: result.reason }
            : {}),
        },
        result.content,
        (content) => writeFile(hookPath, content, "utf8"),
      );
    }
  }

  const report: UpgradeReport = { root, available, dryRun, items, conflicts };

  // Agent-first touch: conflicts are leftover judgment work — file them into
  // the repo's own ready queue instead of dropping them on the floor.
  if (opts.fileTask && conflicts.length > 0 && !dryRun) {
    report.filedTask = await createWorkItem(store, config, {
      title: `Reconcile docket workflow customizations with ${available}`,
      description: `docket upgrade left conflict markers in: ${conflicts.join(", ")} — resolve them, keeping local customizations where they still apply.`,
      tags: ["docket"],
    });
  }

  return report;
}
