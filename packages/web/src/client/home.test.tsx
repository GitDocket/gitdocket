import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeBriefing, type HomeData } from "./App";

type V2Narrative = Extract<
  NonNullable<HomeData["narrative"]>,
  { format: "re-entry/v2" }
>;

const narrative = (overrides: Partial<V2Narrative> = {}): V2Narrative => ({
  format: "re-entry/v2",
  asOf: "abcdef123",
  reviewedAt: "2026-08-20T00:00:00Z",
  body: "structured source",
  recent: "- Shipped the shared overview.",
  next: "- Run the re-entry probe.",
  worthKnowing: "- [One model](/decisions/DEC-1.md).",
  links: ["/decisions/DEC-1.md"],
  decisionLinks: ["/decisions/DEC-1.md"],
  taskCommitsAgo: 2,
  review: {
    status: "current",
    reasons: [],
    reviewedDaysAgo: 1,
    maxDays: 14,
  },
  html: "<p>structured source</p>",
  sectionHtml: {
    recent:
      '<ul><li>Shipped the <a href="#/c/work/tasks/DKT-93.md">shared overview</a>.</li></ul>',
    next: '<ul><li>Run the <a href="#/c/work/epics/DKT-92.md">re-entry probe</a>.</li></ul>',
    worthKnowing:
      '<ul><li><a href="#/c/decisions/DEC-1.md">One model</a>.</li></ul>',
  },
  ...overrides,
});

const data = (overrides: Partial<HomeData> = {}): HomeData => ({
  project: "DKT",
  preamble: "<h1>Docket</h1><p>Project orientation.</p>",
  narrative: narrative(),
  ...overrides,
});

describe("HomeBriefing", () => {
  test("renders one linked briefing after the durable project introduction", () => {
    const html = renderToStaticMarkup(<HomeBriefing data={data()} />);
    const positions = [
      html.indexOf("Project orientation."),
      html.indexOf("Project re-entry"),
      html.indexOf("What we&#x27;ve done recently"),
      html.indexOf("What&#x27;s up next"),
      html.indexOf("Worth knowing"),
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, z) => a - z));
    expect(html.match(/shared overview/g)?.length).toBe(1);
    expect(html).toContain('href="#/c/work/tasks/DKT-93.md"');
    expect(html).toContain('href="#/c/work/epics/DKT-92.md"');
    expect(html).toContain('href="#/c/decisions/DEC-1.md"');
    expect(html).toContain("reentry-section-next");
    expect(html).toContain("Current");
    expect(html).toContain("Reviewed Aug 20, 2026");
    expect(html).toContain("Audit details");
    expect(html).toContain("Evidence revision <code>abcdef1</code>");
    expect(html).toContain("2 task-linked commits after this revision");

    for (const duplicate of [
      "Execution summary",
      "Current work",
      "Loose ends",
      "Recently moved",
      "Explore",
      "Specs nothing verifies",
    ]) {
      expect(html).not.toContain(duplicate);
    }
  });

  test("omits empty optional context and keeps stale last-known context readable", () => {
    const note = narrative({
      worthKnowing: undefined,
      sectionHtml: {
        recent: "<ul><li>Shipped the shared overview.</li></ul>",
        next: "<ul><li>Run the re-entry probe.</li></ul>",
      },
      taskCommitsAgo: 8,
      review: {
        status: "needs-review",
        reasons: ["evidence-moved", "review-expired"],
        reviewedDaysAgo: 21,
        maxDays: 14,
      },
    });
    const html = renderToStaticMarkup(
      <HomeBriefing data={data({ narrative: note })} />,
    );
    expect(html).toContain("Context needs review");
    expect(html).toContain("Needs review");
    expect(html).toContain("Shipped the shared overview.");
    expect(html).toContain("8 task-linked commits after this revision");
    expect(html).not.toContain("Worth knowing");
  });

  test("keeps multiple authored next links and unavailable age truthful", () => {
    const note = narrative({
      taskCommitsAgo: null,
      review: {
        status: "age-unavailable",
        reasons: ["git-age-unavailable"],
        reviewedDaysAgo: 1,
        maxDays: 14,
      },
      sectionHtml: {
        recent: "<ul><li>Shipped the shared overview.</li></ul>",
        next: '<ul><li>Resume <a href="#/c/work/tasks/DKT-101.md">Home</a> and then review <a href="#/c/work/epics/DKT-76.md">the epic</a>.</li></ul>',
      },
    });
    const html = renderToStaticMarkup(
      <HomeBriefing data={data({ narrative: note })} />,
    );
    expect(html).toContain("Evidence age is unavailable");
    expect(html).toContain("Task-linked commit distance is unavailable");
    expect(html).toContain('href="#/c/work/tasks/DKT-101.md"');
    expect(html).toContain('href="#/c/work/epics/DKT-76.md"');
    expect(html).not.toContain("Open next");
  });

  test("uses a terse truthful state when context is missing or malformed", () => {
    const html = renderToStaticMarkup(
      <HomeBriefing data={data({ narrative: null })} />,
    );
    expect(html).toContain("Project orientation.");
    expect(html).toContain("No usable project re-entry note is available.");
    expect(html).not.toContain("No tasks yet");
    expect(html).not.toContain("Current work");
    expect(html).not.toContain("Explore the project");
  });

  test("keeps sparse authored identity and a completed frontier truthful", () => {
    const completed = narrative({
      next: "- No further work is planned.",
      sectionHtml: {
        recent: "<ul><li>Shipped the final milestone.</li></ul>",
        next: "<ul><li>No further work is planned.</li></ul>",
      },
    });
    const html = renderToStaticMarkup(
      <HomeBriefing
        data={data({
          project: "RS",
          preamble: "<h1>RS</h1>",
          narrative: completed,
        })}
      />,
    );
    expect(html).toContain("<h1>RS</h1>");
    expect(html).toContain("No further work is planned.");
    expect(html).not.toContain("Open next");
    expect(html).not.toContain("RS is a project");
    expect(html).not.toContain("Purpose unavailable");
  });
});
