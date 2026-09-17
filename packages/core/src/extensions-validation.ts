import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseConfig } from "./config";
import type {
  ExtensionDiagnostic,
  ExtensionManifest,
  ExtensionRecord,
  ExtensionRegistry,
  ExtensionScalar,
} from "./extensions-types";
import { isReserved, parseConcept } from "./parse";
import { buildSchemas } from "./schema";

export const EXTENSION_REGISTRY_PATH = "extensions/registry.json";
export const EXTENSION_JOURNAL_PATH = "extensions/.transaction.json";
export const EXTENSION_FILE_LIMIT = 256 * 1024;
export const EXTENSION_PACKAGE_LIMIT = 2 * 1024 * 1024;
export const EXTENSION_INSTALLED_LIMIT = 4 * 1024 * 1024;
export const EXTENSION_REGISTRY_LIMIT = 64 * 1024 * 1024;
export const EXTENSION_JOURNAL_LIMIT = 160 * 1024 * 1024;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const HASH = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z][\x20-\x7e]*$/;
const TOOL = /^[A-Za-z][A-Za-z0-9_.:/-]{0,255}$/;
const parser = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);
const conceptSchemas = buildSchemas(parseConfig());
const idSchema = z.string().max(48).regex(ID);
const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const keySchema = z.string().regex(KEY);
const versionSchema = z.string().regex(VERSION);
const textSchema = z.string().trim().min(1);

const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    id: idSchema.refine((id) => id !== "docket" && !id.startsWith("docket-")),
    version: versionSchema,
    title: textSchema,
    description: textSchema,
    engine: z
      .object({ min: versionSchema, maxExclusive: versionSchema })
      .strict(),
    files: z.array(z.string()).min(1).max(99),
    workflows: z
      .array(
        z
          .object({
            id: idSchema,
            title: textSchema,
            description: textSchema,
            path: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(99),
    guidance: z.array(z.string()).max(99),
    defaults: z.record(keySchema, scalarSchema),
    capabilities: z.array(
      z
        .object({
          id: idSchema,
          description: textSchema,
          access: z.enum(["read", "write"]),
          recipe: z.string(),
        })
        .strict(),
    ),
    scenarios: z.array(z.string()).max(99),
  })
  .strict();

const recordSchema = z
  .object({
    manifest: manifestSchema,
    digest: z.string().regex(HASH),
    base: z.record(z.string(), z.string()),
    status: z.enum(["installed", "removed"]),
    requestedEnabled: z.boolean(),
    config: z.record(keySchema, scalarSchema),
    bindings: z.record(idSchema, z.string().regex(TOOL)),
    reviewedLocal: z.record(z.string(), z.string().regex(HASH)),
    retainedFiles: z.record(
      z.string(),
      z
        .object({
          base: z.string(),
          // Read legacy/missing evidence to report unknown provenance; never
          // manufacture a trusted hash from the bytes it is meant to verify.
          baseHash: z.string().regex(HASH).optional(),
          sourceVersion: versionSchema,
          sourceDigest: z.string().regex(HASH),
        })
        .strict(),
    ),
    source: z.string().optional(),
  })
  .strict();

const registrySchema = z
  .object({
    formatVersion: z.literal(1),
    packages: z.record(idSchema, recordSchema),
  })
  .strict();

const operationSchema = z.union([
  z
    .object({
      kind: z.literal("install"),
      source: z.string().min(1),
      enable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ kind: z.enum(["enable", "disable", "remove"]), id: idSchema })
    .strict(),
  z
    .object({
      kind: z.literal("configure"),
      id: idSchema,
      set: z.record(keySchema, scalarSchema).optional(),
      bindings: z.record(idSchema, z.string().regex(TOOL)).optional(),
      reset: z.array(keySchema).optional(),
      unbind: z.array(idSchema).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("recover") }).strict(),
  z
    .object({
      kind: z.literal("update"),
      id: idSchema,
      source: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconcile"),
      id: idSchema,
      acknowledgeLocal: z.literal(true),
    })
    .strict(),
]);

export function validateExtensionOperation(
  operation: unknown,
): ExtensionDiagnostic[] {
  const parsed = operationSchema.safeParse(operation);
  return parsed.success
    ? []
    : [
        extensionDiagnostic(
          "invalid-operation",
          parsed.error.message,
          undefined,
          "Use a documented lifecycle operation with plain JSON choice/binding objects and declared identifiers.",
        ),
      ];
}

export function extensionDiagnostic(
  code: string,
  message: string,
  path?: string,
  remediation = "Inspect the reported source and restore or correct it before retrying.",
  severity: ExtensionDiagnostic["severity"] = "error",
): ExtensionDiagnostic {
  return { code, message, ...(path ? { path } : {}), severity, remediation };
}

export function hasExtensionErrors(
  diagnostics: ExtensionDiagnostic[],
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function extensionHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function extensionDigest(
  manifest: ExtensionManifest,
  files: Record<string, string>,
): string {
  const entries = Object.keys(files)
    .sort()
    .map((path) => [path, files[path]]);
  return extensionHash(JSON.stringify([canonical(manifest), entries]));
}

export function validExtensionPath(path: string): boolean {
  return (
    path.length <= 1024 &&
    !isReserved(path.toLowerCase()) &&
    !path.includes("\\") &&
    !hasControlCharacters(path) &&
    /^(workflows|templates|guidance|recipes|scenarios)\/.+\.md$/.test(path) &&
    path.split("/").every((part) => part.length > 0 && !part.startsWith("."))
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
}

export function extensionVersionCompare(a: string, b: string): number {
  const left = a.split(".").map(BigInt);
  const right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i])
      return (left[i] ?? 0n) < (right[i] ?? 0n) ? -1 : 1;
  }
  return 0;
}

