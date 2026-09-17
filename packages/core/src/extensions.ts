import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  applyExtensionTransaction,
  type ExtensionJournal,
  preflightExtensionTransaction,
  recoverExtensionTransaction,
} from "./extensions-transaction";
import type {
  ExtensionDiagnostic,
  ExtensionInspection,
  ExtensionInventory,
  ExtensionManifest,
  ExtensionMutationResult,
  ExtensionOperation,
  ExtensionOptions,
  ExtensionRecord,
  ExtensionRegistry,
  ExtensionSource,
  ExtensionValidationResult,
  ExtensionView,
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
  EXTENSION_INSTALLED_LIMIT,
  EXTENSION_JOURNAL_PATH,
  EXTENSION_PACKAGE_LIMIT,
  EXTENSION_REGISTRY_LIMIT,
  EXTENSION_REGISTRY_PATH,
  extensionCompatibility,
  extensionDigest,
  extensionHash,
  extensionTree,
  hasExtensionErrors,
  maybeExtensionText,
  parseExtensionManifest,
  parseExtensionRegistry,
  readExtensionText,
  validateExtensionChoices,
  validateExtensionOperation,
  validateExtensionRecord,
  validateExtensionSources,
} from "./extensions-validation";
import { LocalFileStore } from "./filestore";
import { DOCKET_VERSION } from "./version";

export type * from "./extensions-types";

async function inspectPackage(
  sourceRoot: string,
  options: ExtensionOptions & { bundleRoot: string },
  context?: { prefix: string; retained: Record<string, string> },
): Promise<ExtensionInspection> {
  const engineVersion = options.engineVersion ?? DOCKET_VERSION;
  const diagnostics: ExtensionDiagnostic[] = [];
  let manifest: ExtensionManifest | null = null;
  let digest: string | null = null;
  const files: Record<string, string> = {};
  let compatibility: ExtensionInspection["compatibility"] = "indeterminate";
  try {
    const paths = await extensionTree(sourceRoot, 100);
    const manifestText = await readExtensionText(
      sourceRoot,
      "extension.json",
      EXTENSION_FILE_LIMIT,
    );
    let raw: unknown;
    try {
      raw = JSON.parse(manifestText);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "invalid-manifest",
          `Manifest is not valid JSON: ${String(error)}`,
          "extension.json",
        ),
      );
    }
    if (raw !== undefined) {
      if (
        raw !== null &&
        typeof raw === "object" &&
        "formatVersion" in raw &&
        typeof raw.formatVersion === "number" &&
        raw.formatVersion !== 1
      ) {
        compatibility = "incompatible";
        diagnostics.push(
          diagnostic(
            "incompatible-format",
            `Package format ${raw.formatVersion} is incompatible with supported format 1.`,
            "extension.json",
          ),
        );
      }
      manifest = parseExtensionManifest(raw, diagnostics);
    }
    if (manifest && !hasExtensionErrors(diagnostics)) {
      const declared = ["extension.json", ...manifest.files].sort();
      if (
        JSON.stringify(paths.map((path) => path.normalize("NFC")).sort()) !==
        JSON.stringify(declared.map((path) => path.normalize("NFC")).sort())
      )
        diagnostics.push(
          diagnostic(
            "undeclared-content",
            "Source must contain exactly extension.json and its declared Markdown files.",
            sourceRoot,
          ),
        );
      let bytes = Buffer.byteLength(manifestText);
      for (const path of manifest.files) {
        const source = await readExtensionText(
          sourceRoot,
          path,
          EXTENSION_FILE_LIMIT,
          true,
        );
        files[path] = source;
        bytes += Buffer.byteLength(source);
      }
      if (bytes > EXTENSION_PACKAGE_LIMIT)
        diagnostics.push(
          diagnostic(
            "content-limit",
            "Package exceeds 2 MiB of UTF-8 content including the manifest.",
            sourceRoot,
          ),
        );
      diagnostics.push(
        ...(await validateExtensionSources(
          manifest,
          files,
          options.bundleRoot,
          context?.prefix,
          context?.retained,
        )),
      );
      digest = extensionDigest(manifest, files);
      compatibility = extensionCompatibility(
        manifest,
        engineVersion,
        diagnostics,
      );
    }
  } catch (error) {
    diagnostics.push(
      diagnostic("source-unreadable", String(error), sourceRoot),
    );
  }
  return {
    ok: !hasExtensionErrors(diagnostics),
    engineVersion,
    sourceRoot: resolve(sourceRoot),
    manifest,
    digest,
    files,
    compatibility,
    diagnostics,
  };
}

