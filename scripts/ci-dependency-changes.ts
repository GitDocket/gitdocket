import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const commitPattern = /^[0-9a-f]{40}$/;

export function includesDependencyChanges(paths: string[]): boolean {
  return paths.some(
    (path) =>
      path === "bun.lock" ||
      path === "bunfig.toml" ||
      path === "package.json" ||
      /^packages\/.+\/package\.json$/.test(path),
  );
}

async function changedFiles(base: string, head: string): Promise<string[]> {
  if (!commitPattern.test(base) || !commitPattern.test(head)) {
    throw new Error("dependency change detection requires full commit SHAs");
  }
  const child = Bun.spawn({
    cmd: ["git", "diff", "--name-only", "-z", base, head],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "git diff failed");
  }
  return stdout.split("\0").filter((path) => path.length > 0);
}

function argument(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index === -1 ? undefined : Bun.argv[index + 1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

if (import.meta.main) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  const paths = await changedFiles(argument("--base"), argument("--head"));
  await appendFile(output, `changed=${includesDependencyChanges(paths)}\n`);
}
