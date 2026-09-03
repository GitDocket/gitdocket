import { describe, expect, test } from "bun:test";
import { isReady, isStatus } from "./index";

describe("isStatus", () => {
  test("accepts profile states and rejects others", () => {
    expect(isStatus("in-progress")).toBe(true);
    expect(isStatus("closed")).toBe(true);
    expect(isStatus("ready")).toBe(false); // ready is derived, never a stored status
  });
});

describe("isReady", () => {
  const statuses = new Map([
    ["DKT-3", "done"],
    ["DKT-8", "in-progress"],
    ["DKT-9", "closed"],
  ] as const);

  test("todo with all deps done is ready", () => {
    expect(isReady("todo", ["DKT-3"], statuses)).toBe(true);
  });

  test("todo with no deps is ready", () => {
    expect(isReady("todo", [], statuses)).toBe(true);
  });

  test("unfinished or unknown deps block readiness", () => {
    expect(isReady("todo", ["DKT-8"], statuses)).toBe(false);
    expect(isReady("todo", ["DKT-99"], statuses)).toBe(false);
    expect(isReady("todo", ["DKT-9"], statuses)).toBe(false);
  });

  test("non-todo statuses are never ready", () => {
    expect(isReady("in-progress", [], statuses)).toBe(false);
    expect(isReady("done", [], statuses)).toBe(false);
    expect(isReady("closed", [], statuses)).toBe(false);
  });
});
