// The Docs view's pure half: sidebar ordering and path detection.

import { describe, expect, test } from "bun:test";
import { type DocSection, isDocPath, sidebarSections } from "./docs";

const item = (path: string, title: string | null) => ({
  path,
  title,
  description: null,
});

describe("sidebarSections", () => {
  test("re-sorts each section's articles by title, case-insensitively", () => {
    const sections: DocSection[] = [
      {
        name: "specs",
        items: [
          item("specs/newest.md", "Zulu"),
          item("specs/older.md", "alpha"),
          item("specs/mid.md", "Mike"),
        ],
      },
    ];
    expect(sidebarSections(sections)[0]?.items.map((i) => i.title)).toEqual([
      "alpha",
      "Mike",
      "Zulu",
    ]);
    // Input order (the server's newest-first) is left untouched.
    expect(sections[0]?.items[0]?.title).toBe("Zulu");
  });

  test("title-less articles sort by path; section order is preserved", () => {
    const sections: DocSection[] = [
      { name: "specs", items: [] },
      {
        name: "decisions",
        items: [item("decisions/z.md", null), item("decisions/a.md", "b")],
      },
    ];
    const out = sidebarSections(sections);
    expect(out.map((s) => s.name)).toEqual(["specs", "decisions"]);
    expect(out[1]?.items.map((i) => i.path)).toEqual([
      "decisions/a.md",
      "decisions/z.md",
    ]);
  });
});

describe("isDocPath", () => {
  const sections = ["specs", "decisions", "workflows", "reference"];

  test("paths in a docs section are docs", () => {
    expect(isDocPath("specs/feature.md", sections)).toBe(true);
    expect(isDocPath("reference/serve.md", sections)).toBe(true);
  });

  test("work items and root files are not", () => {
    expect(isDocPath("work/tasks/DKT-1-do.md", sections)).toBe(false);
    expect(isDocPath("index.md", sections)).toBe(false);
    expect(isDocPath("log.md", sections)).toBe(false);
  });
});
