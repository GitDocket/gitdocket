// Markdown → HTML through the same unified pipeline core parses with (spec
// promise: what the linter sees is what the renderer shows). Internal .md
// links are rewritten to SPA hash routes so the wiki graph stays navigable.

import { resolveLink } from "@docket/core";
import type { Root } from "hast";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const isExternal = (href: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/** Rewrite internal .md links to `#/c/<bundle-path>`; leave the rest alone. */
function rewriteLinks(fromPath: string) {
  return (tree: Root): void => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "a" || !node.properties) return;
      const href = node.properties.href;
      if (typeof href !== "string" || isExternal(href)) return;
      const resolved = resolveLink(fromPath, href);
      if (resolved) node.properties.href = `#/c/${resolved}`;
    });
  };
}

export function renderMarkdown(path: string, source: string): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => rewriteLinks(path))
    .use(rehypeStringify)
    .processSync(source);
  return String(file);
}
