import { describe, expect, test } from "bun:test";
import { createRequestGate } from "./live";

describe("live request gate", () => {
  test("only the newest request can publish a response", () => {
    const gate = createRequestGate();
    const older = gate.begin();
    const newer = gate.begin();

    expect(older()).toBe(false);
    expect(newer()).toBe(true);
  });

  test("unmount cancellation makes the outstanding response stale", () => {
    const gate = createRequestGate();
    const outstanding = gate.begin();
    gate.cancel();

    expect(outstanding()).toBe(false);
  });
});
