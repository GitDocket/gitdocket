import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../render";
import { conceptHref, hashQuery, workHref } from "../urls";
import { parseHashValue } from "./App";

describe("work-item browser URLs", () => {
  test("tasks and epics use identity regardless of title or filename", () => {
    for (const type of ["Task", "Epic"]) {
      expect(
        conceptHref({ path: "renamed/anything.md", id: "APP-168", type }),
      ).toBe("#/work/168");
    }
    expect(
      conceptHref({
        path: "decisions/DEC-168-choice.md",
        id: "DEC-168",
        type: "Decision",
      }),
    ).toBe("#/c/decisions/DEC-168-choice.md");
    expect(workHref({ id: "DKT-1" })).toBe("#/work/1");
  });

  test("direct loads and history parse the same identity, section and page", () => {
    for (const number of ["1", "2"]) {
      const hash = `#/work/${number}?page=2#acceptance-criteria`;
      expect(parseHashValue(hash)).toEqual({
        view: "concept",
        path: `work/${number}`,
        ticket: number,
        anchor: "acceptance-criteria",
      });
      expect(hashQuery(hash)).toBe("page=2");
      expect(parseHashValue(`#/work/${number}`)).toEqual({
        view: "concept",
        path: `work/${number}`,
        ticket: number,
      });
    }
    expect(
      parseHashValue("#/c/reference/serve.md#local-computer-trust-boundary"),
    ).toEqual({
      view: "concept",
      path: "reference/serve.md",
      anchor: "local-computer-trust-boundary",
    });
  });

  test("malformed and missing numbers stay on a work route for explicit not-found handling", () => {
    for (const value of [
      "",
      "0",
      "01",
      "1x",
      "999",
      "%",
      "%E0%A4%A",
      "1/extra",
    ]) {
      const route = parseHashValue(`#/work/${value}`);
      expect(route.view).toBe("concept");
      expect("ticket" in route).toBe(true);
    }
  });

  test("section targets have stable, unique IDs, including formatted headings", () => {
    const html = renderMarkdown(
      "work/tasks/DKT-1-example.md",
      "# Acceptance **Criteria**\n\n## Outcome\n\n## Outcome\n\n## Outcome-1\n\n## Résumé\n",
    );
    for (const id of [
      "acceptance-criteria",
      "outcome",
      "outcome-1",
      "outcome-1-1",
      "résumé",
    ])
      expect(html).toContain(`id="${id}"`);
  });
});
