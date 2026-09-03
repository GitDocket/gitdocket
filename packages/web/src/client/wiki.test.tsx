import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHashValue, WikiLanding } from "./App";

describe("Wiki routes", () => {
  test("keeps Home, Wiki, Docs, work views, and concepts distinct", () => {
    expect(parseHashValue("#/")).toEqual({ view: "home" });
    expect(parseHashValue("#/wiki")).toEqual({ view: "wiki" });
    expect(parseHashValue("#/docs")).toEqual({ view: "docs", dir: "" });
    expect(parseHashValue("#/docs/specs")).toEqual({
      view: "docs",
      dir: "specs",
    });
    expect(parseHashValue("#/tasks?status=todo")).toEqual({
      view: "tasks",
      query: "status=todo",
    });
    expect(parseHashValue("#/c/work/tasks/DKT-1.md")).toEqual({
      view: "concept",
      path: "work/tasks/DKT-1.md",
    });
  });
});

describe("WikiLanding", () => {
  test("previews knowledge without reproducing complete work inventories", () => {
    const html = renderToStaticMarkup(
      <WikiLanding
        sections={[
          {
            name: "specs",
            items: [
              { path: "specs/a.md", title: "Alpha", description: "A" },
              { path: "specs/b.md", title: "Beta", description: "B" },
              { path: "specs/c.md", title: "Gamma", description: "C" },
              { path: "specs/d.md", title: "Delta", description: "D" },
            ],
          },
          {
            name: "decisions",
            items: [
              {
                path: "decisions/DEC-1.md",
                title: "One choice",
                description: null,
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("Browse the project&#x27;s linked knowledge");
    expect(html).toContain('href="#/docs/specs"');
    expect(html).toContain('href="#/c/specs/a.md"');
    expect(html).toContain('href="#/c/specs/c.md"');
    expect(html).not.toContain('href="#/c/specs/d.md"');
    expect(html).toContain("Browse all 4");
    expect(html).toContain('href="#/tasks"');
    expect(html).toContain('href="#/board"');
    expect(html).toContain('href="#/epics"');
    expect(html).toContain('href="#/activity"');
    expect(html).not.toContain("DKT-1 —");
  });

  test("has a truthful empty knowledge state while retaining work entry points", () => {
    const html = renderToStaticMarkup(<WikiLanding sections={[]} />);
    expect(html).toContain("No knowledge sections are available yet.");
    expect(html).toContain('href="#/tasks"');
  });
});
