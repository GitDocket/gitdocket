import { parse as parseYaml } from "yaml";

export function numberedIdPattern(prefix: string): RegExp {
  return new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`,
  );
}

/** Reserve typed identities anywhere, tolerating unrelated generic metadata. */
export function reservedConceptIds(source: string, path: string): string[] {
  const frontmatter = source.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
  )?.[1];
  const conventional = /^(?:work\/(?:tasks|epics)|decisions)\/.+\.md$/.test(
    path,
  );
  let metadata: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = frontmatter && parseYaml(frontmatter);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      metadata = parsed as Record<string, unknown>;
  } catch {
    // Preserve the existing conservative reservation for malformed numbered
    // sources with a readable primary ID; never guess at malformed aliases.
  }
  if (metadata) {
    const numbered = ["Task", "Epic", "Decision"].includes(
      String(metadata.type),
    );
    if (!numbered && (!conventional || metadata.type !== undefined)) return [];
    if (typeof metadata.id !== "string" || !metadata.id)
      throw new Error(
        `linked work item ${path} has no readable frontmatter id`,
      );
    const aliases = metadata.aliases ?? [];
    if (
      !Array.isArray(aliases) ||
      aliases.some((value) => typeof value !== "string")
    )
      throw new Error(`cannot read aliases in ${path}`);
    return [metadata.id, ...aliases];
  }
  const numberedType =
    frontmatter &&
    /^["']?type["']?:\s*['"]?(?:Task|Epic|Decision)['"]?\s*(?:#.*)?$/m.test(
      frontmatter,
    );
  if (!conventional && !numberedType) return [];
  const id = frontmatter?.match(
    /^["']?id["']?:\s*['"]?([^\s'"#]+)['"]?\s*(?:#.*)?$/m,
  )?.[1];
  if (!id)
    throw new Error(`linked work item ${path} has no readable frontmatter id`);
  if (/^["']?aliases["']?:/m.test(frontmatter ?? ""))
    throw new Error(`cannot read aliases in ${path}`);
  return [id];
}
