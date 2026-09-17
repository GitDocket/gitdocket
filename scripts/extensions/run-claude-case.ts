/** Actual Claude Code read-only discovery qualification; no response is synthesized. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const options = Object.fromEntries(
  Bun.argv.slice(2).map((arg) => {
    const at = arg.indexOf("=");
    if (!arg.startsWith("--") || at < 0)
      throw new Error("Use --root=... --prompt=... --output=...");
    return [arg.slice(2, at), arg.slice(at + 1)];
  }),
);
if (!options.root || !options.prompt || !options.output)
  throw new Error("root, prompt and output are required");
const root = resolve(options.root);
const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const prompt = await readFile(resolve(options.prompt), "utf8");
await writeFile(join(output, "prompt.txt"), prompt);
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
const before = {
  head: git("rev-parse", "HEAD").trim(),
  status: git("status", "--porcelain=v1"),
};
const binary = options.claude ?? "claude";
const version = Bun.spawnSync([binary, "--version"]);
const argv = [
  binary,
  "--print",
  "--permission-mode",
  "plan",
  "--tools",
  "Read,Glob,Grep,Skill,Bash",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--no-chrome",
  "--no-session-persistence",
  "--output-format",
  "stream-json",
  "--verbose",
];
const startedAt = new Date().toISOString();
const child = Bun.spawn(argv, {
  cwd: root,
  stdin: new Blob([prompt]),
  stdout: Bun.file(join(output, "events.jsonl")),
  stderr: Bun.file(join(output, "stderr.txt")),
});
const timeout = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
const exitCode = await child.exited;
clearTimeout(timeout);
const after = {
  head: git("rev-parse", "HEAD").trim(),
  status: git("status", "--porcelain=v1"),
};
const events = (await readFile(join(output, "events.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const final = events.findLast((event) => event.type === "result");
if (typeof final?.result === "string")
  await writeFile(join(output, "response.md"), final.result);
await writeFile(
  join(output, "diff.patch"),
  git("diff", "--binary", before.head),
);
await writeFile(
  join(output, "receipt.json"),
  `${JSON.stringify({ method: "Actual Claude Code invocation, plan permission mode with read/discovery tools; unrelated settings and MCP connections omitted. No response substituted.", startedAt, finishedAt: new Date().toISOString(), cli: version.stdout.toString().trim(), argv, root, before, after, exitCode, resultSubtype: final?.subtype ?? null }, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      output,
      exitCode,
      resultSubtype: final?.subtype ?? null,
      resultIsError: final?.is_error ?? null,
      before,
      after,
    },
    null,
    2,
  ),
);
process.exitCode = exitCode;
