// Run explicitly: bun tests/export.acceptance.ts. The pre-feature baseline must fail.
import assert from "node:assert/strict";
import * as application from "../app/bookmarks.js";
import { bookmarkFixtures } from "../app/fixtures.js";

const cases = [
  {
    name: "all records preserve schemaVersion, title, URL, tags and Unicode",
    bookmarks: bookmarkFixtures,
  },
  { name: "empty collection remains an empty array", bookmarks: [] },
];
const results = [];
for (const entry of cases) {
  try {
    const serialize = (application as Record<string, unknown>)
      .serializeBookmarks;
    assert.equal(
      typeof serialize,
      "function",
      "app/bookmarks.js must export serializeBookmarks(bookmarks)",
    );
    const input = structuredClone(entry.bookmarks);
    const before = structuredClone(input);
    const output = (serialize as (bookmarks: unknown[]) => unknown)(input);
    assert.equal(
      typeof output,
      "string",
      "serializer returns the JSON download text",
    );
    assert.deepEqual(JSON.parse(output as string), {
      schemaVersion: 1,
      bookmarks: entry.bookmarks,
    });
    assert.deepEqual(input, before, "export must not mutate the saved records");
    results.push({ case: entry.name, status: "pass" });
  } catch (error) {
    results.push({
      case: entry.name,
      status: "fail",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
console.log(
  JSON.stringify({ check: "beacon-export-contract", results }, null, 2),
);
if (results.some((result) => result.status === "fail")) process.exitCode = 1;
