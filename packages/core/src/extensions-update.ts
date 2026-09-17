import { isDeepStrictEqual } from "node:util";
import type {
  ExtensionDiagnostic,
  ExtensionManifest,
  ExtensionRecord,
} from "./extensions-types";
import {
  extensionDiagnostic as diagnostic,
  extensionDigest,
  extensionHash,
  extensionVersionCompare,
  validateExtensionRecord,
} from "./extensions-validation";

export interface ExtensionContentEntry {
  path: string;
  before: string | null;
  after: string | null;
}

export function ownedExtensionPaths(record: ExtensionRecord): string[] {
  return [
    ...record.manifest.files,
    ...Object.keys(record.retainedFiles),
  ].sort();
}

/** Pure conservative transition used by planning and untrusted journal recovery.
 * Every owned path is retained as an exact-before guard, including unchanged
 * adaptations and missing inactive history. No update deletes content. */
export function planExtensionUpdate(
  previous: ExtensionRecord,
  current: Record<string, string | null>,
  manifest: ExtensionManifest,
  files: Record<string, string>,
  source = previous.source,
): {
  record: ExtensionRecord;
  entries: ExtensionContentEntry[];
  diagnostics: ExtensionDiagnostic[];
} {
  const diagnostics: ExtensionDiagnostic[] = [];
  validateExtensionRecord(previous.manifest.id, previous, diagnostics);
  const record = structuredClone(previous);
  const id = previous.manifest.id;
  const digest = extensionDigest(manifest, files);
  const comparison = extensionVersionCompare(
    manifest.version,
    previous.manifest.version,
  );
  if (manifest.id !== id)
    diagnostics.push(
      diagnostic(
        "package-id-mismatch",
        `Candidate ${manifest.id} does not update ${id}.`,
        "extension.json",
      ),
    );
  if (comparison < 0 || (comparison === 0 && digest !== previous.digest))
    diagnostics.push(
      diagnostic(
        comparison < 0 ? "package-downgrade" : "republished-version",
        "Update requires a strictly newer package version or identical content identity.",
        "extension.json",
        "Use a reviewed newer candidate; restore the entire prior project from Git for a downgrade.",
      ),
    );
  if (comparison === 0 && digest === previous.digest && manifest.id === id)
    return { record, entries: [], diagnostics };
  record.manifest = structuredClone(manifest);
  record.base = structuredClone(files);
  record.digest = digest;
  if (source !== undefined) record.source = source;
  const paths = [
    ...new Set([...ownedExtensionPaths(previous), ...manifest.files]),
  ].sort();
  const entries: ExtensionContentEntry[] = [];
  const conflict = (path: string, message: string) =>
    diagnostics.push(
      diagnostic(
        "update-conflict",
        message,
        `extensions/${id}/${path}`,
        "Preserve project adaptations in Git and review a compatible candidate or restore the recorded base before retrying. No candidate changes were applied.",
      ),
    );
  for (const path of paths) {
    const before = current[path] ?? null;
    let after = before;
    const wasActive = Object.hasOwn(previous.base, path);
    const tombstone = Object.hasOwn(previous.retainedFiles, path)
      ? previous.retainedFiles[path]
      : undefined;
    const isActive = Object.hasOwn(files, path);
    if (isActive) {
      const next = files[path] as string;
      if (wasActive) {
        if (before === previous.base[path]) after = next;
        else if (before === null || next !== previous.base[path])
          conflict(
            path,
            "Both project content and upstream content changed, or active source is missing.",
          );
      } else if (tombstone) {
        if (before === tombstone.base || before === next) after = next;
        else
          conflict(
            path,
            "Reintroduced retained source differs from its tombstone base and candidate bytes.",
          );
      } else if (before !== null) {
        conflict(
          path,
          "Candidate destination already contains unowned content.",
        );
      } else after = next;
      delete record.retainedFiles[path];
    } else if (wasActive) {
      if (before !== previous.base[path])
        conflict(
          path,
          "Upstream removed a locally edited or missing active source.",
        );
      record.retainedFiles[path] = {
        base: previous.base[path] as string,
        baseHash: extensionHash(previous.base[path] as string),
        sourceVersion: previous.manifest.version,
        sourceDigest: previous.digest,
      };
    }
    const hash = after === null ? null : extensionHash(after);
    const base = isActive ? files[path] : record.retainedFiles[path]?.base;
    if (hash === null || hash !== record.reviewedLocal[path] || after === base)
      delete record.reviewedLocal[path];
    entries.push({ path: `extensions/${id}/${path}`, before, after });
  }
  validateExtensionRecord(id, record, diagnostics);
  for (const entry of diagnostics)
    if (entry.code === "content-limit")
      entry.remediation =
        "Preserve/archive historical project state in Git and choose a separately reviewed new package identity. Updates never purge retained history.";
  return { record, entries, diagnostics };
}

export function planExtensionReconciliation(
  previous: ExtensionRecord,
  current: Record<string, string | null>,
) {
  const record = structuredClone(previous);
  record.reviewedLocal = {};
  const entries = ownedExtensionPaths(previous).map((path) => {
    const text = current[path] ?? null;
    const base = previous.base[path] ?? previous.retainedFiles[path]?.base;
    if (text !== null && text !== base)
      record.reviewedLocal[path] = extensionHash(text);
    return {
      path: `extensions/${previous.manifest.id}/${path}`,
      before: text,
      after: text,
    };
  });
  return { record, entries, changed: !isDeepStrictEqual(record, previous) };
}
