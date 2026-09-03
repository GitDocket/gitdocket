import { describe, expect, test } from "bun:test";
import { ENGINE_SEMANTICS } from "./engine-semantics";
import { byManualOrder, canTransition, isReady } from "./states";

describe("canonical engine semantics", () => {
  test("readiness claim matches derived behavior, including unknown dependencies", () => {
    const statuses = new Map([
      ["DKT-1", "done"],
      ["DKT-2", "in-progress"],
      ["DKT-3", "closed"],
    ] as const);
    expect(isReady("todo", ["DKT-1"], statuses)).toBe(true);
    expect(isReady("todo", ["DKT-2"], statuses)).toBe(false);
    expect(isReady("todo", ["DKT-99"], statuses)).toBe(false);
    expect(isReady("todo", ["DKT-3"], statuses)).toBe(false);
    expect(isReady("in-progress", [], statuses)).toBe(false);
    expect(ENGINE_SEMANTICS.readiness).toContain("unknown dependency blocks");
  });

  test("ordering claim matches rank, priority, and numeric ID fallback behavior", () => {
    const items = [
      { id: "DKT-11", rank: 20, priority: "p1" as const },
      { id: "DKT-2", rank: 20, priority: "p1" as const },
      { id: "DKT-4", rank: 20, priority: "p0" as const },
      { id: "DKT-3", rank: 10, priority: "p3" as const },
      { id: "DKT-5", priority: "p0" as const },
    ];
    expect(items.sort(byManualOrder).map((item) => item.id)).toEqual([
      "DKT-3",
      "DKT-4",
      "DKT-2",
      "DKT-11",
      "DKT-5",
    ]);
    expect(ENGINE_SEMANTICS.readyOrdering).toContain(
      "ascending task ID as the stable fallback",
    );
  });

  test("transition claim matches guarded transitions and both terminal states", () => {
    expect(canTransition("todo", "in-progress")).toBe(true);
    expect(canTransition("blocked", "done")).toBe(false);
    expect(canTransition("blocked", "closed")).toBe(true);
    expect(canTransition("done", "todo")).toBe(false);
    expect(canTransition("closed", "todo")).toBe(false);
    expect(ENGINE_SEMANTICS.transitions).toContain("invalid transitions");
    expect(ENGINE_SEMANTICS.transitions).toContain(
      "`done` and `closed` are terminal",
    );
    expect(ENGINE_SEMANTICS.transitions).toContain(
      "Only `done` satisfies dependencies",
    );
  });
});