export async function inspectExtensionPackage(
  sourceRoot: string,
  options: ExtensionOptions & { bundleRoot: string },
): Promise<ExtensionInspection> {
  return inspectPackage(sourceRoot, options);
}

interface RegistryRead {
  registry: ExtensionRegistry | null;
  text: string | null;
  diagnostics: ExtensionDiagnostic[];
}

async function readRegistry(bundleRoot: string): Promise<RegistryRead> {
  const diagnostics: ExtensionDiagnostic[] = [];
  let text: string | null = null;
  let registry: ExtensionRegistry | null = null;
  try {
    text = await maybeExtensionText(
      bundleRoot,
      EXTENSION_REGISTRY_PATH,
      EXTENSION_REGISTRY_LIMIT,
    );
    registry =
      text === null
        ? { formatVersion: 1, packages: {} }
        : parseExtensionRegistry(text, diagnostics);
  } catch (error) {
    diagnostics.push(
      diagnostic("registry-unreadable", String(error), EXTENSION_REGISTRY_PATH),
    );
  }
  return { registry, text, diagnostics };
}

async function hasJournal(bundleRoot: string): Promise<boolean> {
  try {
    await assertExtensionPath(bundleRoot, EXTENSION_JOURNAL_PATH, true);
    await lstat(join(bundleRoot, EXTENSION_JOURNAL_PATH));
    return true;
  } catch (error) {
    if (absentExtensionFile(error)) return false;
    // An unsafe or unreadable journal location is unresolved too.
    return true;
  }
}