export function extensionCompatibility(
  manifest: ExtensionManifest,
  engineVersion: string,
  diagnostics: ExtensionDiagnostic[],
): "compatible" | "incompatible" | "indeterminate" {
  const release = engineVersion.split("-")[0] ?? "";
  if (
    !VERSION.test(release) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(engineVersion)
  ) {
    diagnostics.push(
      extensionDiagnostic(
        "engine-version",
        `Cannot compare engine version ${engineVersion}.`,
        "extension.json",
      ),
    );
    return "indeterminate";
  }
  if (
    extensionVersionCompare(release, manifest.engine.min) < 0 ||
    extensionVersionCompare(release, manifest.engine.maxExclusive) >= 0
  ) {
    diagnostics.push(
      extensionDiagnostic(
        "incompatible-engine",
        `Package requires engine >= ${manifest.engine.min} and < ${manifest.engine.maxExclusive}; current engine is ${engineVersion}.`,
        "extension.json",
        "Use a compatible package/engine release or restore the project from a known-good Git revision.",
      ),
    );
    return "incompatible";
  }
  return "compatible";
}

function unique(
  values: string[],
  label: string,
  diagnostics: ExtensionDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.normalize("NFC").toLowerCase();
    if (seen.has(key))
      diagnostics.push(
        extensionDiagnostic(
          "duplicate-name",
          `Duplicate ${label}: ${value}.`,
          "extension.json",
        ),
      );
    seen.add(key);
  }
}

