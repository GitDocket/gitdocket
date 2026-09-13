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
    expect(html).toContain('href="#/work/1">review epic</a>');
    expect(html).not.toContain('aria-label="reconcile DKT-2 status"');
    expect(html.match(/needs cleanup/g)).toHaveLength(1);
  });
});

test("empty and mixed terminal epics keep completion claims precise", () => {
  const html = renderToStaticMarkup(
    <EpicList
      epics={[
        { ...row("DKT-3", false), total: 0, done: 0 },
        { ...row("DKT-4", false), total: 3, done: 1, closed: 2 },
      ]}
      states={["todo", "done", "closed"]}
    />,
  );
  expect(html).toContain("No child tasks yet");
  expect(html).toContain("1 of 3 done");
  expect(html).toContain(", 2 closed");
  expect(html).not.toContain("reconcile DKT-4 status");
});
