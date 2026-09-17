import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { RELEASE_PACKAGE_DEFINITIONS } from "./release-contract";
import {
  checked,
  digest,
  type StandaloneManifest,
  verifyStandaloneSet,
} from "./standalone-release";

export async function packRelease(
  root: string,
  options: { sourceOnly?: boolean; artifacts?: string; output?: string } = {},
) {
  const output = options.output ?? join(root, "release/tarballs");
  const artifacts = options.artifacts ?? join(root, "release/standalone");
  const scratch = await mkdtemp(join(tmpdir(), "gitdocket-npm-pack-"));
  let source: StandaloneManifest["source"] | undefined;
  if (!options.sourceOnly) {
    await verifyStandaloneSet(root, artifacts);
    source = JSON.parse(
      await readFile(join(artifacts, "darwin-arm64.json"), "utf8"),
    ).source;
  }
  try {
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    for (const definition of RELEASE_PACKAGE_DEFINITIONS) {
      const binary = definition.id.startsWith("bin-");
      if (options.sourceOnly && binary) continue;
      const directory = join(scratch, definition.id);
      await mkdir(directory);
      const packageSource = join(root, "packages", definition.id);
      const manifest = JSON.parse(
        await readFile(join(packageSource, "package.json"), "utf8"),
      );
      assert.equal(manifest.name, definition.name);
      assert.equal(manifest.version, DOCKET_VERSION);
      assert(!manifest.private && manifest.files?.length);
      assert.equal(
        manifest.repository?.url,
        "git+https://github.com/GitDocket/gitdocket.git",
      );
      assert.equal(manifest.repository.directory, `packages/${definition.id}`);
      assert.equal(manifest.publishConfig?.access, "public");
      assert.equal(
        manifest.publishConfig.registry,
        "https://registry.npmjs.org/",
      );
      delete manifest.devDependencies;
      for (const field of ["dependencies", "optionalDependencies"]) {
        for (const [name, value] of Object.entries(manifest[field] ?? {})) {
          if (name.startsWith("@gitdocket/")) {
            assert.equal(value, "workspace:*");
            manifest[field][name] = DOCKET_VERSION;
          }
        }
      }
      if (binary) {
        const target = definition.id.slice(4);
        const proof = JSON.parse(
          await readFile(join(artifacts, `${target}.json`), "utf8"),
        ) as StandaloneManifest;
        checked(
          ["tar", "-xzf", join(artifacts, proof.archive), "-C", directory],
          root,
        );
        await mkdir(join(directory, "bin"));
        for (const command of ["docket", "docket-mcp"]) {
          assert.equal(
            digest(await readFile(join(directory, command))),
            proof.files[command],
          );
          await copyFile(
            join(directory, command),
            join(directory, "bin", command),
          );
          await chmod(join(directory, "bin", command), 0o755);
          await rm(join(directory, command));
        }
      } else {
        const contents =
          definition.id === "core" || definition.id === "web" ? "src" : "bin";
        await cp(join(packageSource, contents), join(directory, contents), {
          recursive: true,
        });
        await copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
        const readme = join(packageSource, "README.md");
        if (await Bun.file(readme).exists())
          await copyFile(readme, join(directory, "README.md"));
      }
      if (source && !["core", "web"].includes(definition.id))
        manifest.gitdocketSource = source;
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      const path = join(
        output,
        `gitdocket-${definition.id}-${DOCKET_VERSION}.tgz`,
      );
      checked(
        ["bun", "pm", "pack", "--filename", path, "--ignore-scripts"],
        directory,
      );
      const entries = checked(["tar", "-tzf", path], root).split("\n");
      assert(entries.includes("package/package.json"));
      assert(
        entries.every(
          (entry) =>
            !/(?:^|\/)(?:node_modules|\.git|release)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
              entry,
            ),
        ),
        "unexpected source/test/private file in tarball",
      );
      if (binary)
        for (const command of ["docket", "docket-mcp"])
          assert(entries.includes(`package/bin/${command}`));
      console.log(`verified ${basename(path)}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const tag =
    process.env.GITHUB_REF_TYPE === "tag"
      ? process.env.GITHUB_REF_NAME
      : undefined;
  if (tag && tag !== `v${DOCKET_VERSION}`)
    throw new Error(`release tag ${tag} does not match v${DOCKET_VERSION}`);
  const args = Bun.argv.slice(2);
  if (args.some((arg) => arg !== "--source-only"))
    throw new Error("Usage: bun scripts/release-pack.ts [--source-only]");
  await packRelease(join(import.meta.dir, ".."), {
    sourceOnly: args.includes("--source-only"),
  });
}
