import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EpicList } from "./App";
import type { EpicRow } from "./epiclist";

const row = (id: string, needsCleanup: boolean): EpicRow => ({
  path: `work/epics/${id}.md`,
  id,
  title: `${id} epic`,
  status: "in-progress",
  priority: "p2",
  tags: [],
  total: 2,
  done: needsCleanup ? 2 : 1,
  closed: 0,
  needsCleanup,
  lastActivity: "",
});

describe("EpicList", () => {
  test("shows the true status, warning, and direct reconciliation controls only when needed", () => {
    const html = renderToStaticMarkup(
      <EpicList
        epics={[row("DKT-1", true), row("DKT-2", false)]}
        states={["todo", "in-progress", "blocked", "done", "closed"]}
      />,
    );

    expect(html).toContain("needs cleanup");
    expect(html).toContain(">in-progress</span>");
    expect(html).toContain('aria-label="reconcile DKT-1 status"');
    expect(html).toContain('href="#/c/work/epics/DKT-1.md">review epic</a>');
    expect(html).not.toContain('aria-label="reconcile DKT-2 status"');
    expect(html.match(/needs cleanup/g)).toHaveLength(1);
  });
});
