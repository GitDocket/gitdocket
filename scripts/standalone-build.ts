import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DOCKET_VERSION } from "../packages/core/src/version";
import { buildAssets } from "../packages/web/src/serve";

export const STANDALONE_TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64-baseline",
} as const;
export type StandaloneTarget = keyof typeof STANDALONE_TARGETS;
export function standaloneTarget(value: string): StandaloneTarget {
  if (!Object.hasOwn(STANDALONE_TARGETS, value)) {
    throw new Error(`Unsupported standalone target: ${value}`);
  }
  return value as StandaloneTarget;
}

export async function buildStandalone(options: {
  target: StandaloneTarget;
  output: string;
}): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const assets = await buildAssets();
  // Bun 1.3.14 can leave compiler scratch executables in the working directory.
  // Keep them in the ignored output tree rather than dirtying release sources.
  const previousCwd = process.cwd();
  process.chdir(output);
  try {
    for (const [name, source] of [
      ["docket", "packages/cli/src/index.ts"],
      ["docket-mcp", "packages/mcp/src/index.ts"],
    ] as const) {
      const result = await Bun.build({
        entrypoints: [join(root, source)],
        target: "bun",
        compile: {
          target: STANDALONE_TARGETS[options.target],
          outfile: join(output, name),
        },
        minify: true,
        define: {
          DOCKET_EMBEDDED_ASSETS: JSON.stringify(assets),
        },
        throw: false,
      });
      if (!result.success) {
        throw new Error(
          `${name} compilation failed: ${result.logs.join("\n")}`,
        );
      }
    }
  } finally {
    process.chdir(previousCwd);
  }
  console.log(
    `Built GitDocket ${DOCKET_VERSION} for ${options.target} in ${output}`,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values: Record<string, string> = {};
  while (args.length) {
    const key = args.shift();
    const value = args.shift();
    if ((key !== "--target" && key !== "--output") || !value) {
      throw new Error(
        "Usage: bun scripts/standalone-build.ts [--target OS-ARCH] [--output DIR]",
      );
    }
    values[key] = value;
  }
  const target = standaloneTarget(
    values["--target"] ?? `${process.platform}-${process.arch}`,
  );
  await buildStandalone({
    target,
    output: values["--output"] ?? `dist/standalone/${target}`,
  });
}
