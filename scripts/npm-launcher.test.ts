import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const launcher = join(import.meta.dir, "../packages/cli/bin/run.cjs");
const node = Bun.which("node") as string;

async function fixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "docket-launcher-test-"));
  roots.push(root);
  const packageRoot = join(root, "node_modules/@gitdocket/cli");
  const native = join(
    root,
    `node_modules/@gitdocket/bin-${process.platform}-${process.arch}`,
  );
  const command = join(packageRoot, "bin/run.cjs");
  await mkdir(dirname(command), { recursive: true });
  await mkdir(join(native, "bin"), { recursive: true });
  await copyFile(launcher, command);
  const source = {
    kind: "public-export",
    commit: "a".repeat(40),
    exportSha256: "b".repeat(64),
  };
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@gitdocket/cli",
      version: "0.4.0",
      gitdocketSource: source,
    }),
  );
  await writeFile(
    join(native, "package.json"),
    JSON.stringify({ version: "0.4.0", gitdocketSource: source }),
  );
  const binary = join(native, "bin/docket");
  await writeFile(binary, `#!${node}\n${body}\n`);
  await chmod(binary, 0o755);
  return { root, command, native, binary };
}

test("both command packages carry one identical launcher; target errors are explicit", async () => {
  expect(await readFile(launcher, "utf8")).toBe(
    await readFile(
      join(import.meta.dir, "../packages/mcp/bin/run.cjs"),
      "utf8",
    ),
  );
  const { targetFor } = require(launcher);
  expect(targetFor("darwin", "arm64")).toBe("darwin-arm64");
  expect(targetFor("linux", "x64")).toBe("linux-x64");
  expect(() => targetFor("win32", "x64")).toThrow(
    "Unsupported platform win32-x64",
  );
  expect(() => targetFor("linux", "arm")).toThrow(
    "Unsupported platform linux-arm",
  );
});

test("launcher preserves arguments, stdin, protocol stdout, stderr and exit code", async () => {
  const f = await fixture(
    'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>input+=s);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input}));process.stderr.write("diagnostic");process.exitCode=7;});',
  );
  const child = Bun.spawn([node, f.command, "space value", "--flag=✓"], {
    cwd: f.root,
    stdin: new Blob(['{"jsonrpc":"2.0"}\n']),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(JSON.parse(out)).toEqual({
    args: ["space value", "--flag=✓"],
    input: '{"jsonrpc":"2.0"}\n',
  });
  expect(err).toBe("diagnostic");
  expect(code).toBe(7);
});

test("missing and mismatched binaries fail on stderr without source or runtime fallback", async () => {
  const f = await fixture('process.stdout.write("should not execute");');
  await writeFile(
    join(f.native, "package.json"),
    JSON.stringify({ version: "0.3.1" }),
  );
  let child = Bun.spawnSync([node, f.command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(1);
  expect(child.stdout.length).toBe(0);
  expect(child.stderr.toString()).toContain("does not match");
  await rm(f.native, { recursive: true });
  child = Bun.spawnSync([node, f.command], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  expect(child.stdout.length).toBe(0);
  expect(child.stderr.toString()).toContain("--include=optional");
});

test("SIGTERM reaches the binary and the launcher exits with the same signal", async () => {
  const f = await fixture(
    'process.stdout.write("ready\\n");setInterval(()=>{},1000);',
  );
  const child = Bun.spawn([node, f.command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "ready\n",
    );
    child.kill("SIGTERM");
    await child.exited;
    expect(child.signalCode).toBe("SIGTERM");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
});
