import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { searchBundle } from "./search";

const config = parseConfig();

const seed = () =>
  new InMemoryFileStore(
    new Map([
      [
        "work/tasks/DKT-1-a.md",
        "---\ntype: Task\ntitle: Checkout flow\nid: DKT-1\nstatus: todo\n---\n\n# Context\n\nIdempotency keys prevent double-charging.\n",
      ],
      [
        "work/tasks/DKT-2-b.md",
        "---\ntype: Task\ntitle: Retry queue\nid: DKT-2\nstatus: todo\n---\n\n# Context\n\nThe checkout worker retries idempotency conflicts per [Checkout flow](/work/tasks/DKT-1-a.md) and [ghost](/specs/missing.md).\n",
      ],
      [
        "index.md",
        "# Index\n\n- [Checkout flow](/work/tasks/DKT-1-a.md) — idempotency work\n",
      ],
    ]),
  );

const search = async (query: string, limit?: number) => {
  const store = seed();
  const bundle = await loadBundle(store, config);
  return searchBundle(store, bundle, query, limit ? { limit } : {});
};

describe("searchBundle", () => {
  test("matches case-insensitively and tags hits with the owning concept", async () => {
    const hits = await search("IDEMPOTENCY");
    expect(hits.map((h) => h.path).sort()).toEqual([
      "index.md",
      "work/tasks/DKT-1-a.md",
      "work/tasks/DKT-2-b.md",
    ]);

    const inTask = hits.find((h) => h.path === "work/tasks/DKT-1-a.md");
    expect(inTask?.id).toBe("DKT-1");
    expect(inTask?.title).toBe("Checkout flow");
    expect(inTask?.line).toBe(10); // snippet at the matching body line
    expect(inTask?.text).toBe("Idempotency keys prevent double-charging.");

    const inIndex = hits.find((h) => h.path === "index.md");
    expect(inIndex?.id).toBeUndefined(); // reserved file, not a concept
  });

  test("multi-term queries need neither adjacency nor order; more terms outrank fewer", async () => {
    // "prevent" and "keys" appear only in DKT-1, non-adjacent, queried reversed.
    const hits = await search("prevent keys");
    expect(hits[0]?.path).toBe("work/tasks/DKT-1-a.md");
    expect(hits[0]?.matched.sort()).toEqual(["keys", "prevent"]);
    // Terms may match across different lines of one file: "retries" (body)
    // + "queue" (title) both hit DKT-2 and rank it above single-term hits.
    const cross = await search("retries queue");
    expect(cross[0]?.path).toBe("work/tasks/DKT-2-b.md");
    expect(cross[0]?.matched).toHaveLength(2);
  });

  test("title/id matches outrank body matches", async () => {
    // "checkout" is DKT-1's title but only body text in DKT-2 and index.md.
    const hits = await search("checkout");
    expect(hits[0]?.path).toBe("work/tasks/DKT-1-a.md");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Infinity);
    // An id query finds its task first (tokenizes to ["dkt", "1"]).
    const byId = await search("DKT-1");
    expect(byId[0]?.id).toBe("DKT-1");
  });

  test("limit applies after scoring — the best hit survives a limit of 1", async () => {
    // Both files match "checkout"; the title hit must win even at limit 1,
    // proving the scan isn't cut off at the first N encountered.
    const hits = await search("checkout", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("work/tasks/DKT-1-a.md");
  });

  test("exact ticket lookups beat numeric prefixes, title matches, and references before limiting", async () => {
    const store = new InMemoryFileStore(
      new Map([
        [
          "work/epics/longer.md",
          "---\ntype: Epic\ntitle: Longer ID\nid: DKT-111\nstatus: todo\n---\n",
        ],
        [
          "work/tasks/exact.md",
          "---\ntype: Task\ntitle: Target ticket\nid: DKT-11\nstatus: done\n---\n",
        ],
        [
          "a-title.md",
          "---\ntype: Spec\ntitle: DKT-11 reference\n---\nSee DKT-11.\n",
        ],
        ["a-body.md", "DKT-11 is referenced here.\n"],
        [
          "decisions/DEC-11.md",
          "---\ntype: Decision\ntitle: Same number\nid: DEC-11\n---\n",
        ],
      ]),
    );
    const bundle = await loadBundle(store, config);
    for (const query of [
      "DKT-11",
      " dkt-11 ",
      "DKT11",
      "dkt 11",
      "11",
      "#11",
    ]) {
      const hits = await searchBundle(store, bundle, query, { limit: 1 });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.id).toBe("DKT-11");
      expect(hits[0]?.text).toBe("id: DKT-11");
    }
    expect(
      (await searchBundle(store, bundle, "dec11", { limit: 1 }))[0]?.id,
    ).toBe("DEC-11");
  });

  test("compact IDs use the bundle's project key and preserve references", async () => {
    const store = new InMemoryFileStore(
      new Map([
        [
          "work/tasks/target.md",
          "---\ntype: Task\ntitle: Target\nid: APP-42\nstatus: todo\n---\n",
        ],
        ["reference.md", "See APP-42 for details.\n"],
      ]),
    );
    const bundle = await loadBundle(store, parseConfig("project: APP"));
    const hits = await searchBundle(store, bundle, "app42");
    expect(hits.map((hit) => hit.path)).toEqual([
      "work/tasks/target.md",
      "reference.md",
    ]);
    expect(hits[0]?.matched).toEqual(["app", "42"]);
    expect(await searchBundle(store, bundle, "unknown42")).toEqual([]);
  });

  test("numeric queries require the whole prefix in the owning ticket number", async () => {
    const store = new InMemoryFileStore(
      new Map([
        ...[24, 240, 241, 246, 2460, 2461, 1246].map((n): [string, string] => [
          `work/tasks/RS-${n}.md`,
          `---\ntype: Task\ntitle: Ticket ${n} mentions 246\nid: RS-${n}\nstatus: done\n---\nSee RS-246 for details.\n`,
        ]),
        [
          "work/epics/RS-2462.md",
          "---\ntype: Epic\ntitle: Longer ticket\nid: RS-2462\nstatus: todo\n---\n",
        ],
        [
          "decisions/DEC-246.md",
          "---\ntype: Decision\ntitle: Decision\nid: DEC-246\n---\n",
        ],
        ["index.md", "See RS-246 for details.\n"],
      ]),
    );
    const bundle = await loadBundle(store, parseConfig("project: RS"));
    for (const query of ["246", " #246 "]) {
      const hits = await searchBundle(store, bundle, query);
      expect(hits.map((hit) => hit.id)).toEqual([
        "RS-246",
        "RS-2462",
        "RS-2460",
        "RS-2461",
      ]);
      expect(
        (await searchBundle(store, bundle, query, { limit: 1 }))[0]?.id,
      ).toBe("RS-246");
    }
    expect(await searchBundle(store, bundle, "2469")).toEqual([]);
    // Mixed text queries continue to search titles and bodies normally.
    expect(
      (await searchBundle(store, bundle, "mentions 246")).some(
        (hit) => hit.id === "RS-24",
      ),
    ).toBe(true);
  });

  test("deterministic: same bundle and query always order the same", async () => {
    const a = await search("checkout idempotency");
    const b = await search("checkout idempotency");
    expect(a).toEqual(b);
    // Total order: title boost first, then equal scores tie-break on path.
    expect(a.map((h) => h.path)).toEqual([
      "work/tasks/DKT-1-a.md",
      "index.md",
      "work/tasks/DKT-2-b.md",
    ]);
  });

  test("concept hits carry the link neighborhood; non-concept hits carry none", async () => {
    const hits = await search("idempotency");

    // Outbound: DKT-2 links to DKT-1 (resolved with id/title); the broken
    // /specs/missing.md link is dropped rather than handed to an agent.
    const dkt2 = hits.find((h) => h.id === "DKT-2");
    expect(dkt2?.links).toEqual([
      { path: "work/tasks/DKT-1-a.md", id: "DKT-1", title: "Checkout flow" },
    ]);
    expect(dkt2?.backlinks).toEqual([]);

    // Backlinks: DKT-1 is linked from DKT-2. index.md links here too, but it
    // isn't a concept — the neighborhood is the concept graph, same as cache.
    const dkt1 = hits.find((h) => h.id === "DKT-1");
    expect(dkt1?.links).toEqual([]);
    expect(dkt1?.backlinks).toEqual([
      { path: "work/tasks/DKT-2-b.md", id: "DKT-2", title: "Retry queue" },
    ]);

    // Non-concept file: hit works, neighborhood fields absent entirely.
    const index = hits.find((h) => h.path === "index.md");
    expect(index).toBeDefined();
    expect(index?.links).toBeUndefined();
    expect(index?.backlinks).toBeUndefined();
  });

  test("rejects empty and punctuation-only queries", async () => {
    expect(await search("")).toEqual([]);
    expect(await search("—-/")).toEqual([]);
  });
});
