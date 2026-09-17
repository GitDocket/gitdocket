/** Build the downloadable examples from the same canonical sources used by qualification. */
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const stage = await mkdtemp(join(tmpdir(), "gitdocket-example-archive-"));
const archive = join(root, "site/examples/workflow-examples.tar.gz");
const inputs = [
  "docs/extensions.md",
  "examples/product-delivery",
  "examples/extensions",
  "scripts/extensions",
];
try {
  for (const path of inputs) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(root, path), join(stage, path), { recursive: true });
  }
  await writeFile(
    join(stage, "package.json"),
    `${JSON.stringify({ name: "gitdocket-workflow-examples", private: true, type: "module", engines: { bun: ">=1.3.14" }, dependencies: { "@modelcontextprotocol/sdk": "^1.30.0", zod: "^4.5.4" } }, null, 2)}\n`,
  );
  await writeFile(
    join(stage, "README.md"),
    "# GitDocket workflow examples\n\nRequires Bun 1.3.14+, Git and GitDocket 0.4.0 installed through Homebrew or npm. Bun is required by the example app and scripts, not by the installed GitDocket commands. Read docs/extensions.md and examples/product-delivery/README.md. Prepare a fresh adopter with `bun scripts/extensions/prepare-example.ts --dest=/absolute/new/beacon --cli=/absolute/installed/docket`. Both packages install through that executable. The app is intentionally before export; retain actual agent proposals and supply a review only after reading them. Optional MCP fixture runners require `bun install --ignore-scripts`; all their issue/check/write inputs are synthetic. Historical rehearsal helpers are retained for reproducibility, and are labeled separately from the installed example.\n",
  );
  const files: Record<string, string> = {};
  async function collect(dir: string, prefix = "") {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : 1),
    )) {
      const path = join(prefix, entry.name);
      if (entry.isDirectory()) await collect(join(dir, entry.name), path);
      else if (entry.isFile())
        files[path] = createHash("sha256")
          .update(await readFile(join(dir, entry.name)))
          .digest("hex");
      else throw new Error(`Unsupported example archive entry: ${path}`);
    }
  }
  await collect(stage);
  await writeFile(
    join(stage, "example-contents.json"),
    `${JSON.stringify({ kind: "canonical-source-archive", files }, null, 2)}\n`,
  );
  await mkdir(dirname(archive), { recursive: true });
  const result = Bun.spawnSync(["tar", "-czf", archive, "-C", stage, "."]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(
    join(root, "site/examples/workflow-examples.json"),
    `${JSON.stringify({ kind: "canonical-source-archive", sha256, files, limits: "Setup and canonical sources only; no fabricated review or implementation evidence. Requires GitDocket 0.4.0 installed through Homebrew or npm; Bun runs the example app and scripts." }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      { archive, sha256, files: Object.keys(files).length },
      null,
      2,
    ),
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
