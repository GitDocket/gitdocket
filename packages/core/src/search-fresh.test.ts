import { expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { searchBundle } from "./search";
import { searchFresh } from "./search-fresh";
import { observeWork } from "./work-metrics";

const config = parseConfig();
const task = (id: number, body: string, title = "Navigation") =>
  `---\ntype: Task\nid: DKT-${id}\naliases: [OLD-${id}]\nstatus: todo\ntitle: ${title}\n---\n\n${body}\n`;

test("one-shot search preserves full ranking and canonical Markdown neighborhoods", async () => {
  const files = new Map([
    [
      "work/target.md",
      task(
        1,
        "[other](../other.md#section) [again](../other.md) [self](target.md) [external](https://example.com/other.md)",
      ),
    ],
    ["other.md", task(2, "[target](/work/target.md#part)")],
    ["relative.md", task(3, "[target](work/./unused/../target.md)")],
    ["escaped.md", task(4, "[target](work/target\\.md)")],
    ["entity.md", task(5, "[target](work/t&#97;rget.md)")],
    ["named-entity.md", task(15, "[target](work/target&period;md)")],
    ["hex-entity.md", task(16, "[target](work/t&#x61;rget.md)")],
    [
      "multiline.md",
      task(17, "[broken](work/tar\nget.md) [broken](<work/tar\nget.md>)"),
    ],
    [
      "duplicate/target.md",
      task(18, "Unrelated duplicate basename", "Duplicate"),
    ],
    ["space name.md", task(19, "Space", "Space")],
    ["space-link.md", task(20, "[space](<space name.md>)")],
    ["percent.md", task(6, "[literal](work/t%61rget.md)")],
    ["reference.md", task(7, "[reference][one]\n\n[one]: /work/target.md")],
    [
      "code.md",
      task(
        8,
        "```md\n[fake](/work/target.md)\n```\n\n`[fake](/work/target.md)`",
      ),
    ],
    ["unicode/é.md", task(9, "[target](/work/target.md)", "Unicode")],
    ["unicode.md", task(10, "[other](/unicode/é.md)")],
    ["tab.md", task(11, "[target](</work/target.md>)\n\tindented")],
    ["crlf.md", task(12, "[target](work/target.md)").replaceAll("\n", "\r\n")],
    ["bad.md", "---\ntype: [broken\n---\n[link](work/target.md)\n"],
    ["log.md", "Historical navigation OLD-1 and DKT-1\n"],
  ]);
  const store = new InMemoryFileStore(files);
  const full = await loadBundle(store, config);
  for (const query of [
    "navigation",
    "dkt1",
    "DKT 1",
    "#1",
    "OLD-1",
    "unicode",
    "space",
    "duplicate",
    "historical",
    "not-found",
    "",
  ]) {
    for (const limit of [1, 5, 50]) {
      expect(await searchFresh(store, config, query, { limit })).toEqual(
        await searchBundle(store, full, query, { limit }),
      );
    }
  }
});

test("unrelated bodies are skipped while every source is captured once", async () => {
  const files = new Map(
    Array.from({ length: 100 }, (_, i) => [
      `task-${i}.md`,
      task(
        i + 1,
        "Ordinary prose. [root](root.md)",
        i === 0 ? "Needle" : "Other",
      ),
    ]),
  );
  files.set("root.md", "---\ntype: Note\ntitle: Root\n---\n");
  const store = new InMemoryFileStore(files);
  const full = await loadBundle(store, config);
  const expected = await searchBundle(store, full, "needle");
  const reads = new Map<string, number>();
  const originalRead = store.read.bind(store);
  store.read = async (path) => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    return originalRead(path);
  };
  let parses = 0;
  const stop = observeWork((metric, count) => {
    if (metric === "parse") parses += count;
  });
  try {
    expect(await searchFresh(store, config, "needle")).toEqual(expected);
  } finally {
    stop();
  }
  expect(parses).toBe(files.size + 1);
  expect(reads.size).toBe(files.size);
  expect([...reads.values()].every((count) => count === 1)).toBe(true);
  // A highly linked result still returns every backlink, despite its hit limit.
  expect(await searchFresh(store, config, "root", { limit: 1 })).toEqual(
    await searchBundle(store, full, "root", { limit: 1 }),
  );
});
