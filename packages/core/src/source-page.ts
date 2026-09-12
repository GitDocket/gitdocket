// Bounded inspection of exact retained source, including large activity logs.
// This is pagination, not a second search/ranking or task-state engine.
import { createHash } from "node:crypto";

export interface SourceCursor {
  path: string;
  sourceHash: string;
  offset: number;
}

interface SourceMetadata {
  source: string;
  hash: string;
  lines: Uint32Array;
}
const metadata = new WeakMap<
  ReadonlyMap<string, string>,
  Map<string, SourceMetadata>
>();
/** Share only unchanged inspected documents; entries die with their snapshots. */
export function shareSourceMetadata(
  previous: ReadonlyMap<string, string> | undefined,
  next: ReadonlyMap<string, string>,
): void {
  const prior = previous && metadata.get(previous);
  if (!prior) return;
  const files = new Map(
    [...prior].filter(([path, entry]) => next.get(path) === entry.source),
  );
  if (files.size) metadata.set(next, files);
}
function sourceMetadata(
  sources: ReadonlyMap<string, string>,
  path: string,
  source: string,
): SourceMetadata {
  let files = metadata.get(sources);
  if (!files) {
    files = new Map();
    metadata.set(sources, files);
  }
  const old = files.get(path);
  if (old?.source === source) return old;
  const lines = [0];
  for (let i = 0; i < source.length; i++)
    if (source.charCodeAt(i) === 10) lines.push(i + 1);
  const entry = {
    source,
    hash: createHash("sha256").update(source).digest("hex"),
    lines: Uint32Array.from(lines),
  };
  files.set(path, entry);
  return entry;
}
function lineAt(lines: Uint32Array, offset: number): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((lines[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
const lowSurrogate = (char: string) => /^[\uDC00-\uDFFF]$/.test(char);
const highSurrogate = (char: string) => /^[\uD800-\uDBFF]$/.test(char);
export interface SourcePage {
  path: string;
  sourceHash: string;
  startLine: number;
  endLine: number;
  text: string;
  taskIds: string[];
  dates: string[];
  nextCursor?: SourceCursor;
}

/** Cursors are UTF-16 offsets tied to the complete source content identity. */
export function sourcePage(
  sources: ReadonlyMap<string, string>,
  path: string,
  options: { cursor?: SourceCursor; maxChars?: number } = {},
): SourcePage | undefined {
  const source = sources.get(path);
  if (source === undefined) return undefined;
  const { hash: sourceHash, lines } = sourceMetadata(sources, path, source);
  const offset = options.cursor?.offset ?? 0;
  if (options.cursor && options.cursor.sourceHash !== sourceHash)
    throw new Error("source changed; restart pagination");
  if (options.cursor && options.cursor.path !== path)
    throw new Error("source path changed; restart pagination");
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
    throw new Error("invalid source cursor");
  if (
    lowSurrogate(source[offset] ?? "") &&
    highSurrogate(source[offset - 1] ?? "")
  )
    throw new Error("invalid source cursor: split Unicode character");
  const requested = options.maxChars ?? 16_384;
  if (!Number.isInteger(requested) || requested < 1)
    throw new Error("maxChars must be a positive integer");
  const maxChars = Math.min(32_768, Math.floor(requested));
  let end = Math.min(source.length, offset + maxChars);
  // Prefer complete lines; exceptionally long lines still have a hard bound.
  if (end < source.length) {
    let newline = end - 1;
    while (newline >= offset && source.charCodeAt(newline) !== 10) newline--;
    if (newline >= offset) end = newline + 1;
    else if (
      lowSurrogate(source[end] ?? "") &&
      highSurrogate(source[end - 1] ?? "")
    ) {
      end--;
      if (end === offset)
        throw new Error(
          "maxChars is too small for a complete Unicode character",
        );
    }
  }
  const text = source.slice(offset, end);
  // A page boundary cannot manufacture a shorter ID from a clipped token.
  const wholeTokens = (pattern: RegExp) => [
    ...new Set(
      [...text.matchAll(pattern)]
        .filter((match) => {
          const start = offset + match.index;
          const end = start + match[0].length;
          return (
            !/\w/.test(source[start - 1] ?? "") && !/\w/.test(source[end] ?? "")
          );
        })
        .map((match) => match[0]),
    ),
  ];
  return {
    path,
    sourceHash,
    startLine: lineAt(lines, offset),
    endLine: lineAt(lines, Math.max(offset, end - 1)),
    text,
    taskIds: wholeTokens(/\b[A-Z][A-Z0-9]*-\d+\b/g),
    dates: wholeTokens(/\b\d{4}-\d{2}-\d{2}\b/g),
    ...(end < source.length
      ? { nextCursor: { path, sourceHash, offset: end } }
      : {}),
  };
}
