/** Keep document definitions from changing the host's renderer or loading assets. */
export function checkMermaidSource(source: string): void {
  if (source.length > 50_000)
    throw new Error("Diagram exceeds the 50,000-character limit.");
  if (/%%\s*\{|^\s*---/m.test(source))
    throw new Error(
      "Diagram configuration directives and frontmatter are not supported.",
    );
  // CSS escapes/comments and YAML quoted keys must not disguise resource URLs.
  const normalized = source
    .replace(/\\(?:([0-9a-f]{1,6})\s?|([^\r\n]))/gi, (_, hex, char) =>
      hex ? String.fromCodePoint(Number.parseInt(hex, 16) || 0xfffd) : char,
    )
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (/(?:["']?img["']?\s*:|@import|url\s*\(\s*["']?[^#\s])/i.test(normalized))
    throw new Error(
      "External images and CSS resources are not supported in diagrams.",
    );
}