export function parseExtensionManifest(
  raw: unknown,
  diagnostics: ExtensionDiagnostic[],
): ExtensionManifest | null {
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues)
      diagnostics.push(
        extensionDiagnostic(
          "invalid-manifest",
          `${issue.path.join(".") || "manifest"}: ${issue.message}`,
          "extension.json",
        ),
      );
    return null;
  }
  // Keep exact scalar values, including authored title whitespace, for identity.
  const manifest = raw as ExtensionManifest;
  for (const path of manifest.files) {
    if (!validExtensionPath(path))
      diagnostics.push(
        extensionDiagnostic(
          "invalid-path",
          `Unsupported package path: ${path}.`,
          path,
        ),
      );
  }
  unique(manifest.files, "file path", diagnostics);
  unique(
    manifest.workflows.map((entry) => entry.id),
    "workflow ID",
    diagnostics,
  );
  unique(
    manifest.capabilities.map((entry) => entry.id),
    "capability ID",
    diagnostics,
  );
  unique(manifest.guidance, "guidance path", diagnostics);
  unique(manifest.scenarios, "scenario path", diagnostics);
  const references = [
    ...manifest.workflows.map((entry) => ({
      path: entry.path,
      root: "workflows/",
    })),
    ...manifest.guidance.map((path) => ({ path, root: "guidance/" })),
    ...manifest.capabilities.map((entry) => ({
      path: entry.recipe,
      root: "recipes/",
    })),
    ...manifest.scenarios.map((path) => ({ path, root: "scenarios/" })),
  ];
  for (const { path, root } of references) {
    if (!manifest.files.includes(path) || !path.startsWith(root))
      diagnostics.push(
        extensionDiagnostic(
          "undeclared-entrypoint",
          `${path} must be a declared file under ${root}.`,
          "extension.json",
        ),
      );
  }
  if (
    extensionVersionCompare(
      manifest.engine.min,
      manifest.engine.maxExclusive,
    ) >= 0
  )
    diagnostics.push(
      extensionDiagnostic(
        "invalid-engine-range",
        "Engine minimum must precede its exclusive maximum.",
        "extension.json",
      ),
    );
  return manifest;
}

export function parseExtensionRegistry(
  text: string,
  diagnostics: ExtensionDiagnostic[],
): ExtensionRegistry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    diagnostics.push(
      extensionDiagnostic(
        "invalid-registry",
        `Registry is not valid JSON: ${String(error)}`,
        EXTENSION_REGISTRY_PATH,
        "Restore the registry and package sources together from known-good Git history; do not reconstruct provenance from current stamps.",
      ),
    );
    return null;
  }
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      diagnostics.push(
        extensionDiagnostic(
          "invalid-registry",
          `${issue.path.join(".") || "registry"}: ${issue.message}`,
          EXTENSION_REGISTRY_PATH,
        ),
      );
    return null;
  }
  return raw as ExtensionRegistry;
}

