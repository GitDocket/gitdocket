// Per-file parsing: markdown → AST (unified/remark) → frontmatter (yaml) +
// link graph. Reserved OKF filenames (index.md, log.md, overview.md) are structural, not
// concepts, and skip frontmatter validation entirely.

import { createHash } from "node:crypto";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import type {
  DecisionFrontmatter,
  GenericFrontmatter,
  Schemas,
  WorkItemFrontmatter,
} from "./schema";
import { recordWork } from "./work-metrics";

export interface Link {
  /** Raw target as written: bundle-absolute (/specs/x.md), relative, or external URL. */
  target: string;
  internal: boolean;
}

export interface Diagnostic {
  path: string;
  /** One-based source line, when a diagnostic identifies a specific location. */
  line?: number;
  message: string;
  severity: "error" | "warning";
  code?: string;
  category?: string;
  /** Stable evidence identity when source location can move independently. */
  fingerprint?: string;
}

interface ConceptBase {
  path: string;
  links: Link[];
}

export interface WorkItem extends ConceptBase {
  kind: "work";
  /** Complete source identity for drift comparison, independent of stat cache tokens. */
  sourceVersion?: string;
  fm: WorkItemFrontmatter;
  /** Authored close result, when the conventional `# Outcome` section exists. */
  outcome?: string;
  /** Optional authored checkpoint; never overrides stored status or readiness. */
  currentState?: string;
}

export interface Decision extends ConceptBase {
  kind: "decision";
  fm: DecisionFrontmatter;
  /** Conventional decision sections, kept as Markdown for shared summaries. */
  context?: string;
  decision?: string;
  consequences?: string;
}

export interface GenericConcept extends ConceptBase {
  kind: "generic";
  fm: GenericFrontmatter;
}

export type Concept = WorkItem | Decision | GenericConcept;

const RESERVED = new Set(["index.md", "log.md", "overview.md"]);

export function isReserved(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return RESERVED.has(name);
}

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

/** Canonical top-level ranges for section reads and writes, including setext headings. */
export function markdownSections(source: string) {
  const sections: {
    heading: string;
    start: number;
    contentStart: number;
    end: number;
  }[] = [];
  for (const node of processor.parse(source).children) {
    if (node.type !== "heading" || node.depth !== 1) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const heading = source
      .slice(start, end)
      .replace(/^#[ \t]+/, "")
      .replace(/[ \t]+#+$/, "")
      .replace(/\r?\n=+[ \t]*$/, "")
      .trim();
    const previous = sections.at(-1);
    if (previous) previous.end = start;
    sections.push({
      heading,
      start,
      contentStart:
        end +
        (source.slice(end, end + 2) === "\r\n"
          ? 2
          : source[end] === "\n"
            ? 1
            : 0),
      end: source.length,
    });
  }
  return sections;
}

/** Lightweight conventional ATX projection; metadata reads never build a body AST. */
function conventionalSections(source: string) {
  const sections: {
    heading: string;
    start: number;
    contentStart: number;
    end: number;
  }[] = [];
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source);
  let fence: string | undefined;
  let comment = false;
  for (const line of source.matchAll(/^.+(?:\n|$)|^\n/gm)) {
    const start = line.index;
    if (start < (frontmatter?.[0].length ?? 0)) continue;
    const text = line[0].replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (
        marker?.[1] &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = undefined;
      continue;
    }
    if (comment) {
      if (text.includes("-->")) comment = false;
      continue;
    }
    if (/^\s*<!--/.test(text)) {
      comment = !text.includes("-->");
      continue;
    }
    if (marker && !(marker[1]?.[0] === "`" && marker[2]?.includes("`"))) {
      fence = marker[1];
      continue;
    }
    const heading = /^ {0,3}#[ \t]+(.+?)[ \t]*$/
      .exec(text)?.[1]
      ?.replace(/[ \t]+#+$/, "")
      .trim();
    if (!heading) continue;
    const previous = sections.at(-1);
    if (previous) previous.end = start;
    sections.push({
      heading,
      start,
      contentStart: start + line[0].length,
      end: source.length,
    });
  }
  return sections;
}

/** Extract authored text without interpreting its meaning or making it mandatory. */
export function markdownSection(
  source: string,
  heading: string,
): string | undefined {
  if (!source.toLowerCase().includes(heading.toLowerCase())) return undefined;
  const section = conventionalSections(source).find(
    (s) => s.heading.toLowerCase() === heading.trim().toLowerCase(),
  );
  return section
    ? source.slice(section.contentStart, section.end).trim() || undefined
    : undefined;
}

function extractLinks(tree: ReturnType<typeof processor.parse>): Link[] {
  const links: Link[] = [];
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node: { identifier: string; url: string }) => {
    const key = node.identifier.toLowerCase();
    if (!definitions.has(key)) definitions.set(key, node.url);
  });
  visit(tree, ["link", "linkReference"], (node) => {
    if (node.type !== "link" && node.type !== "linkReference") return;
    const target =
      node.type === "link"
        ? node.url
        : definitions.get(node.identifier.toLowerCase());
    if (!target) return;
    links.push({
      target,
      internal: !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target),
    });
  });
  return links;
}

