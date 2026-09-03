import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";
import { INDEX_MARKER } from "./indexmd";
import {
  ALLOW_RULES,
  composeFreshnessBaseline,
  composeHook,
  defaultConfigYaml,
  deriveProjectKey,
  ensureGitignore,
  mergeClaudeSettings,
  mergeCodexConfig,
  mergeMcpJson,
  needsFrontmatter,
  proposeType,
  scaffoldFiles,
  upgradeCodexConfig,
} from "./init";
import { findFreshnessWatermark } from "./lint";
import { DOCKET_VERSION } from "./version";

describe("defaultConfigYaml", () => {
  test("round-trips through parseConfig", () => {
    const config = parseConfig(defaultConfigYaml("ACME", "notes/"));
    expect(config.project).toBe("ACME");
    expect(config.bundle).toBe("notes/");
    expect(config.git.trailer).toBe("Task");
    expect(config.workflow.states).toContain("in-review");
    expect(config.workflow.states).toContain("closed");
  });

  test("older configs gain new canonical states without a file rewrite", () => {
    const config = parseConfig(
      "workflow:\n  states: [todo, in-progress, blocked, in-review, done]\n",
    );
    expect(config.workflow.states).toEqual([
      "todo",
      "in-progress",
      "blocked",
      "in-review",
      "done",
      "closed",
    ]);
  });
});

describe("deriveProjectKey", () => {
  test("uppercases and truncates", () => {
    expect(deriveProjectKey("my-cool-app")).toBe("MYC");
    expect(deriveProjectKey("docs")).toBe("DOC");
  });
  test("falls back when nothing usable", () => {
    expect(deriveProjectKey("---")).toBe("DKT");
  });
});

describe("scaffoldFiles", () => {
  test("index.md carries the generated marker, log.md a dated entry", () => {
    const files = scaffoldFiles("ACME", "2026-07-21");
    const index = files.find((f) => f.path === "index.md");
    const log = files.find((f) => f.path === "log.md");
    expect(index?.content).toContain(INDEX_MARKER);
    expect(index?.content).toContain("project's full name");
    expect(index?.content).toContain("explaining its purpose");
    expect(log?.content).toContain("## 2026-07-21");
  });
});

describe("composeFreshnessBaseline", () => {
  const today = "2026-07-21";

  test("stamps into an existing today section — freshly scaffolded log", () => {
    const [log] = scaffoldFiles("ACME", today).filter(
      (f) => f.path === "log.md",
    );
    const result = composeFreshnessBaseline(
      log?.content ?? "",
      "abc1234",
      today,
    );
    expect(result.action).toBe("create");
    expect(result.content).toContain(
      "- **Freshness** — baseline at adoption; reviewed through `abc1234`",
    );
    // The stamp must be what lint's watermark scan finds.
    expect(findFreshnessWatermark(result.content)).toEqual({
      sha: "abc1234",
      date: today,
    });
  });

  test("opens a new today section at the top of a brownfield log", () => {
    const log = "# Log\n\n## 2026-01-01\n\n- **Create** — old entry.\n";
    const result = composeFreshnessBaseline(log, "abc1234", today);
    expect(result.action).toBe("create");
    expect(result.content.indexOf(`## ${today}`)).toBeLessThan(
      result.content.indexOf("## 2026-01-01"),
    );
    expect(result.content).toContain("- **Create** — old entry.");
    expect(findFreshnessWatermark(result.content)?.date).toBe(today);
  });

  test("skips a log that already carries a watermark — any phrasing", () => {
    const ritual =
      "# Log\n\n## 2026-01-01\n\n- **Freshness** — reviewed through `def5678` (12 commits, 0 trailerless): no drift found.\n";
    expect(composeFreshnessBaseline(ritual, "abc1234", today)).toEqual({
      action: "skip",
      content: ritual,
      reason: "already stamped",
    });
    const baseline = composeFreshnessBaseline(
      "# Log\n",
      "abc1234",
      today,
    ).content;
    expect(composeFreshnessBaseline(baseline, "0000000", today).action).toBe(
      "skip",
    );
  });

  test("skips instead of writing a sha-less entry when there is no commit", () => {
    const result = composeFreshnessBaseline("# Log\n", undefined, today);
    expect(result.action).toBe("skip");
    expect(result.reason).toBe("no commits yet");
    expect(result.content).toBe("# Log\n");
  });
});