export function validateExtensionRecord(
  id: string,
  record: ExtensionRecord,
  diagnostics: ExtensionDiagnostic[],
): void {
  const manifestDiagnostics: ExtensionDiagnostic[] = [];
  parseExtensionManifest(record.manifest, manifestDiagnostics);
  diagnostics.push(...manifestDiagnostics);
  if (record.manifest.id !== id)
    diagnostics.push(
      extensionDiagnostic(
        "ownership-mismatch",
        `Registry key ${id} differs from package ID ${record.manifest.id}.`,
        EXTENSION_REGISTRY_PATH,
      ),
    );
  if (
    JSON.stringify(Object.keys(record.base).sort()) !==
    JSON.stringify([...record.manifest.files].sort())
  )
    diagnostics.push(
      extensionDiagnostic(
        "unknown-base",
        "Recorded base paths do not match the exact manifest.",
        EXTENSION_REGISTRY_PATH,
      ),
    );
  if (extensionDigest(record.manifest, record.base) !== record.digest)
    diagnostics.push(
      extensionDiagnostic(
        "unknown-base",
        "Recorded manifest/base content does not match the package digest.",
        EXTENSION_REGISTRY_PATH,
        "Restore the original manifest/base and matching content from known-good Git/source history; acknowledgment cannot repair provenance.",
      ),
    );
  for (const [path, retained] of Object.entries(record.retainedFiles))
    if (
      !retained.baseHash ||
      extensionHash(retained.base) !== retained.baseHash
    )
      diagnostics.push(
        extensionDiagnostic(
          "unknown-base",
          "Retained base bytes have missing or mismatched independent hash evidence.",
          `extensions/${id}/${path}`,
          "Restore this historical base and its recorded hash together from known-good Git/source history. Never certify unknown bytes by recomputing a replacement hash.",
        ),
      );
  const allPaths = [
    ...record.manifest.files,
    ...Object.keys(record.retainedFiles),
  ];
  unique(allPaths, "owned path", diagnostics);
  for (const path of allPaths)
    if (!validExtensionPath(path))
      diagnostics.push(
        extensionDiagnostic(
          "invalid-path",
          `Invalid owned package path ${path}.`,
          EXTENSION_REGISTRY_PATH,
        ),
      );
  for (const path of Object.keys(record.reviewedLocal))
    if (!allPaths.includes(path))
      diagnostics.push(
        extensionDiagnostic(
          "unknown-review-path",
          `Reviewed path ${path} is not owned by this package.`,
          EXTENSION_REGISTRY_PATH,
        ),
      );
  const bases = [
    ...Object.values(record.base),
    ...Object.values(record.retainedFiles).map((file) => file.base),
  ];
  if (
    allPaths.length > 200 ||
    bases.reduce((size, text) => size + Buffer.byteLength(text), 0) >
      EXTENSION_INSTALLED_LIMIT ||
    bases.some((text) => Buffer.byteLength(text) > EXTENSION_FILE_LIMIT)
  )
    diagnostics.push(
      extensionDiagnostic(
        "content-limit",
        "Recorded package history exceeds 200 paths, 4 MiB total, or 256 KiB per file.",
        EXTENSION_REGISTRY_PATH,
      ),
    );
  diagnostics.push(
    ...validateExtensionChoices(
      record.manifest,
      record.config,
      record.bindings,
    ),
  );
}

export function validateExtensionChoices(
  manifest: ExtensionManifest,
  config: Record<string, ExtensionScalar>,
  bindings: Record<string, string>,
): ExtensionDiagnostic[] {
  const diagnostics: ExtensionDiagnostic[] = [];
  for (const [key, value] of Object.entries(config)) {
    const base = manifest.defaults[key];
    if (
      !Object.hasOwn(manifest.defaults, key) ||
      !scalarSchema.safeParse(value).success ||
      (value === null
        ? base !== null
        : base === null || typeof value !== typeof base)
    )
      diagnostics.push(
        extensionDiagnostic(
          "invalid-configuration",
          `${key} must be a declared default with the same finite JSON scalar type.`,
          EXTENSION_REGISTRY_PATH,
          "Reset the incompatible override or supply a declared value of the same type.",
        ),
      );
  }
  for (const [key, value] of Object.entries(bindings)) {
    if (
      !manifest.capabilities.some((capability) => capability.id === key) ||
      typeof value !== "string" ||
      !TOOL.test(value)
    )
      diagnostics.push(
        extensionDiagnostic(
          "invalid-binding",
          `${key} must name a declared capability and one explicit host-tool identifier.`,
          EXTENSION_REGISTRY_PATH,
          "Unbind the capability or supply its exact existing host-tool identifier; never include credentials or server configuration.",
        ),
      );
  }
  return diagnostics;
}

export function absentExtensionFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Check every component beneath an explicit root; never follow package links. */
export async function assertExtensionPath(
  root: string,
  path: string,
  allowMissing = false,
): Promise<void> {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  )
    throw new Error(`Unsafe relative path: ${path}`);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error(`Root must be a real directory: ${root}`);
  let current = resolve(root);
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    // Diagnose casing aliases even on a case-sensitive host before a clone
    // reaches a case-insensitive one.
    const names = await readdir(current);
    if (
      names.filter(
        (name) =>
          name.normalize("NFC").toLowerCase() ===
          part.normalize("NFC").toLowerCase(),
      ).length > 1 ||
      names.some(
        (name) =>
          name.normalize("NFC") !== part.normalize("NFC") &&
          name.normalize("NFC").toLowerCase() ===
            part.normalize("NFC").toLowerCase(),
      )
    )
      throw new Error(
        `Case-insensitive path collision: ${join(current, part)}`,
      );
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(`Symlinks are unsupported: ${current}`);
      if (i < parts.length - 1 && !info.isDirectory())
        throw new Error(`Not a directory: ${current}`);
      if (i === parts.length - 1 && !info.isFile() && !info.isDirectory())
        throw new Error(`Not a regular file or directory: ${current}`);
    } catch (error) {
      if (allowMissing && absentExtensionFile(error)) return;
      throw error;
    }
  }
}