export function parseConcept(
  path: string,
  source: string,
  schemas: Schemas,
): { concept?: Concept; diagnostics: Diagnostic[] } {
  return parse(path, source, schemas, true);
}

/** Frontmatter/summary projection for operations that never inspect links. */
export function parseMetadataConcept(
  path: string,
  source: string,
  schemas: Schemas,
): { concept?: Concept; diagnostics: Diagnostic[] } {
  return parse(path, source, schemas, false);
}

function parse(
  path: string,
  source: string,
  schemas: Schemas,
  includeLinks: boolean,
): { concept?: Concept; diagnostics: Diagnostic[] } {
  // Structural files have no concept or diagnostic contract. In particular,
  // never build an unused Markdown tree for an ever-growing activity log.
  if (isReserved(path)) return { diagnostics: [] };
  recordWork("parse");
  const diagnostics: Diagnostic[] = [];
  // The canonical Markdown parser still recognizes the frontmatter. For the
  // common LF-delimited form it needs only the prefix through the closing
  // fence. Unusual/malformed delimiters retain the full parser fallback.
  const end = source.startsWith("---\n") ? source.indexOf("\n---\n", 3) : -1;
  const tree = processor.parse(
    !includeLinks && end >= 0 ? source.slice(0, end + 5) : source,
  );
  const links = includeLinks ? extractLinks(tree) : [];

  const fmNode = tree.children[0];
  if (fmNode?.type !== "yaml") {
    diagnostics.push({
      path,
      message: "missing YAML frontmatter",
      severity: "error",
    });
    return { diagnostics };
  }

  let raw: unknown;
  try {
    raw = parseYaml(fmNode.value);
  } catch (error) {
    diagnostics.push({
      path,
      message: `invalid YAML: ${String(error)}`,
      severity: "error",
    });
    return { diagnostics };
  }
  if (typeof raw !== "object" || raw === null) {
    diagnostics.push({
      path,
      message: "frontmatter is not a mapping",
      severity: "error",
    });
    return { diagnostics };
  }

  const type = (raw as Record<string, unknown>).type;
  if (typeof type !== "string" || type.length === 0) {
    diagnostics.push({
      path,
      message: "missing required `type` field (OKF)",
      severity: "error",
    });
    return { diagnostics };
  }

  const pick = () => {
    if (type === "Task" || type === "Epic")
      return { kind: "work" as const, schema: schemas.workItem };
    if (type === "Decision")
      return { kind: "decision" as const, schema: schemas.decision };
    return { kind: "generic" as const, schema: schemas.generic };
  };
  const { kind, schema } = pick();

  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      diagnostics.push({
        path,
        message: `${issue.path.join(".") || "frontmatter"}: ${issue.message}`,
        code: "frontmatter.schema",
        category: "structure",
        severity: "error",
      });
    }
    return { diagnostics };
  }

  const sections =
    kind === "work"
      ? {
          outcome: markdownSection(source, "Outcome"),
          currentState: markdownSection(source, "Current state"),
        }
      : kind === "decision"
        ? {
            context: markdownSection(source, "Context"),
            decision: markdownSection(source, "Decision"),
            consequences: markdownSection(source, "Consequences"),
          }
        : {};
  const presentSections = Object.fromEntries(
    Object.entries(sections).filter(([, value]) => value !== undefined),
  );

  return {
    concept: {
      path,
      links,
      kind,
      fm: result.data,
      ...(kind === "work"
        ? { sourceVersion: createHash("sha256").update(source).digest("hex") }
        : {}),
      ...presentSections,
    } as Concept,
    diagnostics,
  };
}
