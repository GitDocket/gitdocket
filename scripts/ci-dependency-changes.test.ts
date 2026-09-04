import { describe, expect, test } from "bun:test";
import { includesDependencyChanges } from "./ci-dependency-changes";

describe("CI dependency change scope", () => {
  test("runs the pull-request audit for dependency graph inputs", () => {
    expect(includesDependencyChanges(["bun.lock"])).toBeTrue();
    expect(includesDependencyChanges(["package.json"])).toBeTrue();
    expect(
      includesDependencyChanges(["packages/core/package.json"]),
    ).toBeTrue();
    expect(includesDependencyChanges(["bunfig.toml"])).toBeTrue();
  });

  test("skips the pull-request audit for engine-only changes", () => {
    expect(
      includesDependencyChanges([
        "packages/core/src/index.ts",
        "packages/core/src/index.test.ts",
      ]),
    ).toBeFalse();
  });

  test("skips the pull-request audit for site-only changes", () => {
    expect(
      includesDependencyChanges(["site/index.html", "site/styles.css"]),
    ).toBeFalse();
  });
});
