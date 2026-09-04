// scanRepoMarkers against a real temp repo tree: globbing honors
// verify.tests, node_modules is always skipped, and the absent config key
// keeps the whole feature dormant.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStore, loadBundle, parseConfig } from "@gitdocket/core";
import { scanRepoMarkers } from "./verify";

let root: string;

const write = async (rel: string, content: string) => {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
};

// The token is split so this repo's own marker scan never reads these
// fixtures as markers (same discipline as quoting partial conflict markers).
const T = ["docket", "verifies"].join(":");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "docket-verify-"));
  await write(
    "docket/specs/alpha.md",
    "---\ntype: Spec\ntitle: Alpha\n---\n\nx\n",
  );
  await write(
    "packages/a/x.test.ts",
    `// ${T} /specs/alpha.md\nit();\n// ${T} /specs/gone.md\n`,
  );
  await write("packages/a/y.ts", `// ${T} /specs/alpha.md\n`);
  await write("node_modules/dep/z.test.ts", `// ${T} /specs/alpha.md\n`);
});

afterAll(() => rm(root, { recursive: true, force: true }));

const bundle = (config: ReturnType<typeof parseConfig>) =>
  loadBundle(new LocalFileStore(join(root, "docket")), config);

describe("scanRepoMarkers", () => {
  test("globs, resolves, and skips node_modules and non-matching files", async () => {
    const config = parseConfig(
      'bundle: docket/\nverify:\n  tests:\n    - "**/*.test.ts"\n',
    );
    const markers = await scanRepoMarkers(root, config, await bundle(config));
    expect(markers).toEqual([
      {
        source: "packages/a/x.test.ts",
        line: 1,
        target: "/specs/alpha.md",
        spec: "specs/alpha.md",
      },
      { source: "packages/a/x.test.ts", line: 3, target: "/specs/gone.md" },
    ]);
  });

  test("overlapping globs do not duplicate markers", async () => {
    const config = parseConfig(
      'bundle: docket/\nverify:\n  tests:\n    - "**/*.test.ts"\n    - "packages/**/*.test.ts"\n',
    );
    const markers = await scanRepoMarkers(root, config, await bundle(config));
    expect(markers).toHaveLength(2);
  });

  test("no verify key — dormant, returns nothing", async () => {
    const config = parseConfig("bundle: docket/\n");
    expect(await scanRepoMarkers(root, config, await bundle(config))).toEqual(
      [],
    );
  });
});
