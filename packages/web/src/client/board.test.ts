import { describe, expect, test } from "bun:test";
import {
  boardStateQuery,
  DEFAULT_BOARD,
  filterCards,
  groupByEpic,
  parseBoardState,
} from "./board";

const epic = (id: string) => ({ path: `work/epics/${id}-e.md`, id, title: id });

const CARDS = [
  { id: "DKT-1", epic: epic("DKT-9"), tags: ["web"], assignee: "agent" },
  { id: "DKT-2", epic: epic("DKT-10"), tags: ["web", "ux"], assignee: null },
  { id: "DKT-3", epic: null, tags: [], assignee: "sam" },
  { id: "DKT-4", epic: epic("DKT-9"), tags: ["cli"], assignee: null },
];

const ids = (cards: { id: string }[]) => cards.map((c) => c.id);

describe("state ⇄ query", () => {
  test("defaults parse from an empty query and serialize back to one", () => {
    expect(parseBoardState("")).toEqual(DEFAULT_BOARD);
    expect(boardStateQuery(DEFAULT_BOARD)).toBe("");
  });

  test("round-trips filters and grouping", () => {
    const state = { epic: "DKT-9", tag: "web", assignee: "agent", group: true };
    expect(parseBoardState(boardStateQuery(state))).toEqual(state);
  });

  test("unknown group values fall back to flat", () => {
    expect(parseBoardState("group=banana").group).toBe(false);
  });
});

describe("filterCards", () => {
  test("epic filter matches by id, tag by membership, assignee exactly", () => {
    expect(
      ids(filterCards(CARDS, { ...DEFAULT_BOARD, epic: "DKT-9" })),
    ).toEqual(["DKT-1", "DKT-4"]);
    expect(ids(filterCards(CARDS, { ...DEFAULT_BOARD, tag: "web" }))).toEqual([
      "DKT-1",
      "DKT-2",
    ]);
    expect(
      ids(filterCards(CARDS, { ...DEFAULT_BOARD, assignee: "sam" })),
    ).toEqual(["DKT-3"]);
  });

  test("filters AND together", () => {
    expect(
      ids(filterCards(CARDS, { ...DEFAULT_BOARD, epic: "DKT-9", tag: "web" })),
    ).toEqual(["DKT-1"]);
  });

  test("grouping alone filters nothing", () => {
    expect(filterCards(CARDS, { ...DEFAULT_BOARD, group: true })).toHaveLength(
      CARDS.length,
    );
  });
});

describe("groupByEpic", () => {
  test("newest epic lane first, no-epic lane last", () => {
    const lanes = groupByEpic(CARDS);
    expect(lanes.map((l) => l.epic?.id ?? null)).toEqual([
      "DKT-10",
      "DKT-9",
      null,
    ]);
    expect(ids(lanes[0]?.cards ?? [])).toEqual(["DKT-2"]);
    expect(ids(lanes[1]?.cards ?? [])).toEqual(["DKT-1", "DKT-4"]);
    expect(ids(lanes[2]?.cards ?? [])).toEqual(["DKT-3"]);
  });

  test("no cards means no lanes", () => {
    expect(groupByEpic([])).toEqual([]);
  });
});
