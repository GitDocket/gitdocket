import assert from "node:assert/strict";
import {
  readBookmarks,
  STORAGE_KEY,
  writeBookmarks,
} from "../app/bookmarks.js";
import { bookmarkFixtures } from "../app/fixtures.js";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
};
const initial = readBookmarks(storage);
assert.deepEqual(initial, bookmarkFixtures);
initial[0].title = "Changed locally";
assert.notEqual(initial[0].title, bookmarkFixtures[0].title);
writeBookmarks(storage, initial);
assert.deepEqual(readBookmarks(storage), initial);
assert.ok(values.has(STORAGE_KEY));
writeBookmarks(storage, []);
assert.deepEqual(readBookmarks(storage), []);
console.log("PASS baseline: fixture copy, saved records, empty collection");
