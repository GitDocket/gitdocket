import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

interface Nodes {
  type: string;
  url?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Nodes[];
}

import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadBundle } from "./bundle";
import type { DocketConfig } from "./config";
import {
  DOCUMENT_TYPES,
  DocumentEditError,
  readEditableDocument,
  validateDocumentPath,
} from "./document-edit";
import { mapFiles } from "./file-batch";
import { type FileStore, InMemoryFileStore, LocalFileStore } from "./filestore";
import { applyIndex, renderIndex } from "./indexmd";
import { markdownPath as encoded } from "./links";
import { mutate } from "./ops";
import { parseMetadataConcept } from "./parse";
import { buildSchemas } from "./schema";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);
const PROTECTED = /^(?:workflows|extensions)\//i;
const owned = (path: string, source: string) =>
  PROTECTED.test(path) ||
  path.toLowerCase() === "reference/project-guidance.md" ||
  (path !== "index.md" && /<!--\s*(?:>>>|BEGIN).*docket/i.test(source));
const external = (url: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
const WARNINGS = [
  "Only Markdown sources in the configured bundle were inspected. References in code, non-Markdown files, other repositories, external sites, excluded symlink directories and client bookmarks are unmanaged and were not repaired.",
  "Markdown inline links, images and reference definitions are repaired. Literal code and link labels remain unchanged. Affected HTML or frontmatter references require manual reconciliation before moving.",
];

function safePath(path: string): void {
  if (
    !path?.endsWith(".md") ||
    path.includes("\\") ||
    /[\r\n\0]/.test(path) ||
    path.split("/").some((part) => !part || part.startsWith("."))
  )
    throw new DocumentEditError(
      "invalid",
      "Use a visible bundle-relative Markdown path.",
    );
}
function ordinaryPath(path: string): void {
  safePath(path);
  validateDocumentPath(path);
  validateDocumentPath(path.toLowerCase());
  if (
    /^(?:work|decisions|workflows|extensions)\//i.test(path) ||
    path.toLowerCase() === "reference/project-guidance.md"
  )
    throw new DocumentEditError(
      "unsupported",
      "Move only ordinary wiki pages outside owned or tracker locations.",
    );
}
async function safeRead(store: FileStore, path: string): Promise<string> {
  safePath(path);
  if (store instanceof LocalFileStore) {
    const root = await realpath(store.root);
    let target = root;
    for (const part of path.split("/")) {
      target = resolve(target, part);
      if ((await lstat(target)).isSymbolicLink())
        throw new DocumentEditError(
          "unsupported",
          `Move inspection refuses symlink source: ${path}`,
        );
    }
  }
  return store.read(path);
}
function localTarget(
  path: string,
  url: string,
): { path: string; suffix: string; absolute: boolean } | undefined {
  if (!url || external(url) || url.startsWith("#") || url.startsWith("?"))
    return undefined;
  const split = url.search(/[?#]/);
  const raw = split < 0 ? url : url.slice(0, split);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new DocumentEditError(
      "unsupported",
      `Malformed URL escape in ${path}: ${url}`,
    );
  }
  if (decoded.includes("\\") || decoded.includes("\0"))
    throw new DocumentEditError(
      "unsupported",
      `Unsupported local URL in ${path}: ${url}`,
    );
  return {
    path: posix.normalize(
      decoded.startsWith("/")
        ? decoded.slice(1)
        : posix.join(posix.dirname(path), decoded),
    ),
    suffix: split < 0 ? "" : url.slice(split),
    absolute: decoded.startsWith("/"),
  };
}

/** Find only the destination inside an already parsed link/image/definition node. */
function destinationSpan(
  source: string,
  node: Nodes,
): [number, number] | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  let cursor = start;
  if (node.type === "definition") {
    while (cursor < end) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === "]" && source[cursor + 1] === ":") {
        cursor += 2;
        break;
      }
      cursor++;
    }
  } else if (node.type === "link" || node.type === "image") {
    if (node.type === "link")
      cursor = node.children?.at(-1)?.position?.end.offset ?? start;
    while (cursor < end) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === "]" && source[cursor + 1] === "(") {
        cursor += 2;
        break;
      }
      cursor++;
    }
  } else return undefined;
  while (/\s/.test(source[cursor] ?? "") && cursor < end) cursor++;
  const angle = source[cursor] === "<";
  if (angle) cursor++;
  const first = cursor;
  let depth = 0;
  while (cursor < end) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (
      angle
        ? char === ">"
        : /\s/.test(char ?? "") || (char === ")" && depth === 0)
    )
      break;
    if (!angle && char === "(") depth++;
    if (!angle && char === ")") depth--;
    cursor++;
  }
  if (cursor <= first || cursor > end) return undefined;
  // Verify the located token with the same Markdown parser before replacing.
  const raw = source.slice(first, cursor);
  const probe = processor.parse(`[x](${angle ? `<${raw}>` : raw})`).children[0];
  const link = probe?.type === "paragraph" ? probe.children[0] : undefined;
  if (link?.type !== "link" || !("url" in node) || link.url !== node.url)
    return undefined;
  return [first, cursor];
}

