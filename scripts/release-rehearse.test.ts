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