async function packageView(
  bundleRoot: string,
  id: string,
  record: ExtensionRecord,
  engineVersion: string,
  pending: boolean,
  projectedFiles?: Record<string, string | null>,
): Promise<ExtensionView> {
  const diagnostics: ExtensionDiagnostic[] = [];
  validateExtensionRecord(id, record, diagnostics);
  const compatibility = extensionCompatibility(
    record.manifest,
    engineVersion,
    diagnostics,
  );
  const prefix = `extensions/${id}`;
  const sources: Record<string, ExtensionSource> = {};
  const current: Record<string, string> = {};
  const retained: Record<string, string> = {};
  const expectedPaths = [
    ...record.manifest.files,
    ...Object.keys(record.retainedFiles),
  ].sort();
  // Structural provenance errors can contain unsafe paths. Never use them as
  // filesystem instructions; retain a diagnostic-bearing unavailable view.
  if (
    !diagnostics.some((entry) =>
      ["invalid-path", "ownership-mismatch", "duplicate-name"].includes(
        entry.code,
      ),
    )
  ) {
    let bytes = 0;
    for (const path of expectedPaths) {
      const base = record.base[path] ?? record.retainedFiles[path]?.base ?? "";
      let text: string | null = null;
      const isRetained = Object.hasOwn(record.retainedFiles, path);
      try {
        text =
          projectedFiles && Object.hasOwn(projectedFiles, `${prefix}/${path}`)
            ? (projectedFiles[`${prefix}/${path}`] ?? null)
            : await readExtensionText(
                bundleRoot,
                `${prefix}/${path}`,
                EXTENSION_FILE_LIMIT,
                true,
              );
        if (text !== null) bytes += Buffer.byteLength(text);
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "source-unreadable",
            String(error),
            `${prefix}/${path}`,
            isRetained
              ? "Restore this retained historical source from Git to repair completed links; do not delete its ownership tombstone."
              : undefined,
            isRetained ? "warning" : "error",
          ),
        );
      }
      const hash = text === null ? null : extensionHash(text);
      const baseHash =
        isRetained && record.retainedFiles[path]?.baseHash
          ? record.retainedFiles[path].baseHash
          : extensionHash(base);
      const adapted = hash !== null && hash !== baseHash;
      const reviewRequired = adapted && record.reviewedLocal[path] !== hash;
      sources[path] = {
        path: `${prefix}/${path}`,
        text,
        hash,
        baseHash,
        adapted,
        reviewRequired,
        retained: isRetained,
      };
      if (text !== null) (isRetained ? retained : current)[path] = text;
    }
    if (bytes > EXTENSION_INSTALLED_LIMIT)
      diagnostics.push(
        diagnostic(
          "content-limit",
          "Current package content exceeds 4 MiB.",
          prefix,
        ),
      );
    try {
      let paths: string[] = [];
      try {
        paths = await extensionTree(
          join(bundleRoot, prefix),
          201,
          expectedPaths,
        );
      } catch (error) {
        if (!projectedFiles || !absentExtensionFile(error)) throw error;
      }
      if (projectedFiles)
        paths = [
          ...new Set([
            ...paths.filter(
              (path) =>
                !Object.hasOwn(projectedFiles, `${prefix}/${path}`) ||
                projectedFiles[`${prefix}/${path}`] !== null,
            ),
            ...Object.keys(projectedFiles)
              .filter(
                (path) =>
                  path.startsWith(`${prefix}/`) &&
                  projectedFiles[path] !== null,
              )
              .map((path) => path.slice(prefix.length + 1)),
          ]),
        ];
      if (
        paths.some(
          (path) =>
            !expectedPaths.some(
              (expected) => expected.normalize("NFC") === path.normalize("NFC"),
            ),
        )
      )
        diagnostics.push(
          diagnostic(
            "ownership-collision",
            "Package directory contains unowned paths; no installation may adopt them silently.",
            prefix,
          ),
        );
    } catch (error) {
      diagnostics.push(
        diagnostic("ownership-collision", String(error), prefix),
      );
    }
    diagnostics.push(
      ...(await validateExtensionSources(
        record.manifest,
        current,
        bundleRoot,
        prefix,
        retained,
      )),
    );
    // Retained source validation stays visible, but historical links alone
    // cannot deactivate unrelated active workflows.
    const historyManifest = {
      ...record.manifest,
      workflows: [],
      files: Object.keys(retained),
    };
    const historyDiagnostics = await validateExtensionSources(
      historyManifest,
      retained,
      bundleRoot,
      prefix,
      current,
      true,
    );
    diagnostics.push(
      ...historyDiagnostics.map((entry) => ({
        ...entry,
        severity: "warning" as const,
        remediation:
          "Review retained historical content and restore links from Git; active workflows must not depend on missing or invalid retained content.",
      })),
    );
    const validRetained = { ...retained };
    let invalidHistory = historyDiagnostics;
    // Propagate invalid historical dependencies to a fixed point. Otherwise an
    // active source could reach invalid history through one apparently valid
    // retained intermediary.
    while (invalidHistory.length) {
      let removed = false;
      for (const entry of invalidHistory)
        if (entry.path && Object.hasOwn(validRetained, entry.path)) {
          delete validRetained[entry.path];
          removed = true;
        }
      if (!removed) break;
      invalidHistory = await validateExtensionSources(
        { ...historyManifest, files: Object.keys(validRetained) },
        validRetained,
        bundleRoot,
        prefix,
        current,
        true,
      );
    }
    if (Object.keys(validRetained).length !== Object.keys(retained).length)
      diagnostics.push(
        ...(await validateExtensionSources(
          record.manifest,
          current,
          bundleRoot,
          prefix,
          validRetained,
        )),
      );
  }
  const adaptedPaths = Object.keys(sources).filter(
    (path) => sources[path]?.adapted,
  );
  const reviewRequiredPaths = Object.keys(sources).filter(
    (path) => sources[path]?.reviewRequired && !sources[path]?.retained,
  );
  if (reviewRequiredPaths.length)
    diagnostics.push(
      diagnostic(
        "local-review-required",
        `Unacknowledged local changes: ${reviewRequiredPaths.join(", ")}.`,
        prefix,
        "Review exact current sources, then use extension reconcile --acknowledge-local when available; restore the prior reviewed content to withdraw an unintended change.",
        "warning",
      ),
    );
  const invalid = diagnostics.some(
    (entry) =>
      entry.severity === "error" && entry.code !== "incompatible-engine",
  );
  const availability = pending
    ? "pending-recovery"
    : invalid
      ? "invalid"
      : compatibility !== "compatible"
        ? "incompatible"
        : record.status === "removed"
          ? "removed"
          : !record.requestedEnabled
            ? "disabled"
            : reviewRequiredPaths.length
              ? "review-required"
              : "available";
  return {
    id,
    manifest: record.manifest,
    digest: record.digest,
    status: record.status,
    requestedEnabled: record.requestedEnabled,
    config: record.config,
    bindings: record.bindings,
    effectiveConfig: Object.fromEntries(
      Object.entries(record.manifest.defaults).map(([key, value]) => [
        key,
        Object.hasOwn(record.config, key)
          ? { value: record.config[key], owner: "project" }
          : { value, owner: "default" },
      ]),
    ),
    sources,
    adaptedPaths,
    reviewRequiredPaths,
    availability,
    diagnostics,
  } as ExtensionView;
}

