import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DOCKET_VERSION } from "../packages/core/src/version";
import {
  digest,
  type StandaloneManifest,
  verifyStandaloneSet,
} from "./standalone-release";

export async function prepareTap(options: {
  source: string;
  artifacts: string;
  output: string;
  development?: boolean;
}) {
  const assets = await verifyStandaloneSet(options.source, options.artifacts, {
    development: options.development,
  });
  let formula = await readFile(
    join(
      import.meta.dir,
      "../release/homebrew-template/Formula/gitdocket.rb.in",
    ),
    "utf8",
  );
  formula = formula
    .replaceAll("@VERSION@", DOCKET_VERSION)
    .replaceAll(
      "@BASE@",
      `https://github.com/GitDocket/gitdocket/releases/download/v${DOCKET_VERSION}`,
    );
  const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
  let source: StandaloneManifest["source"] | undefined;
  for (const target of targets) {
    const manifest = JSON.parse(
      await readFile(join(options.artifacts, `${target}.json`), "utf8"),
    ) as StandaloneManifest;
    source = manifest.source;
    formula = formula.replaceAll(
      `@${target.toUpperCase().replaceAll("-", "_")}@`,
      manifest.sha256,
    );
  }
  assert(!/@[A-Z_]+@/.test(formula), "unresolved formula placeholder");
  await mkdir(join(options.output, "Formula"), { recursive: true });
  await writeFile(join(options.output, "Formula/gitdocket.rb"), formula);
  await writeFile(
    join(options.output, "README.md"),
    await readFile(
      join(import.meta.dir, "../release/homebrew-template/README.md"),
    ),
  );
  const workflow = (
    await readFile(
      join(
        import.meta.dir,
        "../release/homebrew-template/.github/workflows/verify.yml.in",
      ),
      "utf8",
    )
  ).replaceAll("@VERSION@", DOCKET_VERSION);
  await mkdir(join(options.output, ".github/workflows"), { recursive: true });
  await writeFile(
    join(options.output, ".github/workflows/verify.yml"),
    workflow,
  );
  const receipt = {
    schema: 1,
    version: DOCKET_VERSION,
    source,
    formulaSha256: digest(formula),
    publicVerificationWorkflowSha256: digest(workflow),
    assets,
    publication:
      "Prepared locally; publish only after the exact GitHub release and all assets are verified.",
  };
  await writeFile(
    join(options.output, "release.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      artifacts: { type: "string" },
      output: { type: "string" },
      development: { type: "boolean", default: false },
    },
  });
  const source = resolve(values.source ?? join(import.meta.dir, ".."));
  console.log(
    JSON.stringify(
      await prepareTap({
        source,
        artifacts: resolve(
          values.artifacts ?? join(source, "release/standalone"),
        ),
        output: resolve(
          values.output ?? join(source, "release/candidates/homebrew-tap"),
        ),
        development: values.development,
      }),
      null,
      2,
    ),
  );
}
