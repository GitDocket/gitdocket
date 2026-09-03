// The command palette's pure half: catalog, matching, merging.

import { describe, expect, test } from "bun:test";
import { itemHash, paletteItems, type SearchHit, viewCatalog } from "./palette";

const HITS: SearchHit[] = [
  {
    path: "work/tasks/DKT-1-x.md",
    line: 3,
    text: "boards…",
    id: "DKT-1",
    title: "Fix boards",
  },
  { path: "specs/feature.md", line: 1, text: "…", title: "The Feature" },
];

describe("view catalog", () => {
  test("fixed views lead, one entry per docs directory follows", () => {
    const labels = viewCatalog(["specs", "decisions"]).map((v) => v.label);
    expect(labels).toEqual([
      "Home",
      "Wiki",
      "Tasks",
      "Board",
      "Epics",
      "Activity",
      "Docs",
      "Docs: specs",
      "Docs: decisions",
    ]);
    expect(viewCatalog(["specs"]).at(-1)?.hash).toBe("#/docs/specs");
  });
});

describe("merging", () => {
  const views = viewCatalog(["specs"]);

  test("empty query is browse mode: the whole catalog, no hits", () => {
    expect(paletteItems(views, HITS, "")).toEqual(views);
    expect(paletteItems(views, HITS, "  ")).toEqual(views);
  });

  test("matched views lead, ranked hits follow in engine order", () => {
    const items = paletteItems(views, HITS, "board");
    expect(items.map((i) => (i.kind === "view" ? i.label : i.path))).toEqual([
      "Board",
      "work/tasks/DKT-1-x.md",
      "specs/feature.md",
    ]);
  });

  test("view matching is case-insensitive substring", () => {
    expect(paletteItems(views, [], "SPEC")).toHaveLength(1);
    expect(paletteItems(views, [], "xyz")).toHaveLength(0);
  });

  test("hashes: views navigate as-is, concepts via the wiki route", () => {
    const items = paletteItems(views, HITS, "board");
    expect(itemHash(items[0] ?? { kind: "view", label: "", hash: "" })).toBe(
      "#/board",
    );
    expect(items[1] && itemHash(items[1])).toBe("#/c/work/tasks/DKT-1-x.md");
  });
});