interface Replacement {
  path: string;
  line: number;
  from: string;
  to: string;
}
interface Change {
  path: string;
  before: string | null;
  after: string | null;
}
interface MoveData {
  schema: 1;
  from: string;
  to: string;
  version: string;
  snapshot: { path: string; version: string }[];
  changes: Change[];
  replacements: Replacement[];
  blockers: string[];
  warnings: string[];
}
export interface DocumentMovePlan {
  from: string;
  to: string;
  version: string;
  applicable: boolean;
  paths: string[];
  replacements: Replacement[];
  blockers: string[];
  warnings: string[];
}
const publicPlan = (plan: MoveData): DocumentMovePlan => ({
  from: plan.from,
  to: plan.to,
  version: plan.version,
  applicable: plan.blockers.length === 0,
  paths: plan.changes.map((change) => change.path),
  replacements: plan.replacements,
  blockers: plan.blockers,
  warnings: plan.warnings,
});

function repair(
  source: string,
  path: string,
  from: string,
  to: string,
  blockers: string[],
  replacements: Replacement[],
): string {
  const edits: { start: number; end: number; value: string }[] = [];
  const tree = processor.parse(source);
  visit(tree, (node) => {
    if (node.type === "html" || node.type === "yaml") {
      // These forms have no owned link-destination edit contract. Refuse known
      // affected references; disclose all other unmanaged forms in the plan.
      const candidates: string[] = [];
      if (node.type === "html") {
        for (const match of node.value.matchAll(
          /(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
        ))
          candidates.push(match[1] ?? match[2] ?? match[3] ?? "");
      } else {
        const collect = (value: unknown): void => {
          if (typeof value === "string") {
            if (
              /^[^\s]+\.(?:md|png|jpe?g|gif|svg|webp|pdf|html?|txt|csv|json|ya?ml|mp[34]|webm|zip)(?:[?#].*)?$/i.test(
                value,
              )
            )
              candidates.push(value);
            visit(processor.parse(value), (child) => {
              if (
                child.type === "link" ||
                child.type === "image" ||
                child.type === "definition"
              )
                candidates.push(child.url);
            });
          } else if (Array.isArray(value)) value.forEach(collect);
          else if (value && typeof value === "object")
            Object.values(value).forEach(collect);
        };
        try {
          collect(parseYaml(node.value));
        } catch {
          if (node.value.includes(posix.basename(from))) candidates.push(from);
        }
      }
      const affected = candidates.some((url) => {
        const target = localTarget(path, url);
        return (
          target &&
          (target.path === from ||
            (path === from && !target.absolute) ||
            (node.type === "html" && url.includes("&")))
        );
      });
      if (
        affected ||
        node.value.includes(from) ||
        node.value.includes(encoded(from))
      )
        blockers.push(
          `${path}:${node.position?.start.line}: affected ${node.type} reference needs manual reconciliation.`,
        );
      return;
    }
    if (
      node.type !== "link" &&
      node.type !== "image" &&
      node.type !== "definition"
    )
      return;
    const target = localTarget(path, node.url);
    if (!target) return;
    const moved = target.path === from;
    if (!moved && (path !== from || target.absolute)) return;
    if (target.path === ".." || target.path.startsWith("../")) {
      blockers.push(
        `${path}:${node.position?.start.line}: relative target leaves the managed bundle: ${node.url}`,
      );
      return;
    }
    const newPath = moved ? to : target.path;
    const owner = path === from ? to : path;
    const next =
      encoded(
        target.absolute
          ? `/${newPath}`
          : posix.relative(posix.dirname(owner), newPath),
      ) + target.suffix;
    if (next === node.url) return;
    const span = destinationSpan(source, node);
    if (!span) {
      blockers.push(
        `${path}:${node.position?.start.line}: unsupported destination syntax: ${node.url}`,
      );
      return;
    }
    if (owned(path, source)) {
      blockers.push(
        `${path}: incoming reference is in an owned or guidance source.`,
      );
      return;
    }
    edits.push({ start: span[0], end: span[1], value: next });
    replacements.push({
      path,
      line: node.position?.start.line ?? 1,
      from: node.url,
      to: next,
    });
  });
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

async function inspectDestination(
  store: FileStore,
  path: string,
): Promise<void> {
  if (!(store instanceof LocalFileStore)) return;
  let current = await realpath(store.root);
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i] ?? "");
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (i === parts.length - 1)
      throw new DocumentEditError("conflict", "Destination already exists.");
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new DocumentEditError(
        "unsupported",
        "Destination parents must be real bundle directories.",
      );
  }
}

