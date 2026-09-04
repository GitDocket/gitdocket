import { join } from "node:path";
import {
  buildReleasePlan,
  collectReleaseSnapshot,
  type ReleaseIntent,
  updateVersionSurfaces,
  validateReleaseIntent,
  writeReleasePlan,
} from "./release-contract";
import { stageRelease } from "./release-stage";

const ROOT = join(import.meta.dir, "..");

interface ParsedArgs {
  command: "version" | "prepare" | "stage";
  version: string;
  channel: string;
  notesPath: string;
  output?: string;
  planPath?: string;
  destination?: string;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args.shift();
  if (command !== "version" && command !== "prepare" && command !== "stage") {
    throw new Error(
      "usage: bun run release -- <version|prepare|stage> [options]",
    );
  }
  let version = "";
  let channel = "latest";
  let notesPath = "";
  let output: string | undefined;
  let planPath: string | undefined;
  let destination: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--version") version = args[++index] ?? "";
    else if (arg === "--channel") channel = args[++index] ?? "";
    else if (arg === "--notes") notesPath = args[++index] ?? "";
    else if (arg === "--output") output = args[++index];
    else if (arg === "--plan") planPath = args[++index];
    else if (arg === "--destination") destination = args[++index];
    else if (arg === "--json") json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (command === "stage") {
    if (!planPath || !destination) {
      throw new Error("stage requires --plan <path> and --destination <path>");
    }
  } else if (!version) throw new Error("--version is required");
  if (!notesPath) notesPath = `docs/releases/v${version}.md`;
  return {
    command,
    version,
    channel,
    notesPath,
    output,
    planPath,
    destination,
    json,
  };
}

function run(command: string[], cwd = ROOT): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`,
    );
  }
  process.stderr.write(`✓ ${command.join(" ")}\n`);
}

async function requireCleanCheckout(): Promise<void> {
  const result = Bun.spawnSync(
    ["git", "-C", ROOT, "status", "--porcelain", "--untracked-files=all"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  const dirty = result.stdout.toString().trim();
  if (dirty) throw new Error(`canonical checkout is not clean:\n${dirty}`);
}

function runPrivateGate(): void {
  run(["bun", "install", "--frozen-lockfile"]);
  run(["bunx", "biome", "ci", "."]);
  run(["bunx", "tsc", "--noEmit"]);
  run(["bun", "test"]);
  run(["bun", "run", "docket", "lint"]);
  run(["bun", "run", "docket", "index", "--check"]);
  run(["bun", "run", "audit:dependencies"]);
  run(["bun", "run", "release:pack"]);
}

async function versionCommand(args: ParsedArgs): Promise<void> {
  await requireCleanCheckout();
  const issues = validateReleaseIntent({
    version: args.version,
    channel: args.channel,
    notesPath: args.notesPath,
  });
  if (issues.length > 0) throw new Error(issues.join("\n"));
  const result = await updateVersionSurfaces(
    ROOT,
    args.version,
    args.notesPath,
  );
  run(["bun", "install"]);
  run(["bun", "run", "sync-shipped"]);
  const payload = {
    previousVersion: result.previousVersion,
    version: args.version,
    channel: args.channel,
    notesPath: result.notesPath,
    changed: result.changed,
    next: `review changes, write ${result.notesPath}, commit, then run bun run release -- prepare --version ${args.version} --channel ${args.channel}`,
  };
  process.stdout.write(
    args.json
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `prepared local version ${args.version}\n${payload.next}\n`,
  );
}

async function prepareCommand(args: ParsedArgs): Promise<void> {
  const intent: ReleaseIntent = {
    version: args.version,
    channel: args.channel,
    notesPath: args.notesPath,
  };
  const before = await collectReleaseSnapshot(ROOT, intent);
  buildReleasePlan(before, intent);
  runPrivateGate();
  const after = await collectReleaseSnapshot(ROOT, intent);
  if (after.sourceCommit !== before.sourceCommit) {
    throw new Error(
      "canonical HEAD changed while the release gate was running",
    );
  }
  const plan = buildReleasePlan(after, intent);
  const output = await writeReleasePlan(ROOT, plan, args.output);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ output, plan }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `release candidate ${plan.sourceTag} prepared at ${output}\nsource ${plan.sourceCommit}\napproval is still required before public mutation\n`,
    );
  }
}

async function stageCommand(args: ParsedArgs): Promise<void> {
  const result = await stageRelease({
    sourceRoot: ROOT,
    planPath: args.planPath as string,
    destination: args.destination as string,
    output: args.output,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `release candidate ${result.receipt.version} staged at ${result.output}\n` +
        `public diff: +${result.receipt.public.additions.length} ~${result.receipt.public.changes.length} -${result.receipt.public.deletions.length}\n` +
        `tarballs and smoke proof are bound; public mutation still requires approval\n`,
    );
  }
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.command === "version") await versionCommand(args);
    else if (args.command === "prepare") await prepareCommand(args);
    else await stageCommand(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
