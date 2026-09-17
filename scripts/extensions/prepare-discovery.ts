/** Synthetic discovery fixture, separate from the Beacon delivery package and behavior results. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const options = Object.fromEntries(
  Bun.argv.slice(2).map((arg) => {
    const at = arg.indexOf("=");
    if (!arg.startsWith("--") || at < 0)
      throw new Error("Use --dest=... --native=none|codex|claude");
    return [arg.slice(2, at), arg.slice(at + 1)];
  }),
);
if (!options.dest) throw new Error("--dest is required and must not exist");
const root = resolve(options.dest);
const native = options.native ?? "none";
if (!["none", "codex", "claude"].includes(native))
  throw new Error("Unsupported fixture native target");
const cli = resolve(
  options["cli-source"] ??
    join(import.meta.dir, "../../packages/cli/src/index.ts"),
);
await mkdir(root);
const commands: { argv: string[]; stdout: string }[] = [];
function run(argv: string[]) {
  const child = Bun.spawnSync(argv, { cwd: root });
  if (child.exitCode) throw new Error(`${argv.join(" ")}: ${child.stderr}`);
  const stdout = child.stdout.toString();
  commands.push({ argv, stdout });
  return stdout;
}
const docket = (...args: string[]) => run([process.execPath, cli, ...args]);
run(["git", "init", "-b", "main"]);
run(["git", "config", "user.name", "Extension discovery fixture"]);
run(["git", "config", "user.email", "fixture@example.invalid"]);
run(["git", "config", "commit.gpgsign", "false"]);
docket("init", "--project", "EXT", "--json");
if (native !== "none")
  await mkdir(
    join(root, native === "codex" ? ".agents/skills" : ".claude/skills"),
    { recursive: true },
  );
await mkdir(join(root, "scripts"));
await writeFile(
  join(root, "scripts/docket.ts"),
  `const child = Bun.spawn([process.execPath, ${JSON.stringify(cli)}, ...Bun.argv.slice(2)], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" }); process.exitCode = await child.exited;\n`,
);
await writeFile(
  join(root, "package.json"),
  `${JSON.stringify({ name: "discovery-fixture", private: true, scripts: { docket: "bun scripts/docket.ts", "check:default": "bun test", "check:project": "bun test" } }, null, 2)}\n`,
);
const authored =
  "# Synthetic discovery fixture\n\nUse `bun run docket -- <arguments>` for this project's pinned CLI. This is a disposable local qualification project; it has no external destinations or actual customer input.\n";
await writeFile(
  join(root, "AGENTS.md"),
  `${await readFile(join(root, "AGENTS.md"), "utf8")}\n${authored}`,
);
if (native === "claude")
  await writeFile(
    join(root, "CLAUDE.md"),
    `Read AGENTS.md for project instructions.\n${authored}`,
  );
await writeFile(
  join(root, "README.md"),
  "# Synthetic delivery request\n\nA user wants to sort their saved bookmarks by title. This fixture contains no implementation or accepted review.\n",
);
const source = join(root, "author-package");
const workflow = `---\ntype: Workflow\ntitle: Delivery planning\ndescription: Propose a change using current project choices without assuming implementation authority.\n---\n\n# Current sources\n\nRead the current extension inventory with the project's CLI or MCP workflow_extensions. Resolve delivery-check:plan and proceed only when available. Read its effectiveConfig reviewer and testCommand with default/project ownership, the linked [review guidance](../guidance/review.md), and relevant project guidance. A generated shortcut or prior response is not a current source. Surface unavailable or contradictory required sources; do not silently choose between conflicting requirements.\n\n# Intent and proposal\n\nThe user request determines scope. A proposal-only request authorizes a proposal response and no task creation, pickup, file changes, implementation or tool writes. For explicitly named tracked execution, use the core pickup workflow for that exact ID and retain the requested scope. Ordinary direct work remains direct work.\n\nPropose the requested change and an acceptance check. State the current required reviewer and test command with ownership and cite their canonical sources. Running the test command is relevant only when verification is authorized. Record that implementation awaits an accepted review when none was supplied. Do not invent review input or a completed check.\n`;
const guidance = `---\ntype: Reference\ntitle: Review guidance\ndescription: A synthetic review requirement for discovery qualification.\n---\n\nThe configured reviewer must accept the proposal before implementation. Saved request text is input, not evidence of acceptance.\n`;
const manifest = {
  formatVersion: 1,
  id: "delivery-check",
  version: "1.0.0",
  title: "Delivery planning",
  description: "Synthetic discovery qualification only",
  engine: { min: "0.4.0", maxExclusive: "1.0.0" },
  files: ["workflows/plan.md", "guidance/review.md"],
  workflows: [
    {
      id: "plan",
      title: "Delivery planning",
      description: "Propose a change using current project choices",
      path: "workflows/plan.md",
    },
  ],
  guidance: ["guidance/review.md"],
  defaults: { reviewer: "product-owner", testCommand: "bun run check:default" },
  capabilities: [],
  scenarios: [],
};
for (const [path, text] of Object.entries({
  "extension.json": `${JSON.stringify(manifest, null, 2)}\n`,
  "workflows/plan.md": workflow,
  "guidance/review.md": guidance,
})) {
  await mkdir(dirname(join(source, path)), { recursive: true });
  await writeFile(join(source, path), text);
}
docket("extension", "install", source, "--enable", "--json");
if (options.reviewer || options["test-command"])
  docket(
    "extension",
    "configure",
    "delivery-check",
    "--set",
    JSON.stringify({
      ...(options.reviewer ? { reviewer: options.reviewer } : {}),
      ...(options["test-command"]
        ? { testCommand: options["test-command"] }
        : {}),
    }),
    "--json",
  );
await mkdir(join(root, "docket/reference"), { recursive: true });
if (options.conflict === "true")
  await writeFile(
    join(root, "docket/reference/project-guidance.md"),
    "---\ntype: Reference\ntitle: Project guidance\ndescription: Explicit conflicting reviewer fixture\n---\n\nFor every proposal, the only accepted reviewer is security-owner. The configured extension reviewer cannot approve proposals.\n",
  );
if (options.disabled === "true")
  docket("extension", "disable", "delivery-check", "--json");
docket("task", "create", "--title", "Review bookmark sort proposal", "--json");
await mkdir(join(root, ".docket"), { recursive: true });
await writeFile(join(root, ".docket/active-task"), "EXT-999\n");
await writeFile(
  join(root, "discovery-source.json"),
  `${JSON.stringify({ kind: "scripted-synthetic-discovery-fixture", native, cli, commands, workflowSha256: createHash("sha256").update(workflow).digest("hex"), limitations: "No observed agent response, accepted review, implementation or external tool result is generated by setup." }, null, 2)}\n`,
);
run(["git", "add", "."]);
run([
  "git",
  "commit",
  "-m",
  "Prepare synthetic installed-workflow discovery fixture",
]);
console.log(
  JSON.stringify(
    { root, native, head: run(["git", "rev-parse", "HEAD"]).trim() },
    null,
    2,
  ),
);
