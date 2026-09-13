/** Resolve an internal link against the bundle root; undefined = not checkable (non-md, escapes bundle). */
export function resolveLink(
  fromPath: string,
  target: string,
): string | undefined {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return undefined;
  let clean: string;
  try {
    clean = decodeURIComponent(target.split("#")[0] ?? "");
  } catch {
    return undefined;
  }
  if (!clean.endsWith(".md")) return undefined;
  const parts = clean.startsWith("/")
    ? clean.slice(1).split("/")
    : [...fromPath.split("/").slice(0, -1), ...clean.split("/")];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}
