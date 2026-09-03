import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EpicEditor } from "./App";
import type { EpicRow } from "./epiclist";

const epic = (id: string): EpicRow => ({
  path: `work/epics/${id}.md`,
  id,
  title: `${id} title`,
  status: "todo",
  priority: "p2",
  tags: [],
  done: 0,
  closed: 0,
  total: 1,
  lastActivity: "",
  needsCleanup: false,
});

const current = (row: EpicRow) => ({
  path: row.path,
  id: row.id,
  title: row.title,
  status: row.status,
});

describe("EpicEditor", () => {
  test("keeps the selected epic editable and directly navigable", () => {
    const selected = epic("DKT-2");
    const html = renderToStaticMarkup(
      <EpicEditor
        current={current(selected)}
        epics={[selected, epic("DKT-4")]}
        value={`/${selected.path}`}
        onChange={() => {}}
      />,
    );

    expect(html).toContain('aria-label="epic"');
    expect(html).toContain(
      '<option value="/work/epics/DKT-2.md" selected="">DKT-2 — DKT-2 title</option>',
    );
    expect(html).toContain('href="#/c/work/epics/DKT-2.md"');
    expect(html).toContain('aria-label="View epic DKT-2"');
  });

  test("updates the link with the current epic", () => {
    const selected = epic("DKT-4");
    const html = renderToStaticMarkup(
      <EpicEditor
        current={current(selected)}
        epics={[epic("DKT-2"), selected]}
        value={`/${selected.path}`}
        onChange={() => {}}
      />,
    );

    expect(html).toContain('href="#/c/work/epics/DKT-4.md"');
    expect(html).not.toContain('href="#/c/work/epics/DKT-2.md"');
  });

  test("shows the empty editor without a broken link", () => {
    const html = renderToStaticMarkup(
      <EpicEditor
        current={null}
        epics={[epic("DKT-2")]}
        value=""
        onChange={() => {}}
      />,
    );

    expect(html).toContain('<option value="" selected="">no epic</option>');
    expect(html).not.toContain("href=");
  });
});