describe("composeHook", () => {
  test("creates a fresh executable-shaped hook", () => {
    const result = composeHook(undefined);
    expect(result.action).toBe("create");
    expect(result.content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(result.content).toContain("interpret-trailers");
  });

  test("appends to an existing hook without touching its content", () => {
    const existing = "#!/bin/sh\nnpx lint-staged";
    const result = composeHook(existing);
    expect(result.action).toBe("update");
    expect(result.content.startsWith("#!/bin/sh\nnpx lint-staged\n")).toBe(
      true,
    );
    expect(result.content).toContain("docket prepare-commit-msg");
  });

  test("skips when the block is already installed", () => {
    const installed = composeHook(undefined).content;
    const result = composeHook(installed);
    expect(result.action).toBe("skip");
    expect(result.content).toBe(installed);
  });

  test("marker carries the engine version; the pre-DKT-18 unversioned marker still counts as installed", () => {
    expect(composeHook(undefined).content).toContain(
      `# >>> docket prepare-commit-msg@${DOCKET_VERSION} >>>`,
    );
    const legacy = `#!/bin/sh\n# >>> docket prepare-commit-msg >>>\nold block\n# <<< docket prepare-commit-msg <<<\n`;
    expect(composeHook(legacy).action).toBe("skip");
  });
});

describe("mergeMcpJson", () => {
  test("creates from scratch", () => {
    const result = mergeMcpJson(undefined);
    expect(result.action).toBe("create");
    expect(JSON.parse(result.content).mcpServers.docket.command).toBe(
      "docket-mcp",
    );
  });

  test("adds docket alongside existing servers", () => {
    const existing = JSON.stringify({
      mcpServers: { other: { command: "other-mcp" } },
    });
    const result = mergeMcpJson(existing);
    expect(result.action).toBe("update");
    const parsed = JSON.parse(result.content);
    expect(parsed.mcpServers.other.command).toBe("other-mcp");
    expect(parsed.mcpServers.docket.command).toBe("docket-mcp");
  });

  test("never overwrites an existing docket entry", () => {
    const existing = JSON.stringify({
      mcpServers: { docket: { command: "custom" } },
    });
    const result = mergeMcpJson(existing);
    expect(result.action).toBe("skip");
    expect(result.content).toBe(existing);
  });

  test("refuses to clobber unparseable JSON", () => {
    const result = mergeMcpJson("{ not json");
    expect(result.action).toBe("skip");
    expect(result.reason).toBe("not valid JSON");
  });
});

describe("mergeCodexConfig", () => {
  test("creates a project MCP registration from scratch", () => {
    const result = mergeCodexConfig(undefined);
    expect(result.action).toBe("create");
    expect(result.content).toContain("[mcp_servers.docket]");
    expect(result.content).toContain('command = "docket-mcp"');
    expect(result.content).toContain(`docket mcp@${DOCKET_VERSION}`);
  });

  test("appends without reformatting unrelated TOML", () => {
    const existing =
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const result = mergeCodexConfig(existing);
    expect(result.action).toBe("update");
    expect(result.content.startsWith(existing)).toBe(true);
    expect(result.content).toContain("[mcp_servers.docket]");
  });

  test("never overwrites an existing docket table", () => {
    const existing = '[mcp_servers.docket]\ncommand = "custom"\n';
    expect(mergeCodexConfig(existing)).toEqual({
      action: "skip",
      content: existing,
      reason: "already registered",
    });
  });

  test("upgrades only a marker-managed block", () => {
    const current = mergeCodexConfig('model = "gpt-5"\n').content;
    const stale = current.replace(
      `docket mcp@${DOCKET_VERSION}`,
      "docket mcp@0.0.0",
    );
    const upgraded = upgradeCodexConfig(stale);
    expect(upgraded.action).toBe("update");
    expect(upgraded.content).toBe(current);
    expect(upgradeCodexConfig(current).action).toBe("skip");
    expect(
      upgradeCodexConfig('[mcp_servers.docket]\ncommand = "custom"\n').reason,
    ).toBe("no docket block");
  });
});

describe("mergeClaudeSettings", () => {
  test("creates with allow rules and enableAllProjectMcpServers", () => {
    const result = mergeClaudeSettings(undefined);
    expect(result.action).toBe("create");
    const parsed = JSON.parse(result.content);
    expect(parsed.enableAllProjectMcpServers).toBe(true);
    for (const rule of ALLOW_RULES)
      expect(parsed.permissions.allow).toContain(rule);
  });

  test("merges into existing settings, preserving unknown keys and rules", () => {
    const existing = JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"], deny: ["WebFetch"] },
    });
    const result = mergeClaudeSettings(existing);
    expect(result.action).toBe("update");
    const parsed = JSON.parse(result.content);
    expect(parsed.model).toBe("opus");
    expect(parsed.permissions.deny).toEqual(["WebFetch"]);
    expect(parsed.permissions.allow).toContain("Bash(ls:*)");
    for (const rule of ALLOW_RULES)
      expect(parsed.permissions.allow).toContain(rule);
  });

  test("skips when already configured", () => {
    const configured = mergeClaudeSettings(undefined).content;
    const result = mergeClaudeSettings(configured);
    expect(result.action).toBe("skip");
    expect(result.content).toBe(configured);
  });
});

