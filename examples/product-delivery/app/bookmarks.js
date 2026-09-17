import { bookmarkFixtures } from "./fixtures.js";

export const STORAGE_KEY = "beacon.bookmarks.v1";

export function readBookmarks(storage) {
  const saved = storage.getItem(STORAGE_KEY);
  return saved === null ? structuredClone(bookmarkFixtures) : JSON.parse(saved);
}

export function writeBookmarks(storage, bookmarks) {
  storage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
}
