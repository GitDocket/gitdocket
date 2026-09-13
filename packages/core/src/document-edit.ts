import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, parseDocument } from "yaml";
import type { DocketConfig } from "./config";
import { type FileStore, LocalFileStore } from "./filestore";
import { mutate } from "./ops";
import { isReserved, parseMetadataConcept } from "./parse";
import { buildSchemas } from "./schema";

export const DOCUMENT_EDIT_MAX_BYTES = 262_144;
export const DOCUMENT_PROPERTY_MAX_LENGTH = 4_096;
export type DocumentEditCode =
  | "invalid"
  | "unsupported"
  | "too_large"
  | "not_found"
  | "conflict";
export class DocumentEditError extends Error {
  constructor(
    readonly code: DocumentEditCode,
    message: string,
  ) {
    super(message);
  }
}
export interface DocumentPatch {
  title?: string | null;
  description?: string | null;
  body?: string;
}
export interface EditableDocument {
  path: string;
  version: string;
  title: string | null;
  description: string | null;
  body: string;
  maxBytes: number;
}
const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");

export function validateDocumentPath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    !path.endsWith(".md") ||
    path.split("/").some((part) => !part || part.startsWith("."))
  )
    throw new DocumentEditError(
      "invalid",
      "Use a bundle-relative Markdown source path.",
    );
  if (isReserved(path))
    throw new DocumentEditError(
      "unsupported",
      "Indexes, project introductions, briefings and logs are read-only here. Use their source workflow.",
    );
}

async function readSource(store: FileStore, path: string): Promise<string> {
  validateDocumentPath(path);
  try {
    if (store instanceof LocalFileStore) {
      const root = await realpath(store.root);
      const target = await realpath(resolve(root, path));
      const rel = relative(root, target);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
        throw new DocumentEditError("invalid", "Source is outside the bundle.");
    }
    return await store.read(path);
  } catch (error) {
    if (error instanceof DocumentEditError) throw error;
    throw new DocumentEditError(
      "not_found",
      "Source is missing or unreadable. Reopen the source after checking the file.",
    );
  }
}

function inspect(path: string, source: string, config: DocketConfig) {
  if (Buffer.byteLength(source) > DOCUMENT_EDIT_MAX_BYTES)
    throw new DocumentEditError(
      "too_large",
      "Editing supports complete sources up to 256 KiB. Use source viewing or a local editor.",
    );
  if (/<!--\s*(?:>>>|BEGIN).*docket/i.test(source))
    throw new DocumentEditError(
      "unsupported",
      "Generated adapter regions cannot be edited here.",
    );
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(source);
  if (!match)
    throw new DocumentEditError(
      "invalid",
      "Source needs a valid YAML frontmatter block before it can be edited.",
    );
  const yaml = match[2] ?? "";
  const doc = parseDocument(yaml);
  const parsed = parseMetadataConcept(path, source, buildSchemas(config));
  if (
    doc.errors.length ||
    !isMap(doc.contents) ||
    doc.contents.flow ||
    !parsed.concept
  )
    throw new DocumentEditError(
      "invalid",
      "Source has malformed or unsupported frontmatter. Repair it in a local editor.",
    );
  const fields = doc.toJS() as Record<string, unknown>;
  return {
    match,
    yaml,
    doc,
    fields,
    concept: parsed.concept,
    body: source.slice(match[0].length),
    newline: source.startsWith("---\r\n") ? "\r\n" : "\n",
  };
}

function projection(
  path: string,
  source: string,
  config: DocketConfig,
): EditableDocument {
  const parsed = inspect(path, source, config);
  return {
    path,
    version: hash(source),
    title: typeof parsed.fields.title === "string" ? parsed.fields.title : null,
    description:
      typeof parsed.fields.description === "string"
        ? parsed.fields.description
        : null,
    body: parsed.body,
    maxBytes: DOCUMENT_EDIT_MAX_BYTES,
  };
}

export async function readEditableDocument(
  store: FileStore,
  config: DocketConfig,
  path: string,
): Promise<EditableDocument> {
  return projection(path, await readSource(store, path), config);
}

function validatePatch(value: unknown): DocumentPatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DocumentEditError("invalid", "Provide an editable-fields patch.");
  for (const [key, field] of Object.entries(value)) {
    if (
      !["title", "description", "body"].includes(key) ||
      (typeof field !== "string" && !(key !== "body" && field === null))
    )
      throw new DocumentEditError(
        "invalid",
        "Only body, title and description may be edited; properties may be removed with null.",
      );
    if (
      typeof field === "string" &&
      (field.includes("\0") ||
        (key !== "body" && field.length > DOCUMENT_PROPERTY_MAX_LENGTH) ||
        (key === "title" && !field.trim()))
    )
      throw new DocumentEditError(
        "invalid",
        "Use a nonblank title and properties up to 4,096 characters, without NUL characters.",
      );
  }
  return value as DocumentPatch;
}

