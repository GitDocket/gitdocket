import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import {
  applyDocumentMove,
  planDocumentMove,
  recoverDocumentMove,
} from "./document-move";
import { InMemoryFileStore } from "./filestore";
import { resolveLink } from "./links";
import { lintBundle } from "./lint";
import { searchBundle } from "./search";

const config = parseConfig();
const from = "reference/old.md";
const to = "reference/nested/new).md";
const wiki = (body: string) =>
  `---\ntype: Reference\ntitle: Original title\ntimestamp: 2026-09-24T14:49:46.719Z\ncustom: { retained: true } # comment\n---\n\n${body}`;
const seed = () =>
  new InMemoryFileStore(
    new Map([
      [
        from,
        wiki(
          "# Anchor\n\n[out](other.md#part) ![asset](../assets/a.png) [self](old.md#anchor)\n\n`[code](old.md)`\n\n```md\n[fence](old.md)\n```\n",
        ),
      ],
      [
        "reference/other.md",
        wiki(
          '[inline](/reference/old.md#anchor "keep title")\n\n[ref][choice]\n\n[choice]: old.md#anchor',
        ),
      ],
      [
        "decisions/DEC-1-choice.md",
        "---\ntype: Decision\nid: DEC-1\nstatus: accepted\n---\n\n[choice](../reference/old.md#anchor)\n",
      ],
      ["index.md", "An authored [intro](/reference/old.md#anchor).\n"],
    ]),
  );
const request = (plan: Awaited<ReturnType<typeof planDocumentMove>>) => ({
  from: plan.from,
  to: plan.to,
  expectedVersion: plan.version,
});

describe("wiki path moves", () => {
  test("plan is read-only; apply preserves metadata/code and repairs AST destinations, definitions, images, anchors and index", async () => {
    const store = seed();
    const before = new Map(store.files);
    const plan = await planDocumentMove(store, config, from, to);
    expect(store.files).toEqual(before);
    expect(plan.applicable).toBe(true);
    expect(plan.paths).toContain("decisions/DEC-1-choice.md");
    const result = await applyDocumentMove(store, config, request(plan));
    expect(result.state).toBe("complete");
    expect(store.files.has(from)).toBe(false);
    const moved = await store.read(to);
    expect(moved).toStartWith(
      (before.get(from) ?? "").split("# Anchor")[0] ?? "",
    );
    expect(moved).toContain(
      "[out](../other.md#part) ![asset](../../assets/a.png) [self](new%29.md#anchor)",
    );
    expect(moved).toContain("`[code](old.md)`");
    expect(moved).toContain("[fence](old.md)");
    expect(await store.read("reference/other.md")).toContain(
      '[inline](/reference/nested/new%29.md#anchor "keep title")',
    );
    expect(await store.read("reference/other.md")).toContain(
      "[choice]: nested/new%29.md#anchor",
    );
    expect(await store.read("index.md")).toContain(
      "[intro](/reference/nested/new%29.md#anchor)",
    );
    expect(await store.read("index.md")).toContain(
      "[Original title](/reference/nested/new%29.md)",
    );
    const bundle = await loadBundle(store, config);
    expect(bundle.concepts.some((item) => item.path === to)).toBe(true);
    expect(bundle.concepts.some((item) => item.path === from)).toBe(false);
    const hits = await searchBundle(store, bundle, "Original title");
    expect(hits.some((hit) => hit.path === to)).toBe(true);
    expect(hits.some((hit) => hit.path === from)).toBe(false);
    expect(
      bundle.concepts
        .find((item) => item.path === "reference/other.md")
        ?.links.map((link) => resolveLink("reference/other.md", link.target)),
    ).toEqual([to, to]);
    expect(
      (await lintBundle(store, bundle)).filter((d) => d.severity === "error"),
    ).toEqual([]);
    expect((await applyDocumentMove(store, config, request(plan))).state).toBe(
      "complete",
    );
  });

  test("collision, protected source/destination and title-only or case-only requests refuse without writes", async () => {
    const store = seed();
    const before = new Map(store.files);
    await expect(
      planDocumentMove(store, config, from, "reference/other.md"),
    ).rejects.toThrow("exists");
    for (const target of [
      from,
      "Reference/Old.md",
      "../escape.md",
      "reference/Project-Guidance.md",
      "work/tasks/page.md",
      "extensions/page.md",
      "reference/index.md",
    ])
      await expect(
        planDocumentMove(store, config, from, target),
      ).rejects.toThrow();
    expect(store.files).toEqual(before);
  });

  test("changed source and newly introduced incoming reference invalidate a plan", async () => {
    for (const edit of [from, "reference/new-incoming.md"]) {
      const store = seed();
      const plan = await planDocumentMove(store, config, from, to);
      await store.write(edit, wiki(`[new](/${from})`));
      const before = new Map(store.files);
      await expect(
        applyDocumentMove(store, config, request(plan)),
      ).rejects.toThrow("stale");
      expect(store.files).toEqual(before);
    }
  });

  test("affected HTML, frontmatter and owned links block; unrelated absolute external links stay unchanged", async () => {
    for (const [path, source] of [
      ["reference/html.md", wiki('<a href="old.md#anchor">old</a>')],
      ["reference/meta.md", "---\ntype: Reference\nsee: old.md\n---\n"],
      [
        "reference/meta2.md",
        "---\ntype: Reference\nsee: '[old](old.md)'\n---\n",
      ],
      [
        "workflows/owned.md",
        "---\ntype: Workflow\n---\n\n[old](/reference/old.md)",
      ],
      ["reference/project-guidance.md", wiki("[old](old.md)")],
    ]) {
      const store = seed();
      await store.write(path ?? "", source ?? "");
      const plan = await planDocumentMove(store, config, from, to);
      expect(plan.applicable).toBe(false);
      expect(plan.blockers.length).toBeGreaterThan(0);
      const before = new Map(store.files);
      await expect(
        applyDocumentMove(store, config, request(plan)),
      ).rejects.toThrow();
      expect(store.files).toEqual(before);
    }
  });

  test("partial reference failure retains original and destination; validated recovery completes idempotently", async () => {
    const store = seed();
    const original = await store.read(from);
    const plan = await planDocumentMove(store, config, from, to);
    const write = store.write.bind(store);
    let fail = true;
    store.write = async (path, source) => {
      if (path === "reference/other.md" && fail)
        throw new Error("injected disk failure");
      await write(path, source);
    };
    const partial = await applyDocumentMove(store, config, request(plan));
    expect(partial.state).toBe("recovery_required");
    expect(partial.error).toContain("injected");
    expect(await store.read(from)).toBe(original);
    expect(store.files.has(to)).toBe(true);
    expect(await store.read(partial.journal)).toContain(
      "custom: { retained: true }",
    );
    fail = false;
    expect(
      (await recoverDocumentMove(store, config, partial.recoveryToken)).state,
    ).toBe("complete");
    expect(store.files.has(from)).toBe(false);
    expect(
      (await recoverDocumentMove(store, config, partial.recoveryToken)).state,
    ).toBe("complete");
  });

  test("partial-write originals survive in journal; unrelated edits and tampered journals never get overwritten", async () => {
    const store = seed();
    const plan = await planDocumentMove(store, config, from, to);
    const write = store.write.bind(store);
    store.write = async (path, source) => {
      if (path === "reference/other.md") {
        await write(path, "truncated");
        throw new Error("partial write");
      }
      await write(path, source);
    };
    const partial = await applyDocumentMove(store, config, request(plan));
    expect(partial.state).toBe("recovery_required");
    await expect(
      recoverDocumentMove(store, config, partial.recoveryToken),
    ).rejects.toThrow("changed outside");
    expect(await store.read("reference/other.md")).toBe("truncated");
    const journal = JSON.parse(await store.read(partial.journal));
    journal.changes[0].path = "../../outside.md";
    await write(partial.journal, JSON.stringify(journal));
    await expect(
      recoverDocumentMove(store, config, partial.recoveryToken),
    ).rejects.toThrow("bundle-relative");
    expect(store.files.has(from)).toBe(true);
  });
});

