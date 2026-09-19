import { expect, test } from "bun:test";
import { cliOperation, OPERATIONS, TELEMETRY_COVERAGE } from "./telemetry";
import { assertCoverageOperations } from "./telemetry-coverage";

test("coverage inventory names only allowlisted operations and unique surface ids", () => {
  assertCoverageOperations();
  const keys = TELEMETRY_COVERAGE.map(
    (entry) => `${entry.surface}:${entry.id}`,
  );
  expect(new Set(keys).size).toBe(keys.length);
  const named = new Set(
    TELEMETRY_COVERAGE.map((entry) => entry.operation).filter(Boolean),
  );
  expect([...OPERATIONS].every((operation) => named.has(operation))).toBe(true);
  for (const entry of TELEMETRY_COVERAGE) {
    if (entry.status === "supported") expect(entry.operation).toBeTruthy();
    if (entry.status === "excluded") expect(entry.operation).toBeNull();
  }
});

test("CLI lookup uses static command names and ignores telemetry controls", () => {
  expect(cliOperation(["ready", "--json"])).toBe("ready");
  expect(cliOperation(["task", "start", "DKT-1"])).toBe("task_start");
  expect(cliOperation(["extension", "list", "--json"])).toBe("extension_list");
  expect(cliOperation(["extension", "install", "/tmp/pkg"])).toBe(
    "extension_install",
  );
  expect(cliOperation(["telemetry", "enable"])).toBeUndefined();
  expect(cliOperation(["serve"])).toBeUndefined();
});
