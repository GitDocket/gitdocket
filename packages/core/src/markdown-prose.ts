// Authoring policy and read-only diagnostics shared by every Docket surface.
// Inspect syntax, never reserialize authored Markdown or guess at its intent.
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import type { Diagnostic } from "./parse";

export const MARKDOWN_AUTHORING_RULE =
  "Do not hard-wrap Markdown prose. Keep each paragraph and each simple list item on one source line, regardless of length; let the browser or Markdown preview wrap the text. Preserve blank lines and meaningful line breaks in Markdown structure, code, tables, blockquotes and explicitly intentional breaks. After authoring bundle content, run `docket lint --json` and review any hard-wrapped prose warnings.";

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm);

/** One warning per paragraph with a soft source newline, including list prose.
 * Explicit Markdown breaks are separate AST nodes; YAML, code, HTML, tables
 * and quoted source are deliberately outside this prose rule. Warnings allow
 * legacy content and intentional layout to be reviewed without changing bytes.
 */
export function lintMarkdownProse(path: string, source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  visit(processor.parse(source), (node) => {
    if (node.type === "blockquote") return SKIP;
    if (node.type !== "paragraph") return;
    // Inline HTML can request layout (<br>, multiline spans). Its intent is
    // outside this Markdown prose rule just like a block of raw HTML.
    let hasHtml = false;
    visit(node, "html", () => {
      hasHtml = true;
    });
    if (hasHtml) return SKIP;
    let line: number | undefined;
    visit(node, "text", (text) => {
      if (line !== undefined || !text.position) return;
      const start = text.position.start.offset;
      const end = text.position.end.offset;
      if (start === undefined || end === undefined) return;
      // Check source, not decoded text: an entity such as &#10; is not a wrap.
      if (/\r?\n/.test(source.slice(start, end)))
        line = text.position.start.line + 1;
    });
    if (line !== undefined)
      diagnostics.push({
        path,
        line,
        severity: "warning",
        message: `hard-wrapped prose (line ${line}) — keep each paragraph or simple list item on one source line; use an explicit Markdown break for intentional layout`,
      });
  });
  return diagnostics;
}
