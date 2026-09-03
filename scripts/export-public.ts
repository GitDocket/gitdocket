import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const MANIFEST_PATH = "release/public-export.json";
const STATE_PATH = ".gitdocket-source.json";

interface ExportManifest {
  schema: 1;
  paths: string[];
}

interface ExportState {
  schema: 1;
  sourceCommit: string;
  manifestPath: typeof MANIFEST_PATH;
  files: Record<string, string>;
}

export interface ExportReport {
  sourceCommit: string;
  additions: string[];
  changes: string[];
  deletions: string[];
}

interface ExportOptions {
  sourceRoot: string;
  sourceCommit: string;
  destination: string;
  dryRun?: boolean;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

async function runGit(
  root: string,
  args: string[],
): Promise<{ stdout: Uint8Array; stderr: string }> {
  const process = Bun.spawn({
    cmd: ["git", "-C", root, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).bytes(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args[0]} failed`);
  }
  return { stdout, stderr };
}

const gitText = async (root: string, args: string[]): Promise<string> =>
  textDecoder.decode((await runGit(root, args)).stdout).trim();

function validateRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    path === ".git" ||
    path.startsWith(".git/") ||
    path === STATE_PATH
  ) {
    throw new Error(`unsafe public export path: ${path}`);
  }
}

async function sourceBlob(
  sourceRoot: string,
  sourceCommit: string,
  path: string,
): Promise<{ bytes: Uint8Array; executable: boolean }> {
  const entry = await gitText(sourceRoot, [
    "ls-tree",
    sourceCommit,
    "--",
    path,
  ]);
  const match = entry.match(/^(100644|100755) blob [0-9a-f]+\t(.+)$/);
  if (!match || match[2] !== path) {
    throw new Error(`manifest path is absent or not a regular file: ${path}`);
  }
  const { stdout } = await runGit(sourceRoot, [
    "show",
    `${sourceCommit}:${path}`,
  ]);
  return { bytes: stdout, executable: match[1] === "100755" };
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function scanPublicContent(path: string, bytes: Uint8Array): void {
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    return;
  }

  const forbidden: Array<[string, RegExp]> = [
    ["a machine-local home path", /(?:\/Users\/|[A-Za-z]:\\Users\\)/],
    [
      "the private canonical repository name",
      new RegExp(["docket", "context"].join("-"), "i"),
    ],
    [
      "private cross-project evidence",
      new RegExp(
        `${["Recipe", "Snag"].join("")}|${["Adios", "Alexa"].join(" ")}`,
        "i",
      ),
    ],
    ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    [
      "a credential-shaped token",
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/,
    ],
  ];
  for (const [label, pattern] of forbidden) {
    if (pattern.test(text)) throw new Error(`${path} contains ${label}`);
  }

  const syntheticIdSurface =
    path.includes(".test.") ||
    path.startsWith("examples/basic/") ||
    path === MANIFEST_PATH ||
    [
      "packages/core/src/init.ts",
      "packages/core/src/intents.ts",
      "packages/core/src/prompt-routing.ts",
      "packages/mcp/src/server.ts",
    ].includes(path);
  if (!syntheticIdSurface && /\b(?:DKT|DEC)-\d+\b/.test(text)) {
    throw new Error(`${path} contains private work-item provenance`);
  }
}

async function listFiles(root: string, current = ""): Promise<string[]> {
  const directory = join(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (current === "" && entry.name === ".git") continue;
    const path = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`destination contains a non-file entry: ${path}`);
  }
  return files.sort();
}

async function readState(
  destination: string,
): Promise<ExportState | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(destination, STATE_PATH), "utf8"),
    ) as ExportState;
    if (
      value.schema !== 1 ||
      value.manifestPath !== MANIFEST_PATH ||
      !/^[0-9a-f]{40}$/.test(value.sourceCommit) ||
      typeof value.files !== "object" ||
      value.files === null
    ) {
      throw new Error("invalid export state");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function verifyDestination(
  destination: string,
): Promise<ExportState | undefined> {
  const root = await gitText(destination, ["rev-parse", "--show-toplevel"]);
  if ((await realpath(root)) !== (await realpath(destination))) {
    throw new Error("destination must be the root of its Git checkout");
  }
  if (
    (await gitText(destination, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])) !== ""
  ) {
    throw new Error("destination Git checkout must be clean");
  }

  const files = await listFiles(destination);
  const state = await readState(destination);
  if (!state) {
    if (files.length > 0) {
      throw new Error(
        "destination is unexplained: expected an empty checkout or prior export state",
      );
    }
    return undefined;
  }

  const current = files.filter((path) => path !== STATE_PATH);
  const explained = Object.keys(state.files).sort();
  if (JSON.stringify(current) !== JSON.stringify(explained)) {
    throw new Error(
      "destination contains files not explained by its prior export state",
    );
  }
  for (const path of explained) {
    const hash = sha256(await readFile(join(destination, path)));
    if (hash !== state.files[path]) {
      throw new Error(
        `destination file differs from its prior export state: ${path}`,
      );
    }
  }
  return state;
}

async function loadManifest(
  sourceRoot: string,
  sourceCommit: string,
): Promise<ExportManifest> {
  const { bytes } = await sourceBlob(sourceRoot, sourceCommit, MANIFEST_PATH);
  const manifest = JSON.parse(textDecoder.decode(bytes)) as ExportManifest;
  if (manifest.schema !== 1 || !Array.isArray(manifest.paths)) {
    throw new Error("invalid public export manifest");
  }
  const paths = [...manifest.paths];
  for (const path of paths) validateRelativePath(path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("public export manifest contains duplicate paths");
  }
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    throw new Error("public export manifest paths must be sorted");
  }
  if (!paths.includes(MANIFEST_PATH)) {
    throw new Error(`public export manifest must include ${MANIFEST_PATH}`);
  }
  return manifest;
}

export async function exportPublicSnapshot(
  options: ExportOptions,
): Promise<ExportReport> {
  const sourceRoot = await realpath(options.sourceRoot);
  const destination = await realpath(options.destination);
  if (sourceRoot === destination)
    throw new Error("source and destination must differ");
  if (!/^[0-9a-f]{40}$/.test(options.sourceCommit)) {
    throw new Error("--source must be one exact 40-character commit SHA");
  }

  const head = await gitText(sourceRoot, ["rev-parse", "HEAD"]);
  if (head !== options.sourceCommit) {
    throw new Error(
      `source checkout is at ${head}, not ${options.sourceCommit}`,
    );
  }
  if (
    (await gitText(sourceRoot, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ])) !== ""
  ) {
    throw new Error("source Git checkout must be clean");
  }

  const prior = await verifyDestination(destination);
  const manifest = await loadManifest(sourceRoot, options.sourceCommit);
  const snapshot = new Map<
    string,
    { bytes: Uint8Array; executable: boolean; hash: string }
  >();
  for (const path of manifest.paths) {
    const blob = await sourceBlob(sourceRoot, options.sourceCommit, path);
    scanPublicContent(path, blob.bytes);
    snapshot.set(path, { ...blob, hash: sha256(blob.bytes) });
  }

  const additions: string[] = [];
  const changes: string[] = [];
  const priorFiles = prior?.files ?? {};
  for (const [path, file] of snapshot) {
    if (!(path in priorFiles)) additions.push(path);
    else if (priorFiles[path] !== file.hash) changes.push(path);
  }
  const deletions = Object.keys(priorFiles)
    .filter((path) => !snapshot.has(path))
    .sort();
  const report = {
    sourceCommit: options.sourceCommit,
    additions: additions.sort(),
    changes: changes.sort(),
    deletions,
  };
  if (options.dryRun) return report;

  for (const path of deletions) await rm(join(destination, path));
  for (const [path, file] of snapshot) {
    const output = join(destination, path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, file.bytes);
    await chmod(output, file.executable ? 0o755 : 0o644);
  }
  const state: ExportState = {
    schema: 1,
    sourceCommit: options.sourceCommit,
    manifestPath: MANIFEST_PATH,
    files: Object.fromEntries(
      [...snapshot].map(([path, file]) => [path, file.hash]),
    ),
  };
  await writeFile(
    join(destination, STATE_PATH),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return report;
}

function parseArgs(args: string[]): Omit<ExportOptions, "sourceRoot"> {
  let sourceCommit: string | undefined;
  let destination: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source") sourceCommit = args[++index];
    else if (arg === "--destination") destination = args[++index];
    else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!sourceCommit || !destination) {
    throw new Error(
      "usage: bun run export-public --source <40-char-commit> --destination <clean-git-checkout> [--dry-run]",
    );
  }
  return { sourceCommit, destination: resolve(destination), dryRun };
}

function printReport(report: ExportReport, dryRun: boolean): void {
  console.log(`source ${report.sourceCommit}${dryRun ? " (dry run)" : ""}`);
  for (const path of report.additions) console.log(`+ ${path}`);
  for (const path of report.changes) console.log(`~ ${path}`);
  for (const path of report.deletions) console.log(`- ${path}`);
  if (
    report.additions.length +
      report.changes.length +
      report.deletions.length ===
    0
  ) {
    console.log("no public file changes");
  }
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const report = await exportPublicSnapshot({
      sourceRoot: join(import.meta.dir, ".."),
      ...options,
    });
    printReport(report, options.dryRun ?? false);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
