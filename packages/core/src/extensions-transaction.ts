import { randomUUID } from "node:crypto";
import { mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  ExtensionDiagnostic,
  ExtensionRegistry,
} from "./extensions-types";
import {
  type ExtensionContentEntry,
  planExtensionReconciliation,
  planExtensionUpdate,
} from "./extensions-update";
import {
  absentExtensionFile,
  assertExtensionPath,
  extensionDiagnostic as diagnostic,
  EXTENSION_FILE_LIMIT,
  EXTENSION_JOURNAL_LIMIT,
  EXTENSION_JOURNAL_PATH,
  EXTENSION_REGISTRY_LIMIT,
  EXTENSION_REGISTRY_PATH,
  extensionHash,
  hasExtensionErrors,
  maybeExtensionText,
  parseExtensionRegistry,
  validateExtensionRecord,
} from "./extensions-validation";

export interface ExtensionJournal {
  formatVersion: 1;
  kind:
    | "install"
    | "enable"
    | "configure"
    | "disable"
    | "remove"
    | "update"
    | "reconcile";
  id: string;
  entries: { path: string; before: string | null; after: string | null }[];
}

const journalSchema = z
  .object({
    formatVersion: z.literal(1),
    kind: z.enum([
      "install",
      "enable",
      "configure",
      "disable",
      "remove",
      "update",
      "reconcile",
    ]),
    id: z
      .string()
      .max(48)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    entries: z
      .array(
        z
          .object({
            path: z.string(),
            before: z.string().nullable(),
            after: z.string().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(201),
  })
  .strict();

interface RecoveryResult {
  ok: boolean;
  changed: boolean;
  affectedPaths: string[];
  diagnostics: ExtensionDiagnostic[];
  registry?: ExtensionRegistry;
  registryText?: string | null;
  files?: Record<string, string | null>;
}

/** Internal publication seam also allows deterministic disk-failure tests. */
export async function publishExtensionText(
  root: string,
  path: string,
  text: string,
  expectedBefore?: string | null,
): Promise<void> {
  await assertExtensionPath(root, path, true);
  await mkdir(join(root, "extensions"), { recursive: true });
  // Stage outside package directories. An interrupted pre-rename staging file
  // cannot masquerade as declared content or prevent source-history recovery.
  const temporary = join(root, "extensions", `.write-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await mkdir(dirname(join(root, path)), { recursive: true });
    await assertExtensionPath(root, path, true);
    if (
      expectedBefore !== undefined &&
      (await maybeExtensionText(
        root,
        path,
        path === EXTENSION_REGISTRY_PATH
          ? EXTENSION_REGISTRY_LIMIT
          : path === EXTENSION_JOURNAL_PATH
            ? EXTENSION_JOURNAL_LIMIT
            : EXTENSION_FILE_LIMIT,
      )) !== expectedBefore
    )
      throw new Error(`Unexpected concurrent edit during publication: ${path}`);
    await rename(temporary, join(root, path));
  } finally {
    // A leftover staging file has no authority; preserve the original write
    // failure rather than replacing it with a best-effort cleanup error.
    await unlink(temporary).catch(() => undefined);
  }
}

function parseJournal(
  text: string,
  diagnostics: ExtensionDiagnostic[],
): ExtensionJournal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "invalid-journal",
        `Invalid transaction JSON: ${String(error)}`,
        EXTENSION_JOURNAL_PATH,
      ),
    );
    return null;
  }
  const parsed = journalSchema.safeParse(raw);
  if (!parsed.success) {
    diagnostics.push(
      diagnostic(
        "invalid-journal",
        parsed.error.message,
        EXTENSION_JOURNAL_PATH,
      ),
    );
    return null;
  }
  return parsed.data;
}

function registryFor(
  text: string | null,
  diagnostics: ExtensionDiagnostic[],
): ExtensionRegistry | null {
  if (text === null) return { formatVersion: 1, packages: {} };
  if (Buffer.byteLength(text) > EXTENSION_REGISTRY_LIMIT) {
    diagnostics.push(
      diagnostic(
        "invalid-journal",
        "Journal registry snapshot exceeds its bounded limit.",
        EXTENSION_JOURNAL_PATH,
      ),
    );
    return null;
  }
  const registry = parseExtensionRegistry(text, diagnostics);
  if (registry)
    for (const [id, record] of Object.entries(registry.packages))
      validateExtensionRecord(id, record, diagnostics);
  return registry;
}

/** A journal is untrusted data: its registry snapshots must prove ownership
 * and the supported transition before any path becomes a rollback target. */
async function validateJournal(
  root: string,
  journal: ExtensionJournal,
  expected: "before" | "either",
  diagnostics: ExtensionDiagnostic[],
): Promise<{ registry: ExtensionRegistry; text: string | null } | null> {
  const registryEntries = journal.entries.filter(
    (entry) => entry.path === EXTENSION_REGISTRY_PATH,
  );
  const registryEntry = registryEntries[0];
  if (
    registryEntries.length !== 1 ||
    !registryEntry ||
    registryEntry.after === null ||
    journal.entries.at(-1)?.path !== EXTENSION_REGISTRY_PATH
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-journal",
        "A transaction must end with exactly one retained registry write.",
        EXTENSION_JOURNAL_PATH,
      ),
    );
    return null;
  }
  const before = registryFor(registryEntry.before, diagnostics);
  const after = registryFor(registryEntry.after, diagnostics);
  if (!before || !after || hasExtensionErrors(diagnostics)) return null;
  const oldRecord = Object.hasOwn(before.packages, journal.id)
    ? before.packages[journal.id]
    : undefined;
  const newRecord = Object.hasOwn(after.packages, journal.id)
    ? after.packages[journal.id]
    : undefined;
  if (!newRecord)
    diagnostics.push(
      diagnostic(
        "invalid-journal",
        "Target package is not owned by the resulting registry.",
        EXTENSION_JOURNAL_PATH,
      ),
    );
  const othersBefore = Object.fromEntries(
    Object.entries(before.packages).filter(([id]) => id !== journal.id),
  );
  const othersAfter = Object.fromEntries(
    Object.entries(after.packages).filter(([id]) => id !== journal.id),
  );
  if (!isDeepStrictEqual(othersBefore, othersAfter))
    diagnostics.push(
      diagnostic(
        "invalid-journal",
        "Transaction changes unrelated package ownership.",
        EXTENSION_JOURNAL_PATH,
      ),
    );
  let contentPlan: ExtensionContentEntry[] = [];
  if (journal.kind === "install") {
    if (
      oldRecord ||
      !newRecord ||
      newRecord.status !== "installed" ||
      Object.keys(newRecord.config).length ||
      Object.keys(newRecord.bindings).length ||
      Object.keys(newRecord.reviewedLocal).length ||
      Object.keys(newRecord.retainedFiles).length
    )
      diagnostics.push(
        diagnostic(
          "invalid-journal",
          "Installation journal does not represent a fresh owned package.",
          EXTENSION_JOURNAL_PATH,
        ),
      );
  } else if (!oldRecord || !newRecord) {
    diagnostics.push(
      diagnostic(
        "invalid-journal",
        "Lifecycle journal has no prior package ownership.",
        EXTENSION_JOURNAL_PATH,
      ),
    );
  } else {
    let expectedRecord = structuredClone(oldRecord);
    if (journal.kind === "update" || journal.kind === "reconcile") {
      const current = Object.fromEntries(
        journal.entries
          .filter((entry) => entry.path !== EXTENSION_REGISTRY_PATH)
          .map((entry) => [
            entry.path.slice(`extensions/${journal.id}/`.length),
            entry.before,
          ]),
      );
      if (journal.kind === "update") {
        const planned = planExtensionUpdate(
          oldRecord,
          current,
          newRecord.manifest,
          newRecord.base,
          newRecord.source,
        );
        diagnostics.push(...planned.diagnostics);
        expectedRecord = planned.record;
        contentPlan = planned.entries;
        if (!contentPlan.length)
          diagnostics.push(
            diagnostic(
              "invalid-journal",
              "Identical updates do not publish a transaction.",
              EXTENSION_JOURNAL_PATH,
            ),
          );
      } else {
        const planned = planExtensionReconciliation(oldRecord, current);
        expectedRecord = planned.record;
        contentPlan = planned.entries;
      }
    } else if (journal.kind === "configure") {
      expectedRecord.config = newRecord.config;
      expectedRecord.bindings = newRecord.bindings;
    } else if (journal.kind === "enable") {
      expectedRecord.requestedEnabled = true;
      expectedRecord.status = "installed";
    } else {
      expectedRecord.requestedEnabled = false;
      if (journal.kind === "remove") expectedRecord.status = "removed";
    }
    if (!isDeepStrictEqual(expectedRecord, newRecord))
      diagnostics.push(
        diagnostic(
          "invalid-journal",
          "Lifecycle journal changes content/provenance outside its operation.",
          EXTENSION_JOURNAL_PATH,
        ),
      );
  }
  const seen = new Set<string>();
  const expectedPaths = new Set([
    EXTENSION_REGISTRY_PATH,
    ...(journal.kind === "install" && newRecord
      ? newRecord.manifest.files.map(
          (path) => `extensions/${journal.id}/${path}`,
        )
      : contentPlan.map((entry) => entry.path)),
  ]);
  for (const entry of journal.entries) {
    if (seen.has(entry.path.toLowerCase()) || !expectedPaths.has(entry.path))
      diagnostics.push(
        diagnostic(
          "invalid-journal",
          `Duplicate or unowned transaction path ${entry.path}.`,
          EXTENSION_JOURNAL_PATH,
        ),
      );
    seen.add(entry.path.toLowerCase());
    if (entry.path !== EXTENSION_REGISTRY_PATH) {
      const local = entry.path.slice(`extensions/${journal.id}/`.length);
      const planned = contentPlan.find((item) => item.path === entry.path);
      if (
        (journal.kind === "install"
          ? entry.before !== null || entry.after !== newRecord?.base[local]
          : !planned ||
            entry.before !== planned.before ||
            entry.after !== planned.after) ||
        Buffer.byteLength(entry.before ?? "") > EXTENSION_FILE_LIMIT ||
        Buffer.byteLength(entry.after ?? "") > EXTENSION_FILE_LIMIT
      )
        diagnostics.push(
          diagnostic(
            "invalid-journal",
            `Transaction bytes for ${entry.path} differ from its supported ownership transition.`,
            EXTENSION_JOURNAL_PATH,
          ),
        );
    }
  }
  if (seen.size !== expectedPaths.size)
    diagnostics.push(
      diagnostic(
        "invalid-journal",
        "Transaction omits an owned content write or exact-before guard.",
        EXTENSION_JOURNAL_PATH,
      ),
    );
  if (hasExtensionErrors(diagnostics)) return null;
  // Preflight every current file before restoring any of them. A later repeat
  // also accepts partially rolled-back old bytes after an interrupted recovery.
  for (const entry of journal.entries) {
    try {
      const current = await maybeExtensionText(
        root,
        entry.path,
        entry.path === EXTENSION_REGISTRY_PATH
          ? EXTENSION_REGISTRY_LIMIT
          : EXTENSION_FILE_LIMIT,
      );
      const currentHash = current === null ? null : extensionHash(current);
      const beforeHash =
        entry.before === null ? null : extensionHash(entry.before);
      const afterHash =
        entry.after === null ? null : extensionHash(entry.after);
      if (
        currentHash !== beforeHash &&
        (expected === "before" || currentHash !== afterHash)
      )
        diagnostics.push(
          diagnostic(
            "recovery-conflict",
            `Current bytes differ from the recorded ${expected === "before" ? "prior" : "old and new"} state: ${entry.path}.`,
            entry.path,
            "Preserve the unexpected edit in Git and reconcile it manually; recovery never overwrites it.",
          ),
        );
    } catch (error) {
      diagnostics.push(
        diagnostic("recovery-conflict", String(error), entry.path),
      );
    }
  }
  return hasExtensionErrors(diagnostics)
    ? null
    : { registry: before, text: registryEntry.before };
}

async function restoreMissing(root: string, path: string): Promise<void> {
  await assertExtensionPath(root, path, true);
  try {
    await unlink(join(root, path));
  } catch (error) {
    if (!absentExtensionFile(error)) throw error;
  }
  // Empty directories have no authored bytes. Never recursively remove them.
  let parent = dirname(path);
  while (parent.startsWith("extensions/")) {
    try {
      await rmdir(join(root, parent));
    } catch (error) {
      if (!absentExtensionFile(error)) break;
    }
    parent = dirname(parent);
  }
}

export async function recoverExtensionTransaction(
  root: string,
  dryRun: boolean,
): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    ok: false,
    changed: false,
    affectedPaths: [],
    diagnostics: [],
  };
  try {
    const text = await maybeExtensionText(
      root,
      EXTENSION_JOURNAL_PATH,
      EXTENSION_JOURNAL_LIMIT,
    );
    if (text === null) {
      result.ok = true;
      return result;
    }
    const journal = parseJournal(text, result.diagnostics);
    if (!journal) return result;
    const prior = await validateJournal(
      root,
      journal,
      "either",
      result.diagnostics,
    );
    if (!prior) return result;
    result.affectedPaths = [
      ...journal.entries.map((entry) => entry.path),
      EXTENSION_JOURNAL_PATH,
    ];
    result.changed = true;
    result.registry = prior.registry;
    result.registryText = prior.text;
    result.files = Object.fromEntries(
      journal.entries
        .filter((entry) => entry.path !== EXTENSION_REGISTRY_PATH)
        .map((entry) => [entry.path, entry.before]),
    );
    if (!dryRun) {
      for (const entry of [...journal.entries].reverse()) {
        // Recheck immediately before writing as well as the complete preflight.
        const current = await maybeExtensionText(
          root,
          entry.path,
          entry.path === EXTENSION_REGISTRY_PATH
            ? EXTENSION_REGISTRY_LIMIT
            : EXTENSION_FILE_LIMIT,
        );
        if (current !== entry.before && current !== entry.after)
          throw new Error(
            `Unexpected concurrent edit during recovery: ${entry.path}`,
          );
        if (current !== entry.before) {
          if (entry.before === null) await restoreMissing(root, entry.path);
          else
            await publishExtensionText(root, entry.path, entry.before, current);
        }
      }
      await assertExtensionPath(root, EXTENSION_JOURNAL_PATH);
      if (
        (await maybeExtensionText(
          root,
          EXTENSION_JOURNAL_PATH,
          EXTENSION_JOURNAL_LIMIT,
        )) !== text
      )
        throw new Error("Transaction journal changed during recovery.");
      await unlink(join(root, EXTENSION_JOURNAL_PATH));
    }
    result.ok = true;
  } catch (error) {
    result.diagnostics.push(
      diagnostic(
        "recovery-failure",
        String(error),
        EXTENSION_JOURNAL_PATH,
        "The journal remains authoritative. Preserve all unexpected edits, resolve the filesystem issue, and retry validated recovery.",
      ),
    );
  }
  return result;
}

export async function preflightExtensionTransaction(
  root: string,
  journal: ExtensionJournal,
): Promise<ExtensionDiagnostic[]> {
  const diagnostics: ExtensionDiagnostic[] = [];
  try {
    const text = `${JSON.stringify(journal)}\n`;
    if (Buffer.byteLength(text) > EXTENSION_JOURNAL_LIMIT)
      throw new Error("Transaction exceeds its bounded journal limit.");
    const checked = parseJournal(text, diagnostics);
    if (
      !checked ||
      !(await validateJournal(root, checked, "before", diagnostics))
    )
      return diagnostics;
    if (
      (await maybeExtensionText(
        root,
        EXTENSION_JOURNAL_PATH,
        EXTENSION_JOURNAL_LIMIT,
      )) !== null
    )
      throw new Error(
        "An earlier extension transaction must be recovered first.",
      );
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "transaction-preflight",
        String(error),
        EXTENSION_JOURNAL_PATH,
      ),
    );
  }
  return diagnostics;
}

export async function applyExtensionTransaction(
  root: string,
  journal: ExtensionJournal,
  publish = publishExtensionText,
): Promise<{
  ok: boolean;
  diagnostics: ExtensionDiagnostic[];
  rollback?: "complete" | "pending";
}> {
  const diagnostics: ExtensionDiagnostic[] = [];
  const text = `${JSON.stringify(journal)}\n`;
  let journalPublished = false;
  try {
    diagnostics.push(...(await preflightExtensionTransaction(root, journal)));
    if (hasExtensionErrors(diagnostics)) return { ok: false, diagnostics };
    await publish(root, EXTENSION_JOURNAL_PATH, text, null);
    journalPublished = true;
    for (const entry of journal.entries) {
      if (entry.path === EXTENSION_REGISTRY_PATH)
        for (const guarded of journal.entries.filter(
          (item) => item.path !== EXTENSION_REGISTRY_PATH,
        ))
          if (
            (await maybeExtensionText(
              root,
              guarded.path,
              EXTENSION_FILE_LIMIT,
            )) !== guarded.after
          )
            throw new Error(
              `Unexpected concurrent edit before registry publication: ${guarded.path}`,
            );
      const current = await maybeExtensionText(
        root,
        entry.path,
        entry.path === EXTENSION_REGISTRY_PATH
          ? EXTENSION_REGISTRY_LIMIT
          : EXTENSION_FILE_LIMIT,
      );
      if (current !== entry.before)
        throw new Error(
          `Unexpected concurrent edit before publication: ${entry.path}`,
        );
      if (entry.after !== entry.before) {
        if (entry.after === null)
          throw new Error("Destructive authoritative writes are unsupported.");
        await publish(root, entry.path, entry.after, entry.before);
      }
      // A source used to acknowledge review or advance upstream ownership must
      // still have the planned bytes when the registry publishes.
      if (entry.path === EXTENSION_REGISTRY_PATH) {
        for (const guarded of journal.entries.filter(
          (item) => item.path !== EXTENSION_REGISTRY_PATH,
        ))
          if (
            (await maybeExtensionText(
              root,
              guarded.path,
              EXTENSION_FILE_LIMIT,
            )) !== guarded.after
          )
            throw new Error(
              `Unexpected concurrent edit after content publication: ${guarded.path}`,
            );
      }
    }
    await unlink(join(root, EXTENSION_JOURNAL_PATH));
    return { ok: true, diagnostics };
  } catch (error) {
    diagnostics.push(
      diagnostic("filesystem-failure", String(error), EXTENSION_JOURNAL_PATH),
    );
    if (!journalPublished) return { ok: false, diagnostics };
    const recovery = await recoverExtensionTransaction(root, false);
    diagnostics.push(...recovery.diagnostics);
    return {
      ok: false,
      diagnostics,
      rollback: recovery.ok ? "complete" : "pending",
    };
  }
}
