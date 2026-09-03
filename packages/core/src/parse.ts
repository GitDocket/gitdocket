// Per-file parsing: markdown → AST (unified/remark) → frontmatter (yaml) +
// link graph. Reserved OKF filenames (index.md, log.md, overview.md) are structural, not
// concepts, and skip frontmatter validation entirely.

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

export interface Link {
  /** Raw target as written: bundle-absolute (/specs/x.md), relative, or external URL. */
  target: string;
  internal: boolean;
}

export interface Diagnostic {
  path: string;
  message: string;
  severity: "error" | "warning";
}

interface ConceptBase {
  path: string;
  links: Link[];
}

export interface WorkItem extends ConceptBase {
  kind: "work";
  fm: WorkItemFrontmatter;
  /** Authored close result, when the conventional `# Outcome` section exists. */
  outcome?: string;
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

/** Extract one conventional level-one section without making it mandatory. */
export function markdownSection(
  source: string,
  heading: string,
): string | undefined {
  const lines = source.split(/\r?\n/);
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex((line) => {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    return match?.[1]?.trim().toLowerCase() === wanted;
  });
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#\s+/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body || undefined;
}

function extractLinks(tree: ReturnType<typeof processor.parse>): Link[] {
  const links: Link[] = [];
  visit(tree, "link", (node: { url?: string }) => {
    if (!node.url) return;
    links.push({
      target: node.url,
      internal: !/^[a-z][a-z0-9+.-]*:/i.test(node.url),
    });
  });
  return links;
}

export function parseConcept(
  path: string,
  source: string,
  schemas: Schemas,
): { concept?: Concept; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const tree = processor.parse(source);
  const links = extractLinks(tree);

  if (isReserved(path)) return { diagnostics };

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
        severity: "error",
      });
    }
    return { diagnostics };
  }

  const sections =
    kind === "work"
      ? { outcome: markdownSection(source, "Outcome") }
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
      ...presentSections,
    } as Concept,
    diagnostics,
  };
}