async function inventoryFrom(
  bundleRoot: string,
  state: RegistryRead,
  engineVersion: string,
  pending: boolean,
  projectedFiles?: Record<string, string | null>,
): Promise<ExtensionInventory> {
  const diagnostics = [...state.diagnostics];
  if (pending)
    diagnostics.push(
      diagnostic(
        "pending-recovery",
        "An extension transaction is pending; all extension availability is unresolved.",
        EXTENSION_JOURNAL_PATH,
        "Run docket extension recover --dry-run, inspect its retained changes, then recover. Unexpected edits require manual Git reconciliation.",
      ),
    );
  const packages: ExtensionView[] = [];
  if (state.registry) {
    for (const id of Object.keys(state.registry.packages).sort()) {
      const record = state.registry.packages[id];
      if (record)
        packages.push(
          await packageView(
            bundleRoot,
            id,
            record,
            engineVersion,
            pending,
            projectedFiles &&
              Object.keys(projectedFiles).some((path) =>
                path.startsWith(`extensions/${id}/`),
              )
              ? projectedFiles
              : undefined,
          ),
        );
    }
  }
  const workflows = packages
    .filter((view) => view.availability === "available")
    .flatMap((view) =>
      view.manifest.workflows.map((entry) => ({
        identity: `${view.id}:${entry.id}`,
        nativeName: `docket-ext-${view.id}-${entry.id}`,
        packageId: view.id,
        id: entry.id,
        title: entry.title,
        description: entry.description,
        path: `extensions/${view.id}/${entry.path}`,
        guidance: view.manifest.guidance.map(
          (path) => `extensions/${view.id}/${path}`,
        ),
      })),
    );
  for (const name of new Set(
    workflows.map((workflow) => workflow.nativeName),
  )) {
    const matches = workflows.filter(
      (workflow) => workflow.nativeName === name,
    );
    if (matches.length > 1)
      diagnostics.push(
        diagnostic(
          "native-name-collision",
          `${name} has multiple canonical owners: ${matches.map((workflow) => workflow.identity).join(", ")}.`,
          undefined,
          "Use qualified portable identities; native generation must withhold every colliding destination.",
          "warning",
        ),
      );
  }
  return {
    ok:
      !hasExtensionErrors(diagnostics) &&
      !packages.some((view) => hasExtensionErrors(view.diagnostics)),
    engineVersion,
    registryHash: state.text === null ? null : extensionHash(state.text),
    pendingTransaction: pending,
    packages,
    workflows,
    diagnostics,
  };
}

export async function readExtensions(
  bundleRoot: string,
  options: ExtensionOptions = {},
): Promise<ExtensionInventory> {
  const engineVersion = options.engineVersion ?? DOCKET_VERSION;
  const pending = await hasJournal(bundleRoot);
  const state = await readRegistry(bundleRoot);
  const result = await inventoryFrom(bundleRoot, state, engineVersion, pending);
  const after = await readRegistry(bundleRoot);
  const pendingAfter = await hasJournal(bundleRoot);
  if (!pending && (pendingAfter || after.text !== state.text)) {
    result.ok = false;
    result.pendingTransaction = pendingAfter;
    result.workflows = [];
    for (const view of result.packages)
      view.availability = pendingAfter ? "pending-recovery" : "invalid";
    result.diagnostics.push(
      diagnostic(
        "state-changed",
        "Extension state changed during inspection; this mixed snapshot cannot authorize invocation.",
        EXTENSION_REGISTRY_PATH,
        "Read extension availability again after the concurrent operation finishes.",
      ),
    );
  }
  return result;
}

