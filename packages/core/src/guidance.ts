// Project-authored guidance is an ordinary concept, never a generated policy.
import type { DocketConfig } from "./config";
import type { FileStore } from "./filestore";
import { resolveLink } from "./links";
import { type Diagnostic, parseConcept } from "./parse";
import { buildSchemas } from "./schema";
import { type SourcePage, sourcePage } from "./source-page";

export const PROJECT_GUIDANCE_PATH = "reference/project-guidance.md";

export interface GuidanceLink {
  target: string;
  path?: string;
  status: "available" | "missing" | "unsupported" | "external";
}

export interface ProjectGuidance {
  path: string;
  status: "absent" | "empty" | "present" | "invalid" | "unavailable";
  /** Exact first source page. Follow its cursor before treating it as complete. */
  source?: SourcePage;
  /** Explicit links only; availability does not establish authority or meaning. */
  links: GuidanceLink[];
  linksTruncated?: boolean;
  diagnostics: Diagnostic[];
}

/** Read the optional entry point without reading procedure bodies or tracker state. */
export async function readProjectGuidance(
  store: FileStore,
  config: DocketConfig,
): Promise<ProjectGuidance> {
  const path = PROJECT_GUIDANCE_PATH;
  const result: ProjectGuidance = {
    path,
    status: "absent",
    links: [],
    diagnostics: [],
  };
  let files: Set<string>;
  let source: string;
  try {
    files = new Set(await store.list());
    if (!files.has(path)) return result;
    source = await store.read(path);
  } catch (error) {
    return {
      ...result,
      status: "unavailable",
      diagnostics: [{ path, severity: "error", message: String(error) }],
    };
  }
  result.source = sourcePage(new Map([[path, source]]), path);
  if (
    /^<{7} /m.test(source) &&
    /^={7}$/m.test(source) &&
    /^>{7} /m.test(source)
  ) {
    result.status = "invalid";
    result.diagnostics.push({
      path,
      severity: "error",
      message:
        "project guidance has unresolved merge-conflict markers; resolve the competing instructions explicitly",
    });
    return result;
  }
  const parsed = parseConcept(path, source, buildSchemas(config));
  result.diagnostics = [...parsed.diagnostics];
  if (parsed.concept?.fm.type !== "Reference") {
    result.status = "invalid";
    if (parsed.concept)
      result.diagnostics.push({
        path,
        severity: "error",
        message: "project guidance entry point must have type: Reference",
      });
    return result;
  }
  const body = source
    .replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
    .trim();
  result.status = body ? "present" : "empty";
  const links = [
    ...new Map(
      parsed.concept.links.map((link) => [link.target, link]),
    ).values(),
  ];
  result.linksTruncated = links.length > 100;
  result.links = links.slice(0, 100).map((link) => {
    if (!link.internal) return { target: link.target, status: "external" };
    const resolved = link.target.startsWith("#")
      ? path
      : resolveLink(path, link.target);
    const status = !resolved
      ? "unsupported"
      : files.has(resolved)
        ? "available"
        : "missing";
    if (status === "missing" || status === "unsupported")
      result.diagnostics.push({
        path,
        severity: "error",
        message: `guidance link ${link.target}: ${status}; repair or deliberately retire this link`,
      });
    return { target: link.target, path: resolved, status };
  });
  return result;
}
