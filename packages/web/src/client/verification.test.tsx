import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VerifiedByCard } from "./App";

describe("VerifiedByCard", () => {
  test("groups presence by kind and spec anchor without result decoration", () => {
    const html = renderToStaticMarkup(
      <VerifiedByCard
        verification={{
          groups: [
            {
              kind: "test",
              anchors: [
                {
                  anchor: null,
                  sources: [{ path: "tests/whole.test.ts", line: 2 }],
                },
                {
                  anchor: "retry-behavior",
                  sources: [
                    { path: "tests/retry.test.ts", line: 8 },
                    { path: "tests/fallback.test.ts", line: 13 },
                  ],
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Verified by");
    expect(html).toContain("Tests");
    expect(html).toContain("Whole spec");
    expect(html).toContain("#retry-behavior");
    expect(html).toContain("tests/retry.test.ts:8");
    expect(html).not.toMatch(/pass|fail|unknown|%/i);
  });

  test("makes the useful zero state explicit without alarm styling", () => {
    const html = renderToStaticMarkup(
      <VerifiedByCard verification={{ groups: [] }} />,
    );
    expect(html).toContain("Nothing verifies this spec.");
    expect(html).not.toContain("error");
  });
});