export async function mutateExtension(
  bundleRoot: string,
  operation: ExtensionOperation,
  options: ExtensionOptions & { dryRun?: boolean } = {},
): Promise<ExtensionMutationResult> {
  const engineVersion = options.engineVersion ?? DOCKET_VERSION;
  const dryRun = options.dryRun ?? false;
  const store = new LocalFileStore(bundleRoot);
  try {
    // Dry-run performs the same authoritative preflight under the shared lock;
    // it creates neither registry/content files nor a transaction journal.
    return await store.withMutation(async () => {
      const initial = await readExtensions(bundleRoot, { engineVersion });
      const result: ExtensionMutationResult = {
        ok: false,
        operation: operation.kind,
        dryRun,
        changed: false,
        affectedPaths: [],
        diagnostics: [],
        inventory: initial,
      };
      result.diagnostics.push(...validateExtensionOperation(operation));
      if (hasExtensionErrors(result.diagnostics)) return result;
      if (operation.kind === "recover") {
        const recovery = await recoverExtensionTransaction(bundleRoot, dryRun);
        result.ok = recovery.ok;
        result.changed = recovery.changed;
        result.affectedPaths = recovery.affectedPaths;
        result.diagnostics = recovery.diagnostics;
        if (recovery.changed)
          result.rollback = recovery.ok ? "complete" : "pending";
        result.inventory =
          dryRun && recovery.registry
            ? await inventoryFrom(
                bundleRoot,
                {
                  registry: recovery.registry,
                  text: recovery.registryText ?? null,
                  diagnostics: [],
                },
                engineVersion,
                false,
                recovery.files,
              )
            : await readExtensions(bundleRoot, { engineVersion });
        return result;
      }
      const state = await readRegistry(bundleRoot);
      if (
        initial.pendingTransaction ||
        !state.registry ||
        state.diagnostics.length
      ) {
        result.diagnostics.push(...initial.diagnostics);
        return result;
      }
      if (
        (state.text === null ? null : extensionHash(state.text)) !==
        initial.registryHash
      ) {
        result.diagnostics.push(
          diagnostic(
            "state-changed",
            "Registry changed while preparing the operation; retry against fresh state.",
            EXTENSION_REGISTRY_PATH,
          ),
        );
        return result;
      }
      const registry = structuredClone(state.registry);
      // Dry-run and publication require exactly the same known provenance.
      for (const [key, record] of Object.entries(registry.packages))
        validateExtensionRecord(key, record, result.diagnostics);
      if (hasExtensionErrors(result.diagnostics)) return result;
      const writes: Record<string, string> = {};
      let contentEntries: ExtensionContentEntry[] = [];
      let id: string;
      if (operation.kind === "install") {
        const candidate = await inspectExtensionPackage(operation.source, {
          bundleRoot,
          engineVersion,
        });
        result.diagnostics.push(...candidate.diagnostics);
        if (!candidate.ok || !candidate.manifest || !candidate.digest)
          return result;
        id = candidate.manifest.id;
        const existing = Object.hasOwn(registry.packages, id)
          ? registry.packages[id]
          : undefined;
        if (existing) {
          const integrity: ExtensionDiagnostic[] = [];
          validateExtensionRecord(id, existing, integrity);
          result.diagnostics.push(...integrity);
          if (hasExtensionErrors(integrity)) return result;
          if (
            existing.manifest.version !== candidate.manifest.version ||
            existing.digest !== candidate.digest
          ) {
            result.diagnostics.push(
              diagnostic(
                existing.manifest.version === candidate.manifest.version
                  ? "republished-version"
                  : "already-installed",
                "An existing package can only be repeated with exactly the same version and content; use update for a newer version.",
                EXTENSION_REGISTRY_PATH,
              ),
            );
            return result;
          }
          result.ok = true;
          // Repetition is an exact no-op; enablement and removed status require
          // explicit lifecycle commands, never implicit installation order.
          return result;
        }
        try {
          await assertExtensionPath(bundleRoot, `extensions/${id}`, true);
          await lstat(join(bundleRoot, "extensions", id));
          result.diagnostics.push(
            diagnostic(
              "ownership-collision",
              "Package destination already exists without this registry ownership, even if its bytes match.",
              `extensions/${id}`,
            ),
          );
          return result;
        } catch (error) {
          if (!absentExtensionFile(error)) {
            result.diagnostics.push(
              diagnostic(
                "ownership-collision",
                String(error),
                `extensions/${id}`,
              ),
            );
            return result;
          }
        }
        registry.packages[id] = {
          manifest: candidate.manifest,
          digest: candidate.digest,
          base: candidate.files,
          status: "installed",
          requestedEnabled: operation.enable ?? false,
          config: {},
          bindings: {},
          reviewedLocal: {},
          retainedFiles: {},
          source: resolve(operation.source),
        };
        for (const [path, text] of Object.entries(candidate.files))
          writes[`extensions/${id}/${path}`] = text;
      } else {
        id = operation.id;
        const record = registry.packages[id];
        if (!Object.hasOwn(registry.packages, id) || !record) {
          result.diagnostics.push(
            diagnostic(
              "not-installed",
              `Unknown extension package ${id}.`,
              EXTENSION_REGISTRY_PATH,
            ),
          );
          return result;
        }
        if (operation.kind === "update" || operation.kind === "reconcile") {
          const view = initial.packages.find((entry) => entry.id === id);
          const currentErrors = view?.diagnostics.filter(
            (entry) =>
              entry.severity === "error" &&
              (operation.kind !== "update" ||
                entry.code !== "incompatible-engine"),
          ) ?? [
            diagnostic(
              "invalid-package",
              "Current package could not be inspected.",
            ),
          ];
          result.diagnostics.push(...currentErrors);
          if (hasExtensionErrors(result.diagnostics) || !view) return result;
          const current: Record<string, string | null> = Object.fromEntries(
            Object.entries(view.sources).map(([path, entry]) => [
              path,
              entry.text,
            ]),
          );
          if (operation.kind === "update") {
            const retained = Object.fromEntries(
              Object.entries(view.sources)
                .filter(([, entry]) => entry.text !== null)
                .map(([path, entry]) => [path, entry.text as string]),
            );
            const candidate = await inspectPackage(
              operation.source,
              { bundleRoot, engineVersion },
              { prefix: `extensions/${id}`, retained },
            );
            result.diagnostics.push(...candidate.diagnostics);
            if (!candidate.ok || !candidate.manifest || !candidate.digest)
              return result;
            for (const path of candidate.manifest.files)
              if (!Object.hasOwn(current, path))
                current[path] = await maybeExtensionText(
                  bundleRoot,
                  `extensions/${id}/${path}`,
                  EXTENSION_FILE_LIMIT,
                );
            const planned = planExtensionUpdate(
              record,
              current,
              candidate.manifest,
              candidate.files,
              resolve(operation.source),
            );
            result.diagnostics.push(...planned.diagnostics);
            if (hasExtensionErrors(result.diagnostics)) return result;
            registry.packages[id] = planned.record;
            contentEntries = planned.entries;
          } else {
            const planned = planExtensionReconciliation(record, current);
            registry.packages[id] = planned.record;
            contentEntries = planned.entries;
          }
          for (const entry of contentEntries)
            if (entry.after !== null) writes[entry.path] = entry.after;
        } else if (operation.kind === "configure") {
          for (const key of operation.reset ?? []) {
            if (!Object.hasOwn(record.manifest.defaults, key))
              result.diagnostics.push(
                diagnostic(
                  "invalid-configuration",
                  `Unknown reset key ${key}.`,
                  EXTENSION_REGISTRY_PATH,
                ),
              );
            delete record.config[key];
          }
          for (const key of operation.unbind ?? []) {
            if (!record.manifest.capabilities.some((entry) => entry.id === key))
              result.diagnostics.push(
                diagnostic(
                  "invalid-binding",
                  `Unknown capability ${key}.`,
                  EXTENSION_REGISTRY_PATH,
                ),
              );
            delete record.bindings[key];
          }
          if (
            (operation.reset ?? []).some(
              (key) => operation.set && Object.hasOwn(operation.set, key),
            ) ||
            (operation.unbind ?? []).some(
              (key) =>
                operation.bindings && Object.hasOwn(operation.bindings, key),
            )
          )
            result.diagnostics.push(
              diagnostic(
                "ambiguous-configuration",
                "A key cannot be both set and reset, or bound and unbound, in one operation.",
                EXTENSION_REGISTRY_PATH,
              ),
            );
          record.config = { ...record.config, ...operation.set };
          record.bindings = { ...record.bindings, ...operation.bindings };
          result.diagnostics.push(
            ...validateExtensionChoices(
              record.manifest,
              record.config,
              record.bindings,
            ),
          );
          if (hasExtensionErrors(result.diagnostics)) return result;
        } else if (operation.kind === "enable") {
          const view = initial.packages.find((entry) => entry.id === id);
          if (
            !view ||
            hasExtensionErrors(view.diagnostics) ||
            view.reviewRequiredPaths.length
          ) {
            result.diagnostics.push(
              ...(view?.diagnostics ?? [
                diagnostic(
                  "invalid-package",
                  "Package could not be inspected.",
                  `extensions/${id}`,
                ),
              ]),
            );
            return result;
          }
          record.status = "installed";
          record.requestedEnabled = true;
        } else {
          record.requestedEnabled = false;
          if (operation.kind === "remove") record.status = "removed";
        }
      }
      const registryText =
        isDeepStrictEqual(registry, state.registry) && state.text !== null
          ? state.text
          : `${JSON.stringify(registry, null, 2)}\n`;
      if (Buffer.byteLength(registryText) > EXTENSION_REGISTRY_LIMIT) {
        result.diagnostics.push(
          diagnostic(
            "registry-limit",
            "Registry exceeds its bounded 64 MiB storage limit.",
            EXTENSION_REGISTRY_PATH,
            "Preserve/archive historical project state in Git before choosing a separately reviewed package/project layout.",
          ),
        );
        return result;
      }
      if (registryText !== state.text)
        writes[EXTENSION_REGISTRY_PATH] = registryText;
      result.affectedPaths = Object.keys(writes).filter(
        (path) =>
          path === EXTENSION_REGISTRY_PATH ||
          !contentEntries.some(
            (entry) => entry.path === path && entry.before === entry.after,
          ),
      );
      result.changed = result.affectedPaths.length > 0;
      result.inventory = await inventoryFrom(
        bundleRoot,
        { registry, text: registryText, diagnostics: [] },
        engineVersion,
        false,
        writes,
      );
      if (operation.kind === "update" || operation.kind === "reconcile") {
        const projected = result.inventory.packages.find(
          (entry) => entry.id === id,
        );
        result.diagnostics.push(...(projected?.diagnostics ?? []));
        if (!projected || hasExtensionErrors(projected.diagnostics)) {
          result.changed = false;
          result.inventory = initial;
          return result;
        }
      }
      if (!result.changed) {
        result.ok = true;
        return result;
      }
      const journal: ExtensionJournal = {
        formatVersion: 1,
        kind: operation.kind,
        id,
        entries: [],
      };
      for (const entry of contentEntries) journal.entries.push(entry);
      for (const [path, after] of Object.entries(writes)) {
        if (contentEntries.some((entry) => entry.path === path)) continue;
        // Preserve the state from which this plan was derived. A fresh read
        // here would silently adopt an intervening manual edit as our base.
        const before = path === EXTENSION_REGISTRY_PATH ? state.text : null;
        journal.entries.push({ path, before, after });
      }
      result.diagnostics.push(
        ...(await preflightExtensionTransaction(bundleRoot, journal)),
      );
      if (hasExtensionErrors(result.diagnostics)) {
        result.changed = false;
        result.inventory = initial;
        return result;
      }
      if (dryRun) {
        result.ok = true;
        return result;
      }
      const applied = await applyExtensionTransaction(bundleRoot, journal);
      result.ok = applied.ok;
      result.diagnostics.push(...applied.diagnostics);
      if (applied.rollback) result.rollback = applied.rollback;
      if (!applied.ok) result.changed = applied.rollback === "pending";
      result.inventory = await readExtensions(bundleRoot, { engineVersion });
      return result;
    });
  } catch (error) {
    const inventory = await readExtensions(bundleRoot, { engineVersion });
    return {
      ok: false,
      operation: operation.kind,
      dryRun,
      changed: false,
      affectedPaths: [],
      diagnostics: [
        diagnostic(
          "filesystem-failure",
          String(error),
          undefined,
          inventory.pendingTransaction
            ? "Inspect and recover the retained transaction before continuing."
            : "Correct the filesystem issue and retry; preflight did not authorize partial activation.",
        ),
      ],
      inventory,
      ...(inventory.pendingTransaction ? { rollback: "pending" as const } : {}),
    };
  }
}

