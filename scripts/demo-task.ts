/** Reproducible, scripted single-task Harbor demo. Runs real Docket commands; no model output is simulated. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = Bun.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const output = option("--output");
if (!output)
  throw new Error(
    "Usage: bun scripts/demo-task.ts --output <new-directory> [--cli <cli-source>] [--source <revision>]",
  );
const root = resolve(output);
const cli = resolve(
  option("--cli") ?? join(import.meta.dir, "../packages/cli/src/index.ts"),
);
await mkdir(root); // Refuse to overwrite an existing demonstration.
const transcript: { command: string; output: unknown }[] = [];
async function run(cmd: string[], cwd = root): Promise<string> {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`${cmd.join(" ")} failed (${exit}): ${err}`);
  return out.trim();
}
type WorkItem = { id: string; path: string; status: string; title: string };
async function docket<T = unknown>(args: string[], record = true): Promise<T> {
  const out = await run([process.execPath, cli, ...args]);
  let value: unknown = out;
  if (args.includes("--json")) value = JSON.parse(out);
  if (record)
    transcript.push({ command: `docket ${args.join(" ")}`, output: value });
  return value as T;
}
async function file(path: string, body: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), body);
}
async function commit(message: string, id?: string) {
  await run(["git", "add", "."]);
  await run([
    "git",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
    ...(id ? ["-m", `Task: ${id}`] : []),
  ]);
  return run(["git", "rev-parse", "HEAD"]);
}
async function body(item: { path: string }, value: string) {
  const path = join(root, "docket", item.path);
  const old = await readFile(path, "utf8");
  const boundary = old.indexOf("\n---", 3) + 4;
  await writeFile(path, `${old.slice(0, boundary)}\n\n${value}\n`);
}
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
await run(["git", "init", "-b", "main"]);
await run(["git", "config", "user.name", "Harbor Demo"]);
await run(["git", "config", "user.email", "demo@example.invalid"]);
await file("README.md", "# Harbor\n\nA synthetic documentation project.\n");
await docket(["init", "--project", "HBR", "--agent", "codex", "--json"]);
await commit("Initialize Harbor with Docket");
const task = await docket<WorkItem>([
  "task",
  "create",
  "--title",
  "Add a contributor guide",
  "--json",
]);
await body(
  task,
  "# Context\n\nAdd a discoverable guide and record the offline documentation decision.\n\n# Acceptance Criteria\n\n- [ ] First step and Review sections exist.\n- [ ] README link resolves.\n- [ ] The documentation decision is recorded.",
);
await docket(["task", "start", task.id, "--json"]);
await file(
  "docket/reference/contributing.md",
  "---\ntype: Reference\ntitle: Contributing\n---\n\n# First step\n\nRead the [documentation decision](documentation.md), then choose a small change.\n\n# Review\n\nCheck the changed files and links. Record what you verified.\n",
);
await file(
  "README.md",
  "# Harbor\n\nA synthetic documentation project.\n\nStart with the [contributor guide](docket/reference/contributing.md).\n",
);
await file(
  "docket/reference/documentation.md",
  "---\ntype: Reference\ntitle: Documentation decisions\n---\n\n# Offline documentation\n\nThe contributor-guide task established that project documentation must remain usable offline. Use repository-relative Markdown links, rather than hosted documentation URLs. New guides belong beside the [contributor guide](contributing.md) and should be linked from README for discovery. Verify each relative target exists.\n",
);
const guide = await readFile(
  join(root, "docket/reference/contributing.md"),
  "utf8",
);
assert(
  guide.includes("# First step") && guide.includes("# Review"),
  "guide headings",
);
for (const path of [
  "README.md",
  "docket/reference/contributing.md",
  "docket/reference/documentation.md",
]) {
  const src = await readFile(join(root, path), "utf8");
  for (const m of src.matchAll(/\]\(([^)]+)\)/g))
    assert(
      await Bun.file(resolve(root, path, "..", m[1] ?? "")).exists(),
      `link target ${m[1]}`,
    );
}
const implementation = await commit(
  "Add contributor guide and reconcile documentation",
  task.id,
);
await body(
  task,
  `# Context\n\nAdd a discoverable contributor guide.\n\n# Acceptance Criteria\n\n- [x] First step and Review sections exist.\n- [x] README link resolves.\n- [x] The documentation decision is recorded.\n\n# Outcome\n\nCommit ${implementation} adds [the guide](/reference/contributing.md) and a README entry point. Checked both headings and every relative Markdown target in all three changed documents. Reconciled [documentation decisions](/reference/documentation.md) so a later guide preserves offline use. This was a scripted CLI replay, not autonomous agent execution. No pending task was invented.`,
);
await docket([
  "task",
  "close",
  task.id,
  "--note",
  "Guide headings and all relative links verified; documentation decision retained.",
  "--json",
]);
await docket(["index"]);
const closure = await commit("Close verified contributor-guide task", task.id);
await docket(["task", "stop"]);
const ready = await docket<WorkItem[]>(["ready", "--json"]);
assert(ready.length === 0, "no fabricated backlog");
const tasks = await docket<WorkItem[]>(["task", "list", "--all", "--json"]);
assert(tasks.length === 1 && tasks[0]?.status === "done", "one completed task");
await docket(["overview", "--json"]);
await docket(["lint", "--json"]);
const receipt = {
  method:
    "Scripted CLI replay; authored content and checks, no simulated model response",
  source: option("--source") ?? "working candidate",
  runtime: process.versions.bun,
  task,
  implementation,
  closure,
  checks: [
    "two guide headings",
    "all relative Markdown targets exist",
    "one done standalone task",
    "no ready work",
    "no pre-existing spec, epic, briefing or project guidance",
  ],
  transcript,
};
await file("receipt.json", `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ root, task: task.id, implementation, closure }));