export async function readExtensionText(
  root: string,
  path: string,
  maxBytes: number,
  markdown = false,
): Promise<string> {
  await assertExtensionPath(root, path);
  const info = await lstat(join(root, path));
  if (!info.isFile() || (markdown && (info.mode & 0o111) !== 0))
    throw new Error(
      `Expected a non-executable regular ${markdown ? "Markdown " : ""}file: ${path}`,
    );
  if (info.size > maxBytes)
    throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
  const bytes = await readFile(join(root, path));
  if (bytes.length > maxBytes)
    throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}

export async function maybeExtensionText(
  root: string,
  path: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    return await readExtensionText(root, path, maxBytes);
  } catch (error) {
    if (absentExtensionFile(error)) return null;
    throw error;
  }
}

export async function extensionTree(
  root: string,
  maximum = 201,
  ownedPaths: string[] = [],
): Promise<string[]> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`Package root must be a real directory: ${root}`);
  const files: string[] = [];
  let entriesSeen = 0;
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), {
      withFileTypes: true,
    });
    if (
      relative &&
      !entries.length &&
      !ownedPaths.some((path) => path.startsWith(`${relative}/`))
    )
      throw new Error(`Undeclared empty package directory: ${relative}`);
    const names = new Set<string>();
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > maximum * 8)
        throw new Error("Package tree exceeds bounded path traversal.");
      const nameKey = entry.name.normalize("NFC").toLowerCase();
      if (entry.name.startsWith(".") || names.has(nameKey))
        throw new Error(`Hidden or case-colliding package path: ${entry.name}`);
      names.add(nameKey);
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        files.push(path);
        if (files.length > maximum)
          throw new Error(`Package has more than ${maximum} files.`);
      } else throw new Error(`Symlink or nonregular package path: ${path}`);
    }
  }
  await walk("");
  return files.sort();
}

/** Source validation is separate from provenance: local changes can be valid
 * Markdown while still requiring explicit adaptation review. */
