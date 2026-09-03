// The all-tasks view's pure half: URL query ⇄ list state ⇄ row set.

import { describe, expect, test } from "bun:test";
import {
  applyList,
  DEFAULT_STATE,
  type ListState,
  listStateQuery,
  parseListState,
  type TaskRow,
} from "./tasklist";

const STATES = [
  "todo",
  "in-progress",
  "blocked",
  "in-review",
  "done",
  "closed",
];

const row = (over: Partial<TaskRow> & { id: string }): TaskRow => ({
  path: `work/tasks/${over.id}-x.md`,
  type: "Task",
  title: null,
  status: "todo",
  priority: "p2",
  tags: [],
  ready: false,
  epic: null,
  ...over,
});

const ROWS: TaskRow[] = [
  row({
    id: "DKT-1",
    title: "Ship the parser",
    status: "done",
    priority: "p1",
    tags: ["core"],
    epic: { path: "work/epics/DKT-9-e.md", id: "DKT-9", title: "Engine" },
  }),
  row({
    id: "DKT-2",
    title: "Board polish",
    status: "in-progress",
    tags: ["web", "ux"],
    epic: { path: "work/epics/DKT-10-e.md", id: "DKT-10", title: "UX" },
  }),
  row({ id: "DKT-9", type: "Epic", title: "Engine", status: "in-progress" }),
  row({
    id: "DKT-11",
    title: "Search box",
    priority: "p0",
    tags: ["web"],
    epic: { path: "work/epics/DKT-10-e.md", id: "DKT-10", title: "UX" },
  }),
];

describe("state ⇄ query", () => {
  test("default state serializes to the empty string", () => {
    expect(listStateQuery(DEFAULT_STATE)).toBe("");
    expect(parseListState("")).toEqual(DEFAULT_STATE);
  });

  test("every field round-trips through the query string", () => {
    const state: ListState = {
      type: "Epic",
      status: "in-progress",
      epic: "DKT-10",
      priority: "p1",
      tag: "web",
      q: "board & search",
      sort: "priority",
      dir: "asc",
    };
    expect(parseListState(listStateQuery(state))).toEqual(state);
  });

  test("sort/dir only appear in the query when non-default", () => {
    expect(listStateQuery({ ...DEFAULT_STATE, status: "todo" })).toBe(
      "status=todo",
    );
    expect(listStateQuery({ ...DEFAULT_STATE, dir: "asc" })).toContain("sort=");
  });

  test("junk sort keys and directions fall back to the default", () => {
    expect(parseListState("sort=bogus&dir=sideways")).toEqual(DEFAULT_STATE);
  });
});

describe("filtering", () => {
  const ids = (state: Partial<ListState>) =>
    applyList(ROWS, STATES, { ...DEFAULT_STATE, ...state }).map((r) => r.id);

  test("no filters returns everything, newest id first", () => {
    expect(ids({})).toEqual(["DKT-11", "DKT-9", "DKT-2", "DKT-1"]);
  });

  test("facets filter alone and AND together", () => {
    expect(ids({ status: "in-progress" })).toEqual(["DKT-9", "DKT-2"]);
    expect(ids({ epic: "DKT-10" })).toEqual(["DKT-11", "DKT-2"]);
    expect(ids({ tag: "web" })).toEqual(["DKT-11", "DKT-2"]);
    expect(ids({ epic: "DKT-10", status: "in-progress" })).toEqual(["DKT-2"]);
    expect(ids({ epic: "DKT-10", priority: "p0" })).toEqual(["DKT-11"]);
  });

  test("type facet filters alone and ANDs with the rest", () => {
    expect(ids({ type: "Epic" })).toEqual(["DKT-9"]);
    expect(ids({ type: "Task" })).toEqual(["DKT-11", "DKT-2", "DKT-1"]);
    expect(ids({ type: "Task", status: "in-progress" })).toEqual(["DKT-2"]);
    expect(ids({ type: "Epic", tag: "web" })).toEqual([]);
  });

  test("free text matches id and title, case-insensitive", () => {
    expect(ids({ q: "PARSER" })).toEqual(["DKT-1"]);
    expect(ids({ q: "dkt-1" })).toEqual(["DKT-11", "DKT-1"]);
    expect(ids({ q: "nope" })).toEqual([]);
  });
});

describe("sorting", () => {
  const ids = (state: Partial<ListState>) =>
    applyList(ROWS, STATES, { ...DEFAULT_STATE, ...state }).map((r) => r.id);

  test("id sorts numerically, not lexically", () => {
    expect(ids({ sort: "id", dir: "asc" })).toEqual([
      "DKT-1",
      "DKT-2",
      "DKT-9",
      "DKT-11",
    ]);
  });

  test("priority ascending puts p0 first", () => {
    expect(ids({ sort: "priority", dir: "asc" })[0]).toBe("DKT-11");
  });

  test("status follows workflow order with newest-id tiebreak", () => {
    expect(ids({ sort: "status", dir: "asc" })).toEqual([
      "DKT-11", // todo
      "DKT-9", // in-progress, newer id wins the tie
      "DKT-2",
      "DKT-1", // done
    ]);
  });

  test("title sorts alphabetically both ways", () => {
    expect(ids({ sort: "title", dir: "asc" })[0]).toBe("DKT-2"); // Board polish
    expect(ids({ sort: "title", dir: "desc" })[0]).toBe("DKT-1"); // Ship the parser
  });
});