/** A mechanical receipt identifies exact inputs. Scenario prose is reported,
 * never executed, and cannot turn missing protocol/agent evidence into a pass. */
export async function validateExtensions(
  bundleRoot: string,
  options: ExtensionOptions & { id?: string; candidate?: string } = {},
): Promise<ExtensionValidationResult> {
  const inventory = await readExtensions(bundleRoot, options);
  const diagnostics = [...inventory.diagnostics];
  let candidate: ExtensionInspection | undefined;
  let update: ExtensionMutationResult | undefined;
  let id = options.id;
  if (options.candidate !== undefined) {
    const current = inventory.packages.find((entry) => entry.id === id);
    candidate = await inspectPackage(
      options.candidate,
      { bundleRoot, engineVersion: inventory.engineVersion },
      current
        ? {
            prefix: `extensions/${current.id}`,
            retained: Object.fromEntries(
              Object.entries(current.sources)
                .filter(([, entry]) => entry.text !== null)
                .map(([path, entry]) => [path, entry.text as string]),
            ),
          }
        : undefined,
    );
    if (id === undefined && candidate.manifest) id = candidate.manifest.id;
    if (!current && id !== undefined) {
      const inferred = inventory.packages.find((entry) => entry.id === id);
      if (inferred)
        candidate = await inspectPackage(
          options.candidate,
          { bundleRoot, engineVersion: inventory.engineVersion },
          {
            prefix: `extensions/${inferred.id}`,
            retained: Object.fromEntries(
              Object.entries(inferred.sources)
                .filter(([, entry]) => entry.text !== null)
                .map(([path, entry]) => [path, entry.text as string]),
            ),
          },
        );
    }
    diagnostics.push(...candidate.diagnostics);
    // The mutation dry-run is the same bounded transaction preflight as update.
    if (id !== undefined) {
      update = await mutateExtension(
        bundleRoot,
        { kind: "update", id, source: options.candidate },
        { dryRun: true, engineVersion: inventory.engineVersion },
      );
      diagnostics.push(...update.diagnostics);
      if (!update.ok && !hasExtensionErrors(update.diagnostics))
        diagnostics.push(
          diagnostic(
            "update-unavailable",
            "The proposed update failed mechanical preflight.",
          ),
        );
      const projected = update.inventory.packages.find(
        (entry) => entry.id === id,
      );
      if (update.ok && candidate.digest !== projected?.digest)
        diagnostics.push(
          diagnostic(
            "state-changed",
            "Candidate identity changed during validation; rerun against stable sources.",
          ),
        );
    } else diagnostics.push(...candidate.diagnostics);
  }
  const selected = inventory.packages.filter(
    (entry) => id === undefined || entry.id === id,
  );
  if (id !== undefined && !selected.length)
    diagnostics.push(
      diagnostic(
        "not-installed",
        `Unknown extension package ${id}.`,
        EXTENSION_REGISTRY_PATH,
      ),
    );
  if (options.candidate === undefined)
    diagnostics.push(...selected.flatMap((entry) => entry.diagnostics));
  const packages = selected.map((entry) => ({
    id: entry.id,
    manifest: entry.manifest,
    digest: entry.digest,
    availability: entry.availability,
    sourceHashes: Object.fromEntries(
      Object.entries(entry.sources).map(([path, source]) => [
        path,
        source.hash,
      ]),
    ),
    baseHashes: Object.fromEntries(
      Object.entries(entry.sources).map(([path, source]) => [
        path,
        source.baseHash,
      ]),
    ),
    configurationHash: extensionHash(
      JSON.stringify([entry.effectiveConfig, entry.bindings]),
    ),
    reviewRequiredPaths: entry.reviewRequiredPaths,
    scenarios: entry.manifest.scenarios.map(
      (path) => `extensions/${entry.id}/${path}`,
    ),
    diagnostics: entry.diagnostics,
  }));
  const after = await readExtensions(bundleRoot, options);
  if (
    inventory.registryHash !== after.registryHash ||
    inventory.pendingTransaction !== after.pendingTransaction ||
    !isDeepStrictEqual(inventory.diagnostics, after.diagnostics) ||
    !isDeepStrictEqual(
      selected,
      after.packages.filter((entry) => id === undefined || entry.id === id),
    )
  )
    diagnostics.push(
      diagnostic(
        "state-changed",
        "Installed content changed while producing the receipt; repeat validation against stable state.",
      ),
    );
  const ok = !hasExtensionErrors(diagnostics);
  return {
    ok,
    engineVersion: inventory.engineVersion,
    mechanical: ok ? "pass" : "fail",
    protocol: "not-run",
    behavioral: "not-run",
    registryHash: inventory.registryHash,
    packages,
    ...(candidate ? { candidate } : {}),
    ...(update ? { update } : {}),
    diagnostics,
  };
}