async function buildPlan(
  store: FileStore,
  config: DocketConfig,
  from: string,
  to: string,
): Promise<MoveData> {
  ordinaryPath(from);
  ordinaryPath(to);
  if (from.toLowerCase() === to.toLowerCase())
    throw new DocumentEditError(
      "invalid",
      "Use a different path; title-only changes use document edit. Case-only moves are unsupported.",
    );
  await inspectDestination(store, to);
  const paths = await store.list();
  if (!paths.includes(from))
    throw new DocumentEditError("not_found", "Move source is missing.");
  if (paths.some((path) => path.toLowerCase() === to.toLowerCase()))
    throw new DocumentEditError("conflict", "Destination already exists.");
  const sources = new Map(
    await mapFiles(
      paths,
      async (path) => [path, await safeRead(store, path)] as const,
    ),
  );
  await readEditableDocument(new InMemoryFileStore(sources), config, from);
  const original = sources.get(from) ?? "";
  const concept = parseMetadataConcept(
    from,
    original,
    buildSchemas(config),
  ).concept;
  if (
    concept?.kind !== "generic" ||
    !DOCUMENT_TYPES.includes(
      concept.fm.type as (typeof DOCUMENT_TYPES)[number],
    ) ||
    owned(from, original)
  )
    throw new DocumentEditError(
      "unsupported",
      "Only ordinary Reference, Spec and Playbook sources can move.",
    );
  const blockers: string[] = [];
  const replacements: Replacement[] = [];
  const updated = new Map<string, string>();
  for (const [path, source] of sources)
    updated.set(
      path === from ? to : path,
      repair(source, path, from, to, blockers, replacements),
    );
  const index = applyIndex(
    updated.get("index.md") ?? "",
    renderIndex(await loadBundle(new InMemoryFileStore(updated), config)),
  );
  updated.set("index.md", index);
  const changes: Change[] = [
    { path: to, before: null, after: updated.get(to) ?? "" },
  ];
  for (const [path, source] of updated)
    if (path !== to && sources.get(path) !== source)
      changes.push({ path, before: sources.get(path) ?? null, after: source });
  changes.push({ path: from, before: original, after: null });
  const data = {
    schema: 1 as const,
    from,
    to,
    snapshot: [...sources].map(([path, source]) => ({
      path,
      version: hash(source),
    })),
    changes,
    replacements,
    blockers: [...new Set(blockers)],
    warnings: WARNINGS,
  };
  const version = hash(JSON.stringify({ config, data }));
  return { ...data, version };
}