/** Replace scalar spans, never reserialize the mapping or untouched values. */
function patchSource(
  source: string,
  path: string,
  config: DocketConfig,
  patch: DocumentPatch,
): string {
  const original = inspect(path, source, config);
  let yaml = original.yaml;
  for (const key of ["title", "description"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (
      value === original.fields[key] ||
      (value === null && !(key in original.fields))
    )
      continue;
    const doc = parseDocument(yaml);
    if (!isMap(doc.contents))
      throw new DocumentEditError("invalid", "Expected a YAML mapping.");
    const pair = doc.contents.items.find(
      (entry) => isScalar(entry.key) && entry.key.value === key,
    );
    if (!pair) {
      if (value !== null)
        yaml += `${original.newline}${key}: ${JSON.stringify(value)}`;
      continue;
    }
    if (
      !isScalar(pair.key) ||
      !pair.key.range ||
      !isScalar(pair.value) ||
      !pair.value.range ||
      pair.value.anchor ||
      pair.value.tag ||
      pair.key.anchor ||
      pair.key.tag
    )
      throw new DocumentEditError(
        "unsupported",
        `Edit ${key} in a local editor first; its YAML form is not a plain scalar.`,
      );
    const [start, end] = pair.value.range;
    const keyStart = pair.key.range[0];
    if (keyStart !== 0 && yaml[keyStart - 1] !== "\n")
      throw new DocumentEditError(
        "unsupported",
        "Indented property keys require a local editor.",
      );
    const old = yaml.slice(start, end);
    // Block scalars own the trailing newline; preserve the header comment and separator.
    const block =
      pair.value.type === "BLOCK_FOLDED" || pair.value.type === "BLOCK_LITERAL";
    const comment = block
      ? (old.split(/\r?\n/)[0]?.match(/[ \t]+#.*$/)?.[0] ?? "")
      : "";
    const ending = block && old.endsWith("\n") ? original.newline : "";
    yaml =
      yaml.slice(0, value === null ? keyStart : start) +
      (value === null ? "" : JSON.stringify(value)) +
      comment +
      ending +
      yaml.slice(end);
  }
  const updated = `${original.match[1]}${yaml}${original.match[3]}${patch.body ?? original.body}`;
  const after = inspect(path, updated, config);
  const unowned = (fields: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(fields).filter(
        ([key]) => key !== "title" && key !== "description",
      ),
    );
  if (!isDeepStrictEqual(unowned(original.fields), unowned(after.fields)))
    throw new DocumentEditError(
      "unsupported",
      "This YAML edit would change other metadata. Use a local editor.",
    );
  return updated;
}

export async function editDocument(
  store: FileStore,
  config: DocketConfig,
  path: string,
  request: unknown,
) {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) => !["expectedVersion", "patch"].includes(key),
    )
  )
    throw new DocumentEditError(
      "invalid",
      "Provide expectedVersion and patch only.",
    );
  const { expectedVersion, patch: input } = request as {
    expectedVersion?: unknown;
    patch?: unknown;
  };
  if (
    typeof expectedVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedVersion)
  )
    throw new DocumentEditError(
      "invalid",
      "A complete editable-source version is required.",
    );
  const patch = validatePatch(input);
  return mutate(store, async () => {
    const source = await readSource(store, path);
    if (hash(source) !== expectedVersion)
      throw new DocumentEditError(
        "conflict",
        "Source changed since this draft was opened. Review the latest source and reconcile your draft before retrying.",
      );
    const updated = patchSource(source, path, config, patch);
    if (hash(await readSource(store, path)) !== expectedVersion)
      throw new DocumentEditError(
        "conflict",
        "Source changed during save. Your draft has not been written.",
      );
    const changed = updated !== source;
    if (changed) await store.write(path, updated);
    const concept = inspect(path, updated, config).concept;
    return {
      document: projection(path, updated, config),
      paths: changed ? [path] : [],
      changed,
      taskId: concept.kind === "work" ? concept.fm.id : null,
    };
  });
}

/** Read-only capability projection; saves still revalidate authoritative source. */
export function documentEditingAvailability(
  path: string,
  source: string,
  config: DocketConfig,
): { editable: boolean; reason?: string } {
  try {
    validateDocumentPath(path);
    inspect(path, source, config);
    return { editable: true };
  } catch (error) {
    return {
      editable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
