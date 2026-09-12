/** Reproducible, scripted Harbor demo. Runs real Docket commands; no model output is simulated. */
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
    "Usage: bun scripts/demo-epic.ts --output <new-directory> [--cli <cli-source>] [--source <revision>]",
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
  if (exit !== 0) throw new Error(`${cmd[0]} failed (${exit}): ${err}`);
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
await file(
  "README.md",
  "# Harbor\n\nA synthetic project for a reproducible GitDocket walkthrough.\n",
);
await docket(["init", "--project", "HBR", "--json"], false);
const version = await docket(["--version"]);
await file(
  "request.txt",
  "Authored demo request (not a captured chat transcript):\nRun HBR-1, the Harbor welcome-guide epic, through completion.\n",
);
const epic = await docket<WorkItem>([
  "task",
  "create",
  "--type",
  "Epic",
  "--title",
  "Harbor welcome guide",
  "--description",
  "Give new contributors a verified first step.",
  "--json",
]);
const epicLink = `/${epic.path}`;
const guide = await docket<WorkItem>([
  "task",
  "create",
  "--title",
  "Write the welcome guide",
  "--epic",
  epicLink,
  "--json",
]);
const link = await docket<WorkItem>([
  "task",
  "create",
  "--title",
  "Connect the guide to onboarding",
  "--epic",
  epicLink,
  "--deps",
  guide.id,
  "--json",
]);
const next = await docket<WorkItem>([
  "task",
  "create",
  "--title",
  "Collect feedback on the welcome guide",
  "--deps",
  link.id,
  "--json",
]);
await body(
  epic,
  "# Context\n\nNew contributors need a short guide reachable from the project README.\n\n# Acceptance Criteria\n\n- [ ] The guide states a first step and review expectations.\n- [ ] README and onboarding reference link to the guide.\n- [ ] Checks pass and both child Outcomes include evidence.",
);
await body(
  guide,
  "# Context\n\nWrite the first step and explain how contributors review changes.\n\n# Acceptance Criteria\n\n- [ ] The guide includes First step and Review sections.",
);
await body(
  link,
  "# Context\n\nMake the completed guide discoverable.\n\n# Acceptance Criteria\n\n- [ ] README and onboarding reference link to the existing guide.",
);
await body(
  next,
  "# Context\n\nAfter the guide is integrated, ask a contributor to try it and record their feedback.\n\n# Acceptance Criteria\n\n- [ ] Record observed feedback before proposing changes.",
);
await file(
  "docket/reference/onboarding.md",
  "---\ntype: Reference\ntitle: Contributor onboarding\ndescription: Current onboarding entry point.\n---\n\n# Contributor onboarding\n\nThe welcome guide is being prepared.\n",
);
await docket(["index"], false);
const baseline = await commit("Seed the synthetic Harbor welcome-guide epic");
const initialReady = await docket<WorkItem[]>(["ready", "--json"]);
assert(
  initialReady.length === 1 && initialReady[0]?.id === guide.id,
  "Only the first dependency-ready child should be ready",
);
await docket(["task", "move", epic.id, "in-progress", "--json"]);
await docket(["task", "start", guide.id, "--json"]);
await file(
  "docket/reference/welcome.md",
  "---\ntype: Reference\ntitle: Welcome to Harbor\ndescription: A first step for contributors and a shared review habit.\n---\n\n# Welcome to Harbor\n\n## First step\n\nRead the project README, then choose a ready task with clear acceptance criteria.\n\n## Review\n\nCheck the result, update any affected documentation, and leave a linked commit for review.\n",
);
const guideText = await readFile(
  join(root, "docket/reference/welcome.md"),
  "utf8",
);
assert(
  guideText.includes("## First step") && guideText.includes("## Review"),
  "Guide headings must exist",
);
transcript.push({
  command: "verify guide headings",
  output: "PASS: First step and Review sections exist",
});
const guideCommit = await commit("Write the Harbor welcome guide", guide.id);
await body(
  guide,
  `# Context\n\nWrite the first step and explain how contributors review changes.\n\n# Acceptance Criteria\n\n- [x] The guide includes First step and Review sections.\n\n# Outcome\n\nShipped [the guide](/reference/welcome.md) in ${guideCommit}. Verified both required headings. Discovery links are the next dependent task.`,
);
await docket([
  "task",
  "close",
  guide.id,
  "--note",
  "Verified required guide headings; Outcome links the implementation commit.",
  "--json",
]);
await docket(["index"], false);
await commit("Complete the verified guide task", guide.id);
await docket(["task", "stop"], false);
const afterGuide = await docket<WorkItem[]>(["ready", "--json"]);
assert(
  afterGuide.length === 1 && afterGuide[0]?.id === link.id,
  "Completing the guide should unlock only its dependent task",
);
await docket(["task", "start", link.id, "--json"]);
await file(
  "README.md",
  "# Harbor\n\nA synthetic project for a reproducible GitDocket walkthrough.\n\nStart with the [welcome guide](docket/reference/welcome.md).\n",
);
await file(
  "docket/reference/onboarding.md",
  "---\ntype: Reference\ntitle: Contributor onboarding\ndescription: Current onboarding entry point.\n---\n\n# Contributor onboarding\n\nThe [welcome guide](/reference/welcome.md) explains the first step and review expectations. The README links directly to it.\n",
);
assert(
  (await readFile(join(root, "README.md"), "utf8")).includes(
    "(docket/reference/welcome.md)",
  ),
  "README link missing",
);
assert(
  (
    await readFile(join(root, "docket/reference/onboarding.md"), "utf8")
  ).includes("(/reference/welcome.md)"),
  "Onboarding link missing",
);
assert(
  (await readFile(join(root, "docket/reference/welcome.md"), "utf8")).length >
    0,
  "Link target missing",
);
transcript.push({
  command: "verify README and onboarding links",
  output: "PASS: both links resolve to the guide",
});
const linkCommit = await commit(
  "Link the guide and reconcile onboarding",
  link.id,
);
await body(
  link,
  `# Context\n\nMake the completed guide discoverable.\n\n# Acceptance Criteria\n\n- [x] README and onboarding reference link to the existing guide.\n\n# Outcome\n\nShipped README and [onboarding](/reference/onboarding.md) links in ${linkCommit}. Verified both link paths and their existing target. The previous pending-guide note is replaced by the current entry point.`,
);
await docket([
  "task",
  "close",
  link.id,
  "--note",
  "Both guide links verified; onboarding documentation reconciled in the same task.",
  "--json",
]);
await docket(["index"], false);
await commit("Complete onboarding discovery", link.id);
await docket(["task", "stop"], false);
const children = await docket<WorkItem[]>([
  "task",
  "list",
  "--epic",
  epic.id,
  "--all",
  "--json",
]);
assert(
  children.length === 2 && children.every((x) => x.status === "done"),
  "Both children must be complete",
);
const lint = await docket<{ severity: string }[]>(["lint", "--json"]);
assert(
  !lint.some((x) => x.severity === "error"),
  "Demo bundle has lint errors",
);
await body(
  epic,
  `# Context\n\nNew contributors need a short guide reachable from the project README.\n\n# Acceptance Criteria\n\n- [x] The guide states a first step and review expectations.\n- [x] README and onboarding reference link to the guide.\n- [x] Checks pass and both child Outcomes include evidence.\n\n# Outcome\n\nCompleted two dependent tasks. Guide: ${guideCommit}; onboarding: ${linkCommit}. Verified the required headings, both links and their target, both child Outcomes, and bundle lint (no errors). Updated the onboarding reference with the working entry point. Next ready: ${next.id}, Collect feedback on the welcome guide.\n\nThis is a scripted synthetic demonstration using actual Docket commands, not a recording of autonomous agent execution. Final review checked the whole epic before closure.`,
);
await docket([
  "task",
  "close",
  epic.id,
  "--note",
  "Final review passed: guide, working links, reconciled docs, and both task receipts.",
  "--json",
]);
await docket(["index"], false);
const finalCommit = await commit(
  "Complete Harbor epic after final review",
  epic.id,
);
const finalReady = await docket<WorkItem[]>(["ready", "--json"]);
assert(
  finalReady.length === 1 && finalReady[0]?.id === next.id,
  "Feedback must be the next ready task",
);
const finalTasks = await docket<WorkItem[]>([
  "task",
  "list",
  "--all",
  "--json",
]);
const history = await run(["git", "log", "--format=%h %s%n%b"]);
const receipt = {
  schema: 1,
  kind: "scripted-synthetic-demo",
  productSource: option("--source") ?? "working checkout",
  version,
  request: "Run HBR-1, the Harbor welcome-guide epic, through completion.",
  baseline,
  finalCommit,
  implementationCommits: [guideCommit, linkCommit],
  completed: [epic.id, guide.id, link.id],
  checks: [
    "Required guide headings",
    "README and onboarding links resolve",
    "Dependency order",
    "Two completed child Outcomes",
    "Bundle lint has no errors",
    "Whole epic reviewed before closure",
  ],
  knowledgeChanged: [
    "docket/reference/welcome.md",
    "docket/reference/onboarding.md",
    "README.md",
  ],
  nextReady: finalReady.map((x) => ({ id: x.id, title: x.title })),
  finalTasks,
  history,
  transcript,
};
await file("receipt.json", `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output: root,
      completed: receipt.completed,
      nextReady: receipt.nextReady,
      finalCommit,
    },
    null,
    2,
  ),
);
