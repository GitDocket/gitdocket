import { describe, expect, test } from "bun:test";
import { loadBundle } from "./bundle";
import { parseConfig } from "./config";
import { editDocument, readEditableDocument } from "./document-edit";
import { InMemoryFileStore } from "./filestore";
import { renderIndex } from "./indexmd";
import { scaffoldFiles } from "./init";
import { lintBundle } from "./lint";
import { lintMarkdownProse, MARKDOWN_AUTHORING_RULE } from "./markdown-prose";
import { appendLog, createWorkItem } from "./ops";
import {
  DOCKET_WORKFLOWS,
  renderDocketSection,
  renderWorkflow,
} from "./workflows";

const config = parseConfig();
const long = "Long Unicode prose 雪 with ordinary words and punctuation. "
  .repeat(8)
  .trim();
const prose = `${long}\n\n- ${long}\n- [ ] ${long}\n`;

describe("unwrapped Markdown authoring", () => {
  test("long paragraphs and items stay valid at any width, including CRLF", () => {
    expect(long.length).toBeGreaterThan(240);
    expect(lintMarkdownProse("reference/long.md", prose)).toEqual([]);
    expect(
      lintMarkdownProse("reference/long.md", prose.replaceAll("\n", "\r\n")),
    ).toEqual([]);
  });

  test("reports source locations for prose and list continuations without touching source", async () => {
    const path = "reference/wrapped.md";
    const source =
      "---\ntype: Reference\n---\n\nFirst paragraph\ncontinues here\nand again.\n\n- First item\n  continues here.\n\nSecond paragraph\nwith **emphasis** and\na [link](https://example.com).\n";
    const store = new InMemoryFileStore(new Map([[path, source]]));
    const diagnostics = await lintBundle(
      store,
      await loadBundle(store, config),
    );
    expect(diagnostics.map((d) => [d.path, d.line, d.severity])).toEqual([
      [path, 6, "warning"],
      [path, 10, "warning"],
      [path, 13, "warning"],
    ]);
    expect(
      diagnostics.every((d) => d.message.includes("hard-wrapped prose")),
    ).toBe(true);
    expect(await store.read(path)).toBe(source);
  });

  test("preserves structural, quoted and explicitly intentional newlines", () => {
    const source = [
      "---",
      "type: Reference",
      "description: |",
      "  Preserve this",
      "  YAML block",
      "---",
      "",
      "# Heading",
      "",
      "Setext heading",
      "--------------",
      "",
      "First intentional break  ",
      "Second intentional break\\",
      "Third line.",
      "",
      "```md",
      "Wrapped code",
      "is literal.",
      "```",
      "",
      "    Indented code",
      "    stays literal.",
      "",
      "| Column | Other |",
      "| --- | --- |",
      "| A | B |",
      "",
      "> Quoted source",
      "> keeps its lines.",
      "",
      "- Parent paragraph.",
      "  - Nested item.",
      "",
      "  Second paragraph in parent.",
      "",
      "<div>",
      "HTML block",
      "preserves layout.",
      "</div>",
      "",
      "Intentional HTML break<br>",
      "next line.",
      "",
      "Inline `code\nspan` and an entity &#10; are preserved.",
      "",
      "[definition]: https://example.com",
      '  "Multiline title"',
      "",
    ].join("\n");
    expect(lintMarkdownProse("reference/structure.md", source)).toEqual([]);
    expect(
      lintMarkdownProse(
        "reference/structure.md",
        source.replaceAll("\n", "\r\n"),
      ),
    ).toEqual([]);
  });

  test("generated tasks, logs and indexes do not wrap long content; authored saves remain exact", async () => {
    const store = new InMemoryFileStore();
    const created = await createWorkItem(store, config, {
      title: long,
      description: long,
    });
    const initial = await store.read(created.path);
    expect(initial).toContain(`title: ${long}\n`);
    expect(initial).toContain(`description: ${long}\n`);
    await appendLog(store, config, created.id, long);
    expect(
      (await store.read(created.path))
        .split("\n")
        .some((line) => line.endsWith(` — ${long}`)),
    ).toBe(true);
    for (const body of [
      prose,
      `${prose}\nDeliberate break  \nnext line.\n`,
      "Legacy wrapped\nparagraph.\n",
    ]) {
      const draft = await readEditableDocument(store, config, created.path);
      await editDocument(store, config, created.path, {
        expectedVersion: draft.version,
        patch: { body },
      });
      const saved = await readEditableDocument(store, config, created.path);
      expect(saved.body).toBe(body);
      const unchanged = await editDocument(store, config, created.path, {
        expectedVersion: saved.version,
        patch: { body },
      });
      expect(unchanged.document.version).toBe(saved.version);
    }
    const index = renderIndex(await loadBundle(store, config));
    expect(index).toContain(long);
    expect(lintMarkdownProse("index.md", index)).toEqual([]);
  });

  test("every shipped workflow and generated agent section carries the engine rule with unwrapped output", () => {
    for (const workflow of DOCKET_WORKFLOWS) {
      expect(workflow.body).toContain(MARKDOWN_AUTHORING_RULE);
      expect(
        lintMarkdownProse(
          `${workflow.slug}.md`,
          renderWorkflow(workflow, "2026-09-16T00:00:00Z"),
        ),
      ).toEqual([]);
    }
    const section = renderDocketSection("TEST", "knowledge/");
    expect(section).toContain(MARKDOWN_AUTHORING_RULE);
    expect(lintMarkdownProse("AGENTS.md", section)).toEqual([]);
    for (const file of scaffoldFiles("TEST", "2026-09-16"))
      expect(lintMarkdownProse(file.path, file.content)).toEqual([]);
  });
});
