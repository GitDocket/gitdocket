import type { Diagnostic } from "./parse";

const rules: [RegExp, string, string][] = [
  [/^hard-wrapped prose/, "markdown.hard-wrap", "authoring"],
  [/^missing YAML frontmatter/, "frontmatter.missing", "structure"],
  [/^invalid YAML:/, "frontmatter.invalid-yaml", "structure"],
  [/^frontmatter is not a mapping/, "frontmatter.not-mapping", "structure"],
  [/^missing required `type`/, "frontmatter.missing-type", "structure"],
  [/^duplicate id /, "identity.duplicate", "structure"],
  [/^depends_on .* does not resolve/, "dependency.unresolved", "structure"],
  [/^broken link:/, "link.unresolved", "links"],
  [/^filename does not start/, "identity.filename-drift", "workflow"],
  [/^done but has unchecked/, "task.unchecked-criteria", "workflow"],
  [/^(in-progress|in-review) but untouched/, "task.stale", "freshness"],
  [/^product context needs review/, "context.needs-review", "freshness"],
  [/^merge-conflict markers/, "merge.unresolved", "structure"],
  [/^docket:verifies target/, "verification.unresolved", "verification"],
  [/^no \*\*Freshness\*\*/, "freshness.missing", "freshness"],
  [/^Freshness watermark is/, "freshness.expired", "freshness"],
  [/^\d+ trailerless work/, "freshness.unlinked-work", "freshness"],
];

export type LintDiagnostic = Diagnostic & { code: string; category: string };
/** Stable rule identifiers are independent of IDs, paths and changing counts.
 * Unknown external diagnostics remain explicit rather than guess a known rule.
 */
export function classifyLintDiagnostic(d: Diagnostic): LintDiagnostic {
  if (d.code && d.category) return d as LintDiagnostic;
  const rule = rules.find(([pattern]) => pattern.test(d.message));
  const fallback =
    d.path === "reference/project-guidance.md"
      ? ["guidance.invalid", "guidance"]
      : d.path === "overview.md" && d.severity === "error"
        ? ["context.invalid", "structure"]
        : ["diagnostic.unknown", "unknown"];
  return {
    ...d,
    code: rule?.[1] ?? (fallback[0] as string),
    category: rule?.[2] ?? (fallback[1] as string),
  };
}
