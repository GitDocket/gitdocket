// The epics page's pure half: URL query ⇄ list state ⇄ rollup rows.

import { describe, expect, test } from "bun:test";
import {
  applyEpicList,
  DEFAULT_EPICS,
  type EpicListState,
  type EpicRow,
  epicListEmptyMessage,
  epicListQuery,
  parseEpicListState,
} from "./epiclist";

const row = (over: Partial<EpicRow> & { id: string }): EpicRow => ({
  path: `work/epics/${over.id}-e.md`,
  title: null,
  status: "in-progress",
  priority: "p2",
  tags: [],
  total: 4,
  done: 1,
  closed: 0,
  needsCleanup: false,
  lastActivity: "",
  ...over,
});

const ROWS: EpicRow[] = [
  row({
    id: "DKT-1",
    title: "Engine",
    status: "done",
    priority: "p1",
    tags: ["core"],
    done: 4,
    lastActivity: "2026-07-21T00:00:00Z",
  }),
  row({
    id: "DKT-2",
    title: "UX",
    priority: "p0",
    tags: ["web", "ux"],
    done: 3,
    lastActivity: "2026-07-10T00:00:00Z",
  }),
  row({
    id: "DKT-9",
    title: "Docs",
    status: "todo",
    tags: ["docs"],
    total: 0,
    done: 0,
    lastActivity: "2026-07-15T00:00:00Z",
  }),
  row({
    id: "DKT-11",
    title: "Search",
    tags: ["web"],
    done: 2,
    lastActivity: "2026-07-18T00:00:00Z",
  }),
];

describe("state ⇄ query", () => {
  test("default state serializes to the empty string", () => {
    expect(epicListQuery(DEFAULT_EPICS)).toBe("");
    expect(parseEpicListState("")).toEqual(DEFAULT_EPICS);
  });

  test("every field round-trips through the query string", () => {
    const state: EpicListState = {
      status: "in-progress",
      tag: "web",
      done: true,
      cleanup: true,
      sort: "progress",
    };
    expect(parseEpicListState(epicListQuery(state))).toEqual(state);
  });

  test("sort only appears in the query when non-default", () => {
    expect(epicListQuery({ ...DEFAULT_EPICS, tag: "web" })).toBe("tag=web");
    expect(epicListQuery({ ...DEFAULT_EPICS, sort: "priority" })).toBe(
      "sort=priority",
    );
  });

  test("junk sort keys fall back to the default", () => {
    expect(parseEpicListState("sort=bogus")).toEqual(DEFAULT_EPICS);
  });

  test("status is an accepted sort key", () => {
    expect(parseEpicListState("sort=status")).toEqual({
      ...DEFAULT_EPICS,
      sort: "status",
    });
    expect(epicListQuery({ ...DEFAULT_EPICS, sort: "status" })).toBe(
      "sort=status",
    );
  });

  test("cleanup-only empty state explains the result", () => {
    expect(epicListEmptyMessage({ ...DEFAULT_EPICS, cleanup: true })).toBe(
      "No epics need cleanup.",
    );
    expect(
      epicListEmptyMessage({
        ...DEFAULT_EPICS,
        cleanup: true,
        tag: "web",
      }),
    ).toBe("No cleanup-needed epics match these filters.");
  });
});

describe("filtering", () => {
  const ids = (state: Partial<EpicListState>) =>
    applyEpicList(ROWS, { ...DEFAULT_EPICS, ...state }).map((e) => e.id);

  test("done epics are hidden by default, shown on request", () => {
    expect(ids({})).toEqual(["DKT-11", "DKT-9", "DKT-2"]);
    expect(ids({ done: true })).toEqual(["DKT-1", "DKT-11", "DKT-9", "DKT-2"]);
  });

  test("closed epics are inactive history, distinct from done", () => {
    const closed = row({
      id: "DKT-12",
      status: "closed",
      closed: 2,
      done: 1,
    });
    expect(applyEpicList([...ROWS, closed], DEFAULT_EPICS)).not.toContainEqual(
      closed,
    );
    expect(
      applyEpicList([...ROWS, closed], {
        ...DEFAULT_EPICS,
        status: "closed",
      }).map((item) => item.id),
    ).toEqual(["DKT-12"]);
    expect(
      applyEpicList([...ROWS, closed], { ...DEFAULT_EPICS, done: true }).map(
        (item) => item.id,
      ),
    ).toContain("DKT-12");
  });

  test("an explicit status filter overrides the hide-done default", () => {
    expect(ids({ status: "done" })).toEqual(["DKT-1"]);
    expect(ids({ status: "in-progress" })).toEqual(["DKT-11", "DKT-2"]);
  });

  test("facets filter alone and AND together", () => {
    expect(ids({ tag: "web" })).toEqual(["DKT-11", "DKT-2"]);
    expect(ids({ tag: "core", done: true })).toEqual(["DKT-1"]);
    expect(ids({ status: "in-progress", tag: "ux" })).toEqual(["DKT-2"]);
    expect(ids({ tag: "nope" })).toEqual([]);
  });

  test("cleanup filter isolates flagged rows and ANDs with other facets", () => {
    const flagged = ROWS.map((epic) => ({
      ...epic,
      needsCleanup: epic.id === "DKT-11",
    }));
    const filteredIds = (state: Partial<EpicListState>) =>
      applyEpicList(flagged, { ...DEFAULT_EPICS, ...state }).map((e) => e.id);

    expect(filteredIds({ cleanup: true })).toEqual(["DKT-11"]);
    expect(filteredIds({ cleanup: true, status: "in-progress" })).toEqual([
      "DKT-11",
    ]);
    expect(filteredIds({ cleanup: true, tag: "ux" })).toEqual([]);
    expect(filteredIds({ cleanup: true, done: true })).toEqual(["DKT-11"]);
  });
});

describe("sorting", () => {
  const ids = (state: Partial<EpicListState>) =>
    applyEpicList(ROWS, { ...DEFAULT_EPICS, ...state, done: true }).map(
      (e) => e.id,
    );

  test("activity puts the freshest epic first", () => {
    expect(ids({})).toEqual(["DKT-1", "DKT-11", "DKT-9", "DKT-2"]);
  });

  test("progress puts the closest-to-done first; empty epics count as zero", () => {
    expect(ids({ sort: "progress" })).toEqual([
      "DKT-1", // 4/4
      "DKT-2", // 3/4
      "DKT-11", // 2/4
      "DKT-9", // 0 tasks
    ]);
  });

  test("priority puts p0 first with newest-id tiebreak", () => {
    expect(ids({ sort: "priority" })).toEqual([
      "DKT-2", // p0
      "DKT-1", // p1
      "DKT-11", // p2, newer id wins the tie
      "DKT-9",
    ]);
  });

  test("status puts active work first, done last, newest-id tiebreak", () => {
    expect(ids({ sort: "status" })).toEqual([
      "DKT-11", // in-progress, newer id wins the tie
      "DKT-2", // in-progress
      "DKT-9", // todo
      "DKT-1", // done
    ]);
  });
});
