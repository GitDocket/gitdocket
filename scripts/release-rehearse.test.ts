import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("release rehearsal command", () => {
  test("is structurally local-only and exposes every manual boundary", async () => {
    const source = await readFile(
      new URL("./release-rehearse.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('"npm", "publish"');
    expect(source).not.toContain('"npm", "dist-tag"');
    expect(source).not.toContain('"gh", "release"');
    expect(source).not.toContain('"git", "push"');
    expect(source).toContain('mode: "local-only"');
    expect(source).toContain(
      "approve the public commit and annotated-tag push",
    );
    expect(source).toContain("approve the protected release environment");
    expect(source).toContain(
      "immutable versions require operator reconciliation",
    );
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryGitHub, MemoryRegistry } from "./release-rehearse";

test("rehearsal retains optional platform dependencies and standalone asset bytes", async () => {
  const registry = new MemoryRegistry();
  const item = {
    id: "cli" as const,
    name: "@gitdocket/cli",
    version: "0.5.1",
    tarball: "fixture.tgz",
    integrity: "sha512-fixture",
    dependencies: { "@gitdocket/bin-linux-x64": "0.5.1" },
    optionalDependencies: { "@gitdocket/bin-linux-x64": "0.5.1" },
    repository: { url: "fixture", directory: "packages/cli" },
  };
  registry.seed(item);
  expect(
    (await registry.inspect(item.name)).version?.optionalDependencies,
  ).toEqual(item.optionalDependencies);
  const root = await mkdtemp(join(tmpdir(), "rehearsal-assets-"));
  try {
    await mkdir(join(root, "assets"));
    const receiptPath = join(root, "registry.json");
    const notesPath = join(root, "notes.md");
    const asset = join(root, "assets/native.tar.gz");
    await writeFile(receiptPath, "{}");
    await writeFile(notesPath, "Rehearsal");
    await writeFile(asset, "native fixture bytes");
    const github = new MemoryGitHub();
    await github.createRelease({
      tag: "v0.5.1",
      title: "Rehearsal",
      notesPath,
      receiptPath,
      prerelease: false,
      assets: [asset],
    });
    expect(
      (await github.inspectRelease())?.assets.find(
        (item) => item.name === "native.tar.gz",
      )?.sha256,
    ).toBe(
      new Bun.CryptoHasher("sha256")
        .update("native fixture bytes")
        .digest("hex"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
