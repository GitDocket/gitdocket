/** Prepare the canonical installed-package Beacon example. Setup supplies no review or implementation. */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const options = Object.fromEntries(
  Bun.argv.slice(2).map((arg) => {
    const i = arg.indexOf("=");
    if (i < 0 || !/^--(dest|cli)=/.test(arg))
      throw new Error(
        "Use --dest=/new/repository --cli=/absolute/installed/docket",
      );
    return [arg.slice(2, i), arg.slice(i + 1)];
  }),
);
if (
  !options.dest ||
  !options.cli ||
  !isAbsolute(options.dest) ||
  !isAbsolute(options.cli)
)
  throw new Error(
    "Absolute --dest and --cli are required; use a previously nonexistent destination and installed candidate executable.",
  );
const root = resolve(options.dest),
  cli = resolve(options.cli),
  source = resolve(import.meta.dir, "../..");
await mkdir(root);
const calls: {
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}[] = [];
function run(args: string[]) {
  const result = Bun.spawnSync(args, { cwd: root });
  const record = {
    args,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
  calls.push(record);
  if (result.exitCode) throw new Error(JSON.stringify(record));
  return record.stdout.trim();
}
run(["git", "init", "-b", "main"]);
run(["git", "config", "user.name", "Beacon example"]);
run(["git", "config", "user.email", "example@example.invalid"]);
run(["git", "config", "commit.gpgsign", "false"]);
const version = run([cli, "--version"]);
run([cli, "init", "--project", "BEC", "--agent", "codex", "--json"]);
const fixture = join(source, "examples/product-delivery");
for (const path of [
  "app",
  "tests",
  "server.ts",
  "package.json",
  "README.md",
  "docket/requests",
  "docket/delivery",
])
  await cp(join(fixture, path), join(root, path), { recursive: true });
const readme = await readFile(join(root, "README.md"), "utf8");
await writeFile(
  join(root, "README.md"),
  `${readme
    .replace(
      "# Beacon: request to local release handoff",
      "# Beacon: request to local release handoff\n\nThis repository is already prepared. Run application and `bun run docket -- ...` commands here. Setup commands and optional `scripts/extensions/` qualification helpers below run from the separate extracted example archive or GitDocket source checkout. The linked guide and installed workflow sources are retained locally in this repository.",
    )
    .replaceAll("../../docs/extensions.md", "docs/extensions.md")
    .replaceAll(
      "../extensions/product-delivery/",
      "docket/extensions/product-delivery/",
    )}`,
);
await mkdir(join(root, "docs"), { recursive: true });
await writeFile(
  join(root, "docs/extensions.md"),
  (await readFile(join(source, "docs/extensions.md"), "utf8")).replaceAll(
    "../examples/product-delivery/README.md",
    "../README.md",
  ),
);
await mkdir(join(root, "scripts"), { recursive: true });
await cp(
  join(source, "scripts/extensions/check-beacon-browser.ts"),
  join(root, "scripts/check-beacon-browser.ts"),
);
await writeFile(
  join(root, "scripts/docket.ts"),
  `// Exact installed candidate executable; no source-checkout fallback.\nconst child=Bun.spawn([${JSON.stringify(cli)},...Bun.argv.slice(2)],{cwd:process.cwd(),stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exitCode=await child.exited;\n`,
);
await mkdir(join(root, "docket/reference"), { recursive: true });
await writeFile(
  join(root, "docket/reference/project-guidance.md"),
  "---\ntype: Reference\ntitle: Beacon project guidance\ndescription: Project-owned local application and evidence standards.\n---\n\nKeep the app dependency-free and local. Use synthetic fixture data; stored URLs are never fetched. Before related planning, read [delivery records](/delivery/README.md) and follow actual accepted decisions. The installed product-delivery package owns its scoped process and current scalar choices. Plain planning authorizes a sourced plan only, with no application edits, task creation or pickup. Required export, baseline and actual-browser checks must pass before local release readiness. A missing browser or denied listener leaves that requirement unresolved. No publication procedure or external destination is authorized.\n",
);
const instructions = await readFile(join(root, "AGENTS.md"), "utf8");
await writeFile(
  join(root, "AGENTS.md"),
  `${instructions}\n## Beacon example\n\nUse \`bun run docket -- <arguments>\` for the exact installed candidate CLI. Read README.md for the application interface. The qualified installed workflow is \`product-delivery:deliver\`; read current availability/configuration and its complete canonical source before invoking it. Keep acceptance tests and fixture inputs unchanged. The baseline intentionally has no export feature. Keep Markdown paragraphs on single source lines and retain actual inputs, results and assistance; never invent review or verification.\n`,
);
const installation = JSON.parse(
  run([
    cli,
    "extension",
    "install",
    join(source, "examples/extensions/product-delivery"),
    "--enable",
    "--json",
  ]),
);
run([
  cli,
  "extension",
  "install",
  join(source, "examples/extensions/incident-review"),
  "--enable",
  "--json",
]);
run([cli, "index"]);
run([cli, "lint", "--json"]);
const hashes: Record<string, string> = {};
async function collect(dir: string, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) await collect(join(dir, entry.name), path);
    else
      hashes[path] = createHash("sha256")
        .update(await readFile(join(dir, entry.name)))
        .digest("hex");
  }
}
await collect(join(source, "examples/extensions/product-delivery"));
await writeFile(
  join(root, "example-source.json"),
  `${JSON.stringify(
    {
      kind: "scripted-installed-package-preparation",
      version,
      cli,
      package: installation.inventory.packages.find(
        (p: { id: string }) => p.id === "product-delivery",
      ),
      canonicalPackageHashes: hashes,
      checkerSha256: createHash("sha256")
        .update(await readFile(join(root, "scripts/check-beacon-browser.ts")))
        .digest("hex"),
      calls,
      limits:
        "Synthetic setup only. No review, implementation, observed agent behavior, successful checks or external handoff supplied. Both packages are installed through the exact candidate executable.",
    },
    null,
    2,
  )}\n`,
);
run(["git", "add", "."]);
run(["git", "commit", "-m", "Prepare Beacon with installed workflow packages"]);
console.log(
  JSON.stringify(
    {
      root,
      cli,
      version,
      head: run(["git", "rev-parse", "HEAD"]),
      workflow: "product-delivery:deliver",
      expectedBaseline:
        "Storage checks pass; export and browser acceptance fail until implemented.",
    },
    null,
    2,
  ),
);
