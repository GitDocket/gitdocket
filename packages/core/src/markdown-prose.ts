// Authoring policy and read-only diagnostics shared by every Docket surface.
// Inspect syntax, never reserialize authored Markdown or guess at its intent.
import { createHash } from "node:crypto";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import type { Diagnostic } from "./parse";

export const BUNDLE_VALIDATION_RULE =
  'After the final bundle edits in a batch, refresh required discovery once, then run `docket lint --json` once and review diagnostics caused by the change, including hard-wrapped prose. Include task-state, index and log edits before that check. Reuse the result while lint inputs remain unchanged; code-only changes do not require bundle lint unless they affect its implementation, configuration or other inputs. Later relevant edits, missing evidence or uncertain input state require revalidation. Preserve explicit project validation requirements. At a handoff or context compaction, retain the command, result summary, evidence reference when available, validated input identity or explicit uncertainty, and subsequent relevant changes. A receipt alone does not prove unchanged inputs; verify its applicability before reuse. Docket cannot guarantee host context retention. Keep routine validation in the durable receipt; report material findings and limits. Prefer CLI `--summary --report <owned-json-file>` for bounded output with complete durable evidence; optional `--baseline <prior-report>` and `--changed-path <path>` highlight changes. MCP `lint` supports `view: "summary"`, `changed_paths` and a checkout-relative `baseline_path`; its complete view stays available. Selection never weakens global errors or strict warning policy. Missing/incompatible baselines leave warning history unknown.';

export const MARKDOWN_AUTHORING_RULE =
  "Do not hard-wrap Markdown prose. Keep each paragraph and each simple list item on one source line, regardless of length; let the browser or Markdown preview wrap the text. Preserve blank lines and meaningful line breaks in Markdown structure, code, tables, blockquotes and explicitly intentional breaks. " +
  BUNDLE_VALIDATION_RULE;

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
        code: "markdown.hard-wrap",
        category: "authoring",
        fingerprint: createHash("sha256")
          .update(
            source.slice(
              node.position?.start.offset,
              node.position?.end.offset,
            ),
          )
          .digest("hex"),
        message: `hard-wrapped prose (line ${line}) — keep each paragraph or simple list item on one source line; use an explicit Markdown break for intentional layout`,
      });
  });
  return diagnostics;
}
