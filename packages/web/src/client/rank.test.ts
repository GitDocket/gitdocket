import { describe, expect, test } from "bun:test";
import { dropRank } from "./rank";

// A lane in displayed manual order: ranked prefix, unranked tail.
const lane = [
  { id: "DKT-1", rank: 10 },
  { id: "DKT-2", rank: 20 },
  { id: "DKT-3", rank: 30 },
  { id: "DKT-4", rank: null },
  { id: "DKT-5", rank: null },
];

describe("dropRank", () => {
  test("between two ranked neighbors takes the midpoint", () => {
    expect(dropRank(lane, "DKT-3", "DKT-2")).toBe(15);
  });

  test("moving down: the dragged card is not its own neighbor", () => {
    // DKT-1 before DKT-3 → between DKT-2 (20) and DKT-3 (30), not 10-vs-30.
    expect(dropRank(lane, "DKT-1", "DKT-3")).toBe(25);
  });

  test("top and end of the ranked prefix step outward", () => {
    expect(dropRank(lane, "DKT-3", "DKT-1")).toBe(0); // 10 - step
    expect(dropRank(lane, "DKT-1", "DKT-4")).toBe(40); // after last ranked (30)
  });

  test("a drop into the unranked tail appends to the ranked section", () => {
    expect(dropRank(lane, "DKT-1", "DKT-5")).toBe(40); // max rank 30 + step
    expect(dropRank(lane, "DKT-4", null)).toBe(40); // end of lane
  });

  test("an all-unranked or empty lane starts the sequence", () => {
    expect(
      dropRank(
        [
          { id: "a", rank: null },
          { id: "b", rank: null },
        ],
        "a",
        null,
      ),
    ).toBe(10);
    expect(dropRank([{ id: "a", rank: null }], "a", null)).toBe(10);
  });

  test("no-ops return null: self-drop, unknown target, unchanged rank", () => {
    expect(dropRank(lane, "DKT-2", "DKT-2")).toBeNull();
    expect(dropRank(lane, "DKT-2", "DKT-99")).toBeNull();
    // Dropping DKT-2 right before DKT-3 recomputes its own slot: (10+30)/2 = 20.
    expect(dropRank(lane, "DKT-2", "DKT-3")).toBeNull();
  });
});