test("filesystem CLI move preserves marker; source/destination symlinks refuse before journal writes", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { LocalFileStore } = await import("./filestore");
  const root = await mkdtemp(join(tmpdir(), "docket-move-cli-"));
  try {
    await mkdir(join(root, "docs/reference"), { recursive: true });
    await mkdir(join(root, ".docket"));
    await writeFile(join(root, ".docket/active-task"), "SENTINEL-1\n");
    await writeFile(join(root, "docket.yaml"), "bundle: docs/\n");
    await writeFile(join(root, "docs", from), wiki("# Anchor\n\nKnowledge.\n"));
    const store = new LocalFileStore(join(root, "docs"));
    await symlink(join(root, ".docket"), join(root, "docs/linked"));
    await expect(
      planDocumentMove(store, config, from, "linked/new.md"),
    ).rejects.toThrow("real bundle directories");
    expect(await readdir(join(root, "docs"))).not.toContain(".docket-moves");
    await symlink(
      join(root, "docs", from),
      join(root, "docs/reference/alias.md"),
    );
    await expect(
      planDocumentMove(store, config, "reference/alias.md", "reference/new.md"),
    ).rejects.toThrow("symlink");
    await rm(join(root, "docs/reference/alias.md"));
    const cli = join(import.meta.dir, "../../cli/src/index.ts");
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code) throw new Error(err || out);
      return JSON.parse(out);
    };
    const plan = await run([
      "document",
      "move-plan",
      from,
      "reference/new.md",
      "--json",
    ]);
    await writeFile(join(root, "move.json"), JSON.stringify(request(plan)));
    expect(
      (await run(["document", "move-apply", "--input", "move.json", "--json"]))
        .state,
    ).toBe("complete");
    expect(await readFile(join(root, ".docket/active-task"), "utf8")).toBe(
      "SENTINEL-1\n",
    );
    expect(
      (await run(["document", "move-recover", plan.version, "--json"])).state,
    ).toBe("complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