export async function planDocumentMove(
  store: FileStore,
  config: DocketConfig,
  from: string,
  to: string,
): Promise<DocumentMovePlan> {
  return publicPlan(await buildPlan(store, config, from, to));
}
const token = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z
  .object({
    schema: z.literal(1),
    from: z.string(),
    to: z.string(),
    version: token,
    snapshot: z.array(z.object({ path: z.string(), version: token }).strict()),
    changes: z.array(
      z
        .object({
          path: z.string(),
          before: z.string().nullable(),
          after: z.string().nullable(),
        })
        .strict(),
    ),
    replacements: z.array(
      z
        .object({
          path: z.string(),
          line: z.number(),
          from: z.string(),
          to: z.string(),
        })
        .strict(),
    ),
    blockers: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();
const journalPath = (version: string) => `.docket-moves/${version}.json`;
function requireStore(store: FileStore): void {
  if (!store.createExclusive || !store.readOptional || !store.remove)
    throw new DocumentEditError(
      "unsupported",
      "Store needs exclusive creation, absence detection and removal for recoverable moves.",
    );
}

async function inspectState(store: FileStore, plan: MoveData): Promise<void> {
  const paths = await store.list();
  const allowed = new Set([
    ...plan.snapshot.map((item) => item.path),
    ...plan.changes.map((change) => change.path),
  ]);
  if (paths.some((path) => !allowed.has(path)))
    throw new DocumentEditError(
      "conflict",
      "Bundle inventory changed; new incoming references may exist. Reconcile before recovery.",
    );
  const changes = new Map(plan.changes.map((change) => [change.path, change]));
  for (const path of allowed) {
    const current = paths.includes(path)
      ? await safeRead(store, path)
      : undefined;
    const change = changes.get(path);
    if (
      change
        ? current !== (change.before ?? undefined) &&
          current !== (change.after ?? undefined)
        : current === undefined ||
          hash(current) !==
            plan.snapshot.find((item) => item.path === path)?.version
    )
      throw new DocumentEditError(
        "conflict",
        `Source changed outside this move: ${path}. Originals remain in the recovery journal; reconcile explicitly.`,
      );
  }
}

export interface DocumentMoveResult {
  state: "complete" | "recovery_required";
  from: string;
  to: string;
  paths: string[];
  recoveryToken: string;
  journal: string;
  error?: string;
  nextAction?: string;
  warnings: string[];
}
async function execute(
  store: FileStore,
  plan: MoveData,
): Promise<DocumentMoveResult> {
  const result = {
    from: plan.from,
    to: plan.to,
    paths: plan.changes.map((c) => c.path),
    recoveryToken: plan.version,
    journal: journalPath(plan.version),
    warnings: plan.warnings,
  };
  try {
    await inspectState(store, plan);
    for (const change of plan.changes) {
      const current = await store.readOptional?.(change.path);
      if (current === (change.after ?? undefined)) continue;
      if (current !== (change.before ?? undefined))
        throw new Error(`Source changed during move: ${change.path}`);
      if (change.after === null) {
        const destination = plan.changes[0];
        if (
          !destination ||
          (await safeRead(store, plan.to)) !== destination.after
        )
          throw new Error("Destination changed; original source retained.");
        await store.remove?.(change.path);
      } else if (change.before === null) {
        if (!(await store.createExclusive?.(change.path, change.after)))
          throw new Error(`Destination appeared during move: ${change.path}`);
      } else await store.write(change.path, change.after);
    }
    return { ...result, state: "complete" };
  } catch (error) {
    return {
      ...result,
      state: "recovery_required",
      error: error instanceof Error ? error.message : String(error),
      nextAction: `Run document move-recover ${plan.version}. If any source has unrelated changes, reconcile using the journal's original and planned bytes; never blindly overwrite it. The journal is retained.`,
    };
  }
}

async function recoverUnlocked(
  store: FileStore,
  config: DocketConfig,
  version: string,
): Promise<DocumentMoveResult> {
  requireStore(store);
  token.parse(version);
  const source = await store.readOptional?.(journalPath(version));
  if (!source)
    throw new DocumentEditError("not_found", "Recovery journal is missing.");
  const plan = journalSchema.parse(JSON.parse(source));
  if (plan.version !== version)
    throw new DocumentEditError(
      "invalid",
      "Recovery token does not match journal.",
    );
  ordinaryPath(plan.from);
  ordinaryPath(plan.to);
  for (const entry of [...plan.snapshot, ...plan.changes]) safePath(entry.path);
  if (
    new Set(plan.snapshot.map((entry) => entry.path)).size !==
      plan.snapshot.length ||
    new Set(plan.changes.map((entry) => entry.path)).size !==
      plan.changes.length
  )
    throw new DocumentEditError("invalid", "Duplicate journal paths.");
  await inspectState(store, plan);
  const originals = new Map<string, string>();
  for (const entry of plan.snapshot) {
    const change = plan.changes.find((item) => item.path === entry.path);
    const original = change?.before ?? (await safeRead(store, entry.path));
    if (hash(original) !== entry.version)
      throw new DocumentEditError(
        "invalid",
        "Recovery backup does not match its source version.",
      );
    originals.set(entry.path, original);
  }
  const rebuilt = await buildPlan(
    new InMemoryFileStore(originals),
    config,
    plan.from,
    plan.to,
  );
  if (!isDeepStrictEqual(rebuilt, plan))
    throw new DocumentEditError(
      "invalid",
      "Recovery journal does not match a valid move plan.",
    );
  return execute(store, rebuilt);
}
export async function recoverDocumentMove(
  store: FileStore,
  config: DocketConfig,
  version: string,
): Promise<DocumentMoveResult> {
  return mutate(store, () => recoverUnlocked(store, config, version));
}
export async function applyDocumentMove(
  store: FileStore,
  config: DocketConfig,
  request: unknown,
): Promise<DocumentMoveResult> {
  const input = z
    .object({ from: z.string(), to: z.string(), expectedVersion: token })
    .strict()
    .parse(request);
  return mutate(store, async () => {
    requireStore(store);
    if (await store.readOptional?.(journalPath(input.expectedVersion))) {
      const plan = journalSchema.parse(
        JSON.parse(await store.read(journalPath(input.expectedVersion))),
      );
      if (plan.from !== input.from || plan.to !== input.to)
        throw new DocumentEditError(
          "invalid",
          "Recovery journal belongs to another move.",
        );
      return recoverUnlocked(store, config, input.expectedVersion);
    }
    const plan = await buildPlan(store, config, input.from, input.to);
    if (plan.version !== input.expectedVersion)
      throw new DocumentEditError(
        "conflict",
        "Move plan is stale; inspect a fresh plan before applying.",
      );
    if (plan.blockers.length)
      throw new DocumentEditError("unsupported", plan.blockers.join("\n"));
    if (
      !(await store.createExclusive?.(
        journalPath(plan.version),
        JSON.stringify(plan),
      ))
    )
      throw new DocumentEditError(
        "conflict",
        "Recovery journal appeared; retry with the same plan.",
      );
    return execute(store, plan);
  });
}
