import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { InMemoryFileStore } from "./filestore";
import { type CreateInput, createDecision, createWorkItem } from "./ops";

const config = parseConfig("project: JOB\nids:\n  decision_prefix: ADR\n");
const decision = (id: string, aliases = "") =>
  `---\ntype: Decision\nid: ${id}\n${aliases}---\n\n# Context\n\nHistorical choice\n`;

describe("decision creation", () => {
  test("independent configured sequence, metadata and complete supplied sections round-trip", async () => {
    const store = new InMemoryFileStore(
      new Map([
        ["decisions/old.md", decision("ADR-4")],
        [
          "reference/notes.md",
          "---\ntype: Reference\ntitle: '[broken generic metadata'\n---\n",
        ],
      ]),
    );
    const work = await createWorkItem(store, config, { title: "Work" });
    const created = await createDecision(store, config, {
      title: "Use files",
      description: "A: choice",
      tags: ["a,b", "#choice"],
      context: "Consider files or SQL.",
      decision: "Use files for review.",
      consequences: "Handle merge conflicts.",
    });
    expect(work.id).toBe("JOB-1");
    expect(created).toEqual({
      id: "ADR-5",
      path: "decisions/ADR-5-use-files.md",
    });
    const source = await store.read(created.path);
    expect(source).toContain("# Context\n\nConsider files or SQL.");
    expect(source).toContain("# Decision\n\nUse files for review.");
    expect(source).toContain("# Consequences\n\nHandle merge conflicts.");
    const bundle = await loadBundle(store, config);
    const item = bundle.byId(created.id);
    expect(item?.kind).toBe("decision");
    expect(item?.fm.status).toBe("accepted");
    expect(item?.fm.tags).toEqual(["a,b", "#choice"]);
    expect(
      (await createWorkItem(store, config, { title: "Next work" })).id,
    ).toBe("JOB-2");
  });

  test("same prefix and former IDs share the occupied identity namespace", async () => {
    const shared = parseConfig("project: ADR\nids:\n  decision_prefix: ADR\n");
    const store = new InMemoryFileStore(
      new Map([
        ["reference/moved.md", decision("ADR-2", "aliases: [ADR-9]\n")],
      ]),
    );
    expect((await createWorkItem(store, shared, { title: "Work" })).id).toBe(
      "ADR-10",
    );
    expect((await createDecision(store, shared, { title: "Choice" })).id).toBe(
      "ADR-11",
    );
    expect(
      (await createWorkItem(store, shared, { title: "Epic", type: "Epic" })).id,
    ).toBe("ADR-12");
  });

  test("regex punctuation in configured prefix is literal", async () => {
    const cfg = parseConfig("ids:\n  decision_prefix: A.D\n");
    const store = new InMemoryFileStore(
      new Map([["decisions/old.md", decision("AxD-50")]]),
    );
    const created = await createDecision(store, cfg, { title: "Choice" });
    expect(created.id).toBe("A.D-1");
    expect((await loadBundle(store, cfg)).byId(created.id)?.kind).toBe(
      "decision",
    );
  });

  test("exclusive collisions fail, preserve source, and do not report creation", async () => {
    for (const create of [createDecision, createWorkItem]) {
      const store = new InMemoryFileStore();
      store.createExclusive = async (path) => {
        await store.write(path, "authored concurrent source");
        return false;
      };
      await expect(create(store, config, { title: "Choice" })).rejects.toThrow(
        "destination already exists",
      );
      expect(await store.read((await store.list())[0] ?? "missing")).toBe(
        "authored concurrent source",
      );
    }
  });

  test("invalid work types, empty titles, unsafe slugs and prefixes fail without writing", async () => {
    const store = new InMemoryFileStore();
    for (const type of ["Decision", "Reference", "task", ""]) {
      await expect(
        createWorkItem(store, config, {
          title: "Invalid",
          type: type as CreateInput["type"],
        }),
      ).rejects.toThrow("unsupported work type");
    }
    await expect(createDecision(store, config, { title: " " })).rejects.toThrow(
      "title",
    );
    await expect(
      createWorkItem(store, config, { title: "Escape", slug: "../../bad" }),
    ).rejects.toThrow("slug");
    await expect(
      createDecision(store, parseConfig("ids:\n  decision_prefix: ../BAD\n"), {
        title: "Escape",
      }),
    ).rejects.toThrow("prefix");
    for (const prefix of [".DEC", "HID\nDEN", "BAD\x7f"]) {
      const cfg = {
        ...config,
        ids: { ...config.ids, decision_prefix: prefix },
      };
      await expect(
        createDecision(store, cfg, { title: "Hidden" }),
      ).rejects.toThrow("prefix");
    }
    expect(await store.list()).toEqual([]);
  });

  test("concurrent same-store decisions serialize and default to a complete scaffold", async () => {
    const store = new InMemoryFileStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createDecision(store, config, { title: `Choice ${i}` }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(8);
    const source = await store.read(results[0]?.path ?? "missing");
    expect(source).toContain("# Context");
    expect(source).toContain("# Decision");
    expect(source).toContain("# Consequences");
    expect(source).not.toContain("Acceptance Criteria");
  });
});