export async function validateExtensionSources(
  manifest: ExtensionManifest,
  files: Record<string, string>,
  bundleRoot: string,
  packagePrefix = "",
  retained: Record<string, string> = {},
  historical = false,
): Promise<ExtensionDiagnostic[]> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const entries = new Set(manifest.workflows.map((entry) => entry.path));
  const all = { ...retained, ...files };
  for (const [path, source] of Object.entries(files)) {
    if (Buffer.byteLength(source) > EXTENSION_FILE_LIMIT) {
      diagnostics.push(
        extensionDiagnostic(
          "content-limit",
          "Markdown source exceeds 256 KiB.",
          path,
        ),
      );
      continue;
    }
    const tree = parser.parse(source);
    if (source.startsWith("\uFEFF"))
      diagnostics.push(
        extensionDiagnostic(
          "unsupported-bom",
          "A leading UTF-8 BOM is not supported by ordinary document editing; package bytes were not rewritten.",
          path,
          "Review and save the source as UTF-8 without a BOM, then inspect the new exact content identity.",
        ),
      );
    const canonical = parseConcept(path, source, conceptSchemas);
    diagnostics.push(
      ...canonical.diagnostics.map((entry) =>
        extensionDiagnostic("invalid-concept", entry.message, path),
      ),
    );
    const first = tree.children[0];
    let fm: Record<string, unknown> | null = null;
    if (first?.type === "yaml") {
      try {
        const parsed: unknown = parseYaml(first.value);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        )
          fm = parsed as Record<string, unknown>;
      } catch {
        /* Report the bounded concept diagnostic below. */
      }
    }
    if (
      !fm ||
      typeof fm.title !== "string" ||
      !fm.title.trim() ||
      typeof fm.description !== "string" ||
      !fm.description.trim() ||
      (historical
        ? !["Workflow", "Reference", "Playbook"].includes(String(fm.type))
        : entries.has(path)
          ? fm.type !== "Workflow"
          : fm.type !== "Reference" && fm.type !== "Playbook")
    )
      diagnostics.push(
        extensionDiagnostic(
          "invalid-concept",
          `Expected title/description and type ${historical ? "Workflow, Reference or Playbook" : entries.has(path) ? "Workflow" : "Reference or Playbook"}.`,
          path,
        ),
      );
    if (/<!--\s*(?:>>>|BEGIN).*docket/i.test(source))
      diagnostics.push(
        extensionDiagnostic(
          "generated-content",
          "Package concepts must remain editable ordinary sources, without generated adapter regions.",
          path,
        ),
      );
    const lifecycle = [
      "id",
      "status",
      "epic",
      "depends_on",
      "priority",
      "rank",
      "assignee",
      "spec",
      "supersedes",
    ];
    if (fm && lifecycle.some((key) => Object.hasOwn(fm, key)))
      diagnostics.push(
        extensionDiagnostic(
          "lifecycle-content",
          "Package concepts cannot carry project work/decision IDs or lifecycle fields.",
          path,
        ),
      );
    const targets: string[] = [];
    visit(tree, ["link", "image", "definition"], (node) => {
      if ("url" in node && typeof node.url === "string") targets.push(node.url);
    });
    for (const target of targets) {
      if (
        /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target) ||
        target.startsWith("#")
      )
        continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(target.split(/[?#]/)[0] ?? "");
      } catch {
        diagnostics.push(
          extensionDiagnostic(
            "invalid-link",
            `Malformed link ${target}.`,
            path,
          ),
        );
        continue;
      }
      if (!decoded) continue;
      if (decoded.includes("\\") || hasControlCharacters(decoded)) {
        diagnostics.push(
          extensionDiagnostic(
            "invalid-link",
            `Unsafe local link ${target}.`,
            path,
          ),
        );
        continue;
      }
      if (!decoded.startsWith("/")) {
        const local = posix.normalize(posix.join(posix.dirname(path), decoded));
        if (!validExtensionPath(local) || !Object.hasOwn(all, local))
          diagnostics.push(
            extensionDiagnostic(
              "broken-link",
              `Relative link ${target} must resolve to declared package content.`,
              path,
            ),
          );
        continue;
      }
      const local = decoded.slice(1);
      if (packagePrefix && local.startsWith(`${packagePrefix}/`)) {
        if (!Object.hasOwn(all, local.slice(packagePrefix.length + 1)))
          diagnostics.push(
            extensionDiagnostic(
              "broken-link",
              `Owned package link ${target} does not resolve to valid current or retained content.`,
              path,
            ),
          );
        continue;
      }
      try {
        await assertExtensionPath(bundleRoot, local);
        const targetText = await readExtensionText(
          bundleRoot,
          local,
          EXTENSION_FILE_LIMIT,
          true,
        );
        const targetTree = parser.parse(targetText);
        if (targetTree.children[0]?.type !== "yaml")
          throw new Error("Target is not an ordinary concept.");
      } catch (error) {
        diagnostics.push(
          extensionDiagnostic(
            "broken-link",
            `Bundle link ${target} does not resolve to a readable concept: ${String(error)}`,
            path,
          ),
        );
      }
    }
  }
  return diagnostics;
}
