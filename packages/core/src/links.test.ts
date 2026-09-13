import { expect, test } from "bun:test";
import { resolveLink } from "./links";

test("link resolution decodes URI paths while preserving bundle containment", () => {
  expect(resolveLink("reference/guidance.md", "api%20standards.md#scope")).toBe(
    "reference/api standards.md",
  );
  expect(resolveLink("reference/guidance.md", "api%23standards.md")).toBe(
    "reference/api#standards.md",
  );
  for (const target of [
    "//example.com/a.md",
    "https://example.com/a.md",
    "%2e%2e/%2e%2e/secret.md",
    "..%2f..%2fsecret.md",
    "invalid%ZZ.md",
  ])
    expect(resolveLink("reference/guidance.md", target)).toBeUndefined();
});
