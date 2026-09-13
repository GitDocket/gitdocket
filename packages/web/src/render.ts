// Markdown → HTML through the same unified pipeline core parses with (spec
// promise: what the linter sees is what the renderer shows). Internal .md
// links are rewritten to SPA hash routes so the wiki graph stays navigable.

import { resolveLink } from "@gitdocket/core";
import type { Root } from "hast";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { conceptHref } from "./urls";

const isExternal = (href: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

/** Resolve browser addresses from the current bundle while keeping Markdown paths. */
function rewriteLinks(fromPath: string, hrefForPath: (path: string) => string) {
  return (tree: Root): void => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "a" || !node.properties) return;
      const href = node.properties.href;
      if (typeof href !== "string" || isExternal(href)) return;
      const resolved =
        href.startsWith("#") && !href.startsWith("#/")
          ? fromPath
          : resolveLink(fromPath, href);
      if (resolved) {
        const fragment = href.indexOf("#");
        node.properties.href =
          hrefForPath(resolved) + (fragment < 0 ? "" : href.slice(fragment));
      }
    });
  };
}

// Shared by reading and editor preview: raw HTML is omitted by remark-rehype;
// reject executable URL schemes, including whitespace-obfuscated forms.
function safeUrls() {
  return (tree: Root): void => {
    visit(tree, "element", (node) => {
      for (const key of ["href", "src"]) {
        const value = node.properties[key];
        if (typeof value !== "string") continue;
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip URL scheme obfuscation before validation.
        const normalized = value.replace(/[\u0000-\u0020\u007f]/g, "");
        const scheme = /^([a-z][a-z0-9+.-]*):/i
          .exec(normalized)?.[1]
          ?.toLowerCase();
        if (
          scheme &&
          ![
            "http",
            "https",
            ...(key === "href" ? ["mailto", "tel"] : []),
          ].includes(scheme)
        )
          delete node.properties[key];
      }
    });
  };
}

function headingIds(onHeading?: (id: string, offset: number) => void) {
  return (tree: Root): void => {
    const used = new Set<string>();
    const text = (node: Root["children"][number]): string =>
      "value" in node
        ? node.value
        : "children" in node
          ? node.children.map(text).join("")
          : "";
    visit(tree, "element", (node) => {
      if (!/^h[1-6]$/.test(node.tagName)) return;
      const base = text(node)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
        .replace(/\s/g, "-");
      let id = base;
      let suffix = 0;
      while (used.has(id)) id = `${base}-${++suffix}`;
      used.add(id);
      node.properties.id = id;
      onHeading?.(id, node.position?.start.offset ?? 0);
    });
  };
}

/** Locate a heading in exact source without rendering an unbounded HTML body. */
export function markdownHeadingOffsets(source: string): Map<string, number> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkRehype);
  const tree = processor.runSync(processor.parse(source));
  const offsets = new Map<string, number>();
  headingIds((id, offset) => offsets.set(id, offset))(tree);
  return offsets;
}

export function renderMarkdown(
  path: string,
  source: string,
  hrefForPath: (path: string) => string = (path) => conceptHref({ path }),
): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => rewriteLinks(path, hrefForPath))
    .use(headingIds)
    .use(safeUrls)
    .use(rehypeStringify)
    .processSync(source);
  return String(file);
}
