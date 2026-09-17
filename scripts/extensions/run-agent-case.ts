/** Run one real, ephemeral native-agent qualification case; never fabricate a response. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const options = Object.fromEntries(
  Bun.argv.slice(2).map((value) => {
    const at = value.indexOf("=");
    if (!value.startsWith("--") || at < 0)
      throw new Error("Use --root=... --prompt=... --output=... [--codex=...]");
    return [value.slice(2, at), value.slice(at + 1)];
  }),
);
if (!options.root || !options.prompt || !options.output)
  throw new Error("root, prompt and output are required");
const root = resolve(options.root);
const output = resolve(options.output);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse to overwrite an earlier case's evidence.
const prompt = await readFile(resolve(options.prompt), "utf8");
await writeFile(join(output, "prompt.txt"), prompt);
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
};
const before = {
  head: git(["rev-parse", "HEAD"]).trim(),
  status: git(["status", "--porcelain=v1"]),
};
const binary = options.codex ?? "codex";
const sandbox = options.sandbox ?? "read-only";
if (!["read-only", "workspace-write"].includes(sandbox))
  throw new Error(
    "Only read-only or workspace-write agent sandboxes are supported",
  );
const version = Bun.spawnSync([binary, "--version"]);
if (version.exitCode) throw new Error(version.stderr.toString());
const fixtureMcp: string[] = [];
let fixtureDirectory: string | undefined;
if (options["fixture-mcp"]) {
  const fixture = resolve(options["fixture-mcp"]);
  if (fixture !== join(root, ".docket/mcp-fixture"))
    throw new Error(
      "Fixture MCP must use the prepared project-local .docket/mcp-fixture directory",
    );
  if ((await realpath(fixture)) !== fixture)
    throw new Error("Fixture MCP must have a canonical directory path");
  for (const name of ["fixture.json", "outbox.json"]) {
    const info = await lstat(join(fixture, name));
    if (!info.isFile() || info.size > 2 * 1024 * 1024)
      throw new Error("Fixture inputs must be bounded regular files");
  }
  const descriptorSource = await readFile(
    join(fixture, "fixture.json"),
    "utf8",
  );
  const descriptor = JSON.parse(descriptorSource);
  if (descriptor.synthetic !== true || descriptor.formatVersion !== 1)
    throw new Error("Only explicitly synthetic local MCP fixtures are allowed");
  fixtureDirectory = fixture;
  const serverSource = await readFile(
    join(import.meta.dir, "mcp-fixture.ts"),
    "utf8",
  );
  await writeFile(
    join(output, "fixture-runtime-before.json"),
    `${JSON.stringify(
      {
        serverSource,
        serverSha256: createHash("sha256").update(serverSource).digest("hex"),
        descriptorSource,
        descriptorSha256: createHash("sha256")
          .update(descriptorSource)
          .digest("hex"),
        outboxSource: await readFile(join(fixture, "outbox.json"), "utf8"),
      },
      null,
      2,
    )}\n`,
  );
  const settings = {
    command: process.execPath,
    args: [join(import.meta.dir, "mcp-fixture.ts"), fixture],
    cwd: root,
    required: true,
    startup_timeout_sec: 15,
    tool_timeout_sec: 15,
  };
  for (const [key, value] of Object.entries(settings))
    fixtureMcp.push(
      "-c",
      `mcp_servers.beacon_fixture.${key}=${JSON.stringify(value)}`,
    );
}
const argv = [
  binary,
  "exec",
  "--ignore-user-config",
  "--ephemeral",
  "--json",
  "--sandbox",
  sandbox,
  "-c",
  "sandbox_workspace_write.network_access=false",
  "-C",
  root,
  ...(sandbox === "workspace-write" &&
  (await lstat(join(root, ".git"))).isDirectory()
    ? ["--add-dir", join(root, ".git")]
    : []),
  ...fixtureMcp,
  "--output-last-message",
  join(output, "response.md"),
  "-",
];
// Ignore user product configuration to isolate unrelated connected services.
// Auth, repository instructions, sandbox and approval/rule enforcement remain in use.
// No model override: the installed CLI selects its own default; the event stream identifies it.
const startedAt = new Date().toISOString();
const child = Bun.spawn(argv, {
  cwd: root,
  stdin: new Blob([prompt]),
  stdout: Bun.file(join(output, "events.jsonl")),
  stderr: Bun.file(join(output, "stderr.txt")),
});
const timeout = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
const exitCode = await child.exited;
clearTimeout(timeout);
const after = {
  head: git(["rev-parse", "HEAD"]).trim(),
  status: git(["status", "--porcelain=v1"]),
};
if (fixtureDirectory) {
  await writeFile(
    join(output, "fixture-runtime-after.json"),
    `${JSON.stringify(
      {
        protocol: await readFile(
          join(fixtureDirectory, "protocol.jsonl"),
          "utf8",
        ).catch(() => ""),
        outboxSource: await readFile(
          join(fixtureDirectory, "outbox.json"),
          "utf8",
        ),
      },
      null,
      2,
    )}\n`,
  );
}
await writeFile(
  join(output, "diff.patch"),
  git(["diff", "--binary", before.head]),
);
const receipt = {
  method: "Actual native-agent invocation; no generated response substituted",
  startedAt,
  finishedAt: new Date().toISOString(),
  cli: version.stdout.toString().trim(),
  argv,
  root,
  before,
  after,
  exitCode,
  evidence: [
    "prompt.txt",
    "events.jsonl",
    "stderr.txt",
    "response.md",
    "diff.patch",
    ...(fixtureDirectory
      ? ["fixture-runtime-before.json", "fixture-runtime-after.json"]
      : []),
  ],
};
await writeFile(
  join(output, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(JSON.stringify({ output, exitCode, before, after }, null, 2));
process.exitCode = exitCode;
