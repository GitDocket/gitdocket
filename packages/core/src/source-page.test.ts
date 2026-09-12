import { expect, test } from "bun:test";
import { BundleIndex } from "./bundle-index";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { type SourceCursor, sourcePage } from "./source-page";

test("bounded source pages reconstruct the exact log with valid line provenance", () => {
  const source =
    "# Log\n\n2026-09-11 DKT-142\n" +
    "A long entry ".repeat(5000) +
    "\nlast line\n";
  const sources = new Map([["log.md", source]]);
  let cursor: SourceCursor | undefined;
  let reconstructed = "";
  do {
    const page = sourcePage(sources, "log.md", { cursor, maxChars: 1000 });
    if (!page) throw new Error("missing page");
    expect(page.text.length).toBeLessThanOrEqual(1000);
    expect(page.startLine).toBe(
      source.slice(0, cursor?.offset ?? 0).split("\n").length,
    );
    reconstructed += page.text;
    cursor = page.nextCursor;
  } while (cursor);
  expect(reconstructed).toBe(source);
  const first = sourcePage(sources, "log.md", { maxChars: 30 });
  expect(first?.dates).toEqual(["2026-09-11"]);
  expect(first?.taskIds).toEqual(["DKT-142"]);
  expect(first?.startLine).toBe(1);
  expect(first?.endLine).toBe(3);
  for (const maxChars of [0, 0.5, NaN, Infinity])
    expect(() => sourcePage(sources, "log.md", { maxChars })).toThrow();
});

test("log rewrites, deletes and renames invalidate cursors without changing older readers", async () => {
  const store = new InMemoryFileStore(
    new Map([["log.md", "2026-09-11 DKT-1\nold body\n"]]),
  );
  const index = new BundleIndex(store);
  const original = await index.refresh(parseConfig());
  const first = sourcePage(original.sources, "log.md", { maxChars: 17 });
  expect(first?.nextCursor).toBeDefined();
  for (const text of [
    "2026-09-11 DKT-2\nnew body\n",
    "prepend\n2026-09-11 DKT-1\nold body\n",
    "2026-09-11 DKT-1\nold body\nappend",
  ]) {
    await store.write("log.md", text);
    const current = await index.refresh(parseConfig());
    expect(() =>
      sourcePage(current.sources, "log.md", { cursor: first?.nextCursor }),
    ).toThrow("source changed");
    expect(
      sourcePage(original.sources, "log.md", { cursor: first?.nextCursor })
        ?.text,
    ).toBe("old body\n");
  }
  store.files.set("archive.md", store.files.get("log.md") ?? "");
  store.files.delete("log.md");
  const renamed = await index.refresh(parseConfig());
  expect(sourcePage(renamed.sources, "log.md")).toBeUndefined();
  expect(sourcePage(renamed.sources, "archive.md")?.path).toBe("archive.md");
  const renamedCursor = sourcePage(renamed.sources, "archive.md", {
    maxChars: 5,
  })?.nextCursor;
  const copied = new Map(renamed.sources);
  copied.set("copy.md", copied.get("archive.md") ?? "");
  expect(() =>
    sourcePage(copied, "copy.md", { cursor: renamedCursor }),
  ).toThrow("source path changed");
  index.close();
});

test("page boundaries cannot fabricate IDs or split Unicode characters", () => {
  const sources = new Map([
    ["log.md", "DKT-123456789 text"],
    ["unicode.md", "😀X"],
  ]);
  const page = sourcePage(sources, "log.md", { maxChars: 6 });
  expect(page?.taskIds).toEqual([]);
  expect(
    sourcePage(sources, "log.md", {
      cursor: { path: "log.md", sourceHash: page?.sourceHash ?? "", offset: 2 },
    })?.taskIds,
  ).toEqual([]);
  expect(() => sourcePage(sources, "unicode.md", { maxChars: 1 })).toThrow(
    "Unicode",
  );
  const unicode = sourcePage(sources, "unicode.md", { maxChars: 2 });
  expect(unicode?.text).toBe("😀");
  expect(
    sourcePage(sources, "unicode.md", { cursor: unicode?.nextCursor })?.text,
  ).toBe("X");
  expect(() =>
    sourcePage(sources, "unicode.md", {
      cursor: {
        path: "unicode.md",
        sourceHash: unicode?.sourceHash ?? "",
        offset: 1,
      },
    }),
  ).toThrow("Unicode");
});
