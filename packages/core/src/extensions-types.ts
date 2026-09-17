/** Repository-owned content; none of these values is executable engine configuration. */
export type ExtensionScalar = string | number | boolean | null;

export interface ExtensionManifest {
  formatVersion: 1;
  id: string;
  version: string;
  title: string;
  description: string;
  engine: { min: string; maxExclusive: string };
  files: string[];
  workflows: { id: string; title: string; description: string; path: string }[];
  guidance: string[];
  defaults: Record<string, ExtensionScalar>;
  capabilities: {
    id: string;
    description: string;
    access: "read" | "write";
    recipe: string;
  }[];
  scenarios: string[];
}

export interface ExtensionDiagnostic {
  code: string;
  message: string;
  path?: string;
  severity: "error" | "warning";
  remediation: string;
}

export interface ExtensionRetainedFile {
  base: string;
  baseHash: string;
  sourceVersion: string;
  sourceDigest: string;
}

export interface ExtensionRecord {
  manifest: ExtensionManifest;
  digest: string;
  base: Record<string, string>;
  status: "installed" | "removed";
  requestedEnabled: boolean;
  config: Record<string, ExtensionScalar>;
  bindings: Record<string, string>;
  reviewedLocal: Record<string, string>;
  retainedFiles: Record<string, ExtensionRetainedFile>;
  source?: string;
}

export interface ExtensionRegistry {
  formatVersion: 1;
  packages: Record<string, ExtensionRecord>;
}

export interface ExtensionSource {
  /** Bundle-relative canonical source path. */
  path: string;
  text: string | null;
  hash: string | null;
  baseHash: string;
  adapted: boolean;
  reviewRequired: boolean;
  retained: boolean;
}

export type ExtensionAvailability =
  | "available"
  | "disabled"
  | "removed"
  | "review-required"
  | "invalid"
  | "incompatible"
  | "pending-recovery";

export interface ExtensionView {
  id: string;
  manifest: ExtensionManifest;
  digest: string;
  status: "installed" | "removed";
  requestedEnabled: boolean;
  config: Record<string, ExtensionScalar>;
  bindings: Record<string, string>;
  effectiveConfig: Record<
    string,
    { value: ExtensionScalar; owner: "default" | "project" }
  >;
  sources: Record<string, ExtensionSource>;
  adaptedPaths: string[];
  reviewRequiredPaths: string[];
  availability: ExtensionAvailability;
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionWorkflowView {
  identity: string;
  nativeName: string;
  packageId: string;
  id: string;
  title: string;
  description: string;
  path: string;
  guidance: string[];
}

export interface ExtensionInspection {
  ok: boolean;
  engineVersion: string;
  sourceRoot: string;
  manifest: ExtensionManifest | null;
  digest: string | null;
  files: Record<string, string>;
  compatibility: "compatible" | "incompatible" | "indeterminate";
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionInventory {
  ok: boolean;
  engineVersion: string;
  registryHash: string | null;
  pendingTransaction: boolean;
  packages: ExtensionView[];
  workflows: ExtensionWorkflowView[];
  diagnostics: ExtensionDiagnostic[];
}

export type ExtensionOperation =
  | { kind: "install"; source: string; enable?: boolean }
  | { kind: "enable" | "disable" | "remove"; id: string }
  | { kind: "update"; id: string; source: string }
  | { kind: "reconcile"; id: string; acknowledgeLocal: true }
  | {
      kind: "configure";
      id: string;
      set?: Record<string, ExtensionScalar>;
      bindings?: Record<string, string>;
      reset?: string[];
      unbind?: string[];
    }
  | { kind: "recover" };

export interface ExtensionMutationResult {
  ok: boolean;
  operation: ExtensionOperation["kind"];
  dryRun: boolean;
  changed: boolean;
  affectedPaths: string[];
  diagnostics: ExtensionDiagnostic[];
  inventory: ExtensionInventory;
  rollback?: "complete" | "pending";
}

export interface ExtensionOptions {
  engineVersion?: string;
}

export type ExtensionEvidenceStatus =
  | "pass"
  | "fail"
  | "not-run"
  | "unsupported";

export interface ExtensionValidationPackage {
  id: string;
  manifest: ExtensionManifest;
  digest: string;
  availability: ExtensionAvailability;
  sourceHashes: Record<string, string | null>;
  baseHashes: Record<string, string>;
  configurationHash: string;
  reviewRequiredPaths: string[];
  scenarios: string[];
  diagnostics: ExtensionDiagnostic[];
}

export interface ExtensionValidationResult {
  ok: boolean;
  engineVersion: string;
  mechanical: ExtensionEvidenceStatus;
  protocol: ExtensionEvidenceStatus;
  behavioral: ExtensionEvidenceStatus;
  registryHash: string | null;
  packages: ExtensionValidationPackage[];
  candidate?: ExtensionInspection;
  update?: ExtensionMutationResult;
  diagnostics: ExtensionDiagnostic[];
}
