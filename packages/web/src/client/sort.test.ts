import { describe, expect, test } from "bun:test";
import { modeLabel, nextMode, type SortMode, sortCards } from "./sort";

const card = (
  id: string,
  priority: string | null,
  timestamp: string | null,
) => ({
  id,
  priority,
  timestamp,
});

const CARDS = [
  card("a", "p2", "2026-07-10T00:00:00Z"),
  card("b", "p0", "2026-07-01T00:00:00Z"),
  card("c", "p1", "2026-07-15T00:00:00Z"),
  card("d", "p1", null),
];

const ids = (cards: { id: string }[]) => cards.map((c) => c.id);

describe("sortCards", () => {
  test("null mode preserves server order", () => {
    expect(ids(sortCards(CARDS, null))).toEqual(["a", "b", "c", "d"]);
  });

  test("priority asc puts p0 first; ties keep server order (stable)", () => {
    expect(ids(sortCards(CARDS, { key: "priority", dir: "asc" }))).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });

  test("recency desc puts newest close first, missing timestamp last", () => {
    expect(ids(sortCards(CARDS, { key: "recency", dir: "desc" }))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  test("id sort compares numerically, not lexically", () => {
    const numbered = [
      card("DKT-9", null, null),
      card("DKT-10", null, null),
      card("DKT-2", null, null),
    ];
    expect(ids(sortCards(numbered, { key: "id", dir: "asc" }))).toEqual([
      "DKT-2",
      "DKT-9",
      "DKT-10",
    ]);
    expect(ids(sortCards(numbered, { key: "id", dir: "desc" }))).toEqual([
      "DKT-10",
      "DKT-9",
      "DKT-2",
    ]);
  });

  test("input array is not mutated", () => {
    const before = [...CARDS];
    sortCards(CARDS, { key: "priority", dir: "desc" });
    expect(CARDS).toEqual(before);
  });
});

describe("nextMode cycle", () => {
  test("cycles through default, priorities, recencies, ids, back to default", () => {
    const seen: SortMode[] = [];
    let mode: SortMode = null;
    do {
      seen.push(mode);
      mode = nextMode(mode);
    } while (mode !== null && seen.length < 10);
    expect(seen).toHaveLength(7);
    expect(seen.filter((m) => m?.key === "priority")).toHaveLength(2);
    expect(seen.filter((m) => m?.key === "recency")).toHaveLength(2);
    expect(seen.filter((m) => m?.key === "id")).toHaveLength(2);
    expect(new Set(seen.map(modeLabel)).size).toBe(7); // labels distinct
  });
});