describe("ensureGitignore", () => {
  test("creates with the .docket/ rule", () => {
    const result = ensureGitignore(undefined);
    expect(result.action).toBe("create");
    expect(result.content).toContain(".docket/\n");
  });

  test("appends without touching existing rules", () => {
    const result = ensureGitignore("node_modules/\n*.log");
    expect(result.action).toBe("update");
    expect(result.content.startsWith("node_modules/\n*.log\n")).toBe(true);
    expect(result.content).toContain(".docket/\n");
  });

  test("skips every spelling that already covers the directory", () => {
    for (const rule of [".docket", ".docket/", "/.docket", "/.docket/"]) {
      const result = ensureGitignore(`dist/\n${rule}\n`);
      expect(result.action).toBe("skip");
      expect(result.reason).toBe("already ignored");
    }
  });

  test("idempotent through its own output", () => {
    const first = ensureGitignore("dist/\n");
    expect(ensureGitignore(first.content).action).toBe("skip");
  });
});

describe("needsFrontmatter", () => {
  test("flags bare markdown and typeless frontmatter", () => {
    expect(needsFrontmatter("# Hello\n")).toBe(true);
    expect(needsFrontmatter("---\ntitle: x\n---\n# Hello\n")).toBe(true);
  });
  test("passes a typed concept", () => {
    expect(needsFrontmatter("---\ntype: Spec\ntitle: x\n---\n")).toBe(false);
  });
});

describe("proposeType", () => {
  test("maps conventional directories", () => {
    expect(proposeType("work/epics/E-1.md")).toBe("Epic");
    expect(proposeType("work/tasks/T-1.md")).toBe("Task");
    expect(proposeType("decisions/DEC-1.md")).toBe("Decision");
    expect(proposeType("specs/api.md")).toBe("Spec");
    expect(proposeType("reference/links.md")).toBe("Reference");
    expect(proposeType("random/notes.md")).toBe("Doc");
  });
});
