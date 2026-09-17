import type { RepositoryOwner } from "./owner";

type Inventory = Extract<
  Awaited<ReturnType<RepositoryOwner["extensions"]>>,
  { status: "supported" }
>;
const MAX_BYTES = 24_000;
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value, null, 2));

/** Count and byte bounded discovery. Oversized choices remain available through CLI show;
 * never present clipped policy text as the complete requirement or executable choice. */
export function extensionPage(
  inventory: Inventory,
  id: string | undefined,
  offset: number,
  limit: number,
) {
  const matching = inventory.packages.filter((entry) => !id || entry.id === id);
  const selected = matching.slice(offset, offset + limit);
  const diagnostics = inventory.diagnostics.slice(0, 8).map((entry) => ({
    ...entry,
    message: entry.message.slice(0, 1024),
    remediation: entry.remediation.slice(0, 1024),
    ...(entry.path ? { path: entry.path.slice(0, 512) } : {}),
  }));
  // UTF-8/JSON escaping can expand authored diagnostic text beyond character caps.
  while (bytes(diagnostics) > 8_000) diagnostics.pop();
  const diagnosticsLimited =
    JSON.stringify(diagnostics) !== JSON.stringify(inventory.diagnostics);
  const base = {
    status: inventory.status,
    ok:
      !inventory.diagnostics.some((entry) => entry.severity === "error") &&
      selected.every(
        (entry) =>
          !entry.diagnostics.some(
            (diagnostic) => diagnostic.severity === "error",
          ),
      ),
    inventoryOk: inventory.ok,
    engineVersion: inventory.engineVersion,
    registryHash: inventory.registryHash,
    pendingTransaction: inventory.pendingTransaction,
    totalPackages: matching.length,
    unavailablePackagesInInventory: inventory.packages.filter(
      (entry) => entry.availability !== "available",
    ).length,
    diagnostics,
    diagnosticsLimited,
    ...(diagnosticsLimited
      ? {
          diagnosticsRemediation:
            "Read complete diagnostics with docket extension list --json.",
        }
      : {}),
  };
  const packages: unknown[] = [];
  const workflows: Inventory["workflows"] = [];
  let consumed = 0;
  let outputLimited = false;
  for (const entry of selected) {
    const pointers = inventory.workflows.filter(
      (workflow) => workflow.packageId === entry.id,
    );
    if (
      bytes({
        ...base,
        packages: [...packages, entry],
        workflows: [...workflows, ...pointers],
      }) >
      MAX_BYTES - 256
    ) {
      if (packages.length > 0) break;
      packages.push({
        id: entry.id,
        availability: entry.availability,
        digest: entry.digest,
        requestedEnabled: entry.requestedEnabled,
        outputLimited: true,
        omittedFields: [
          "manifest",
          "config",
          "bindings",
          "effectiveConfig",
          "sources",
          "diagnostics",
        ],
        remediation: `This package exceeds the MCP discovery byte limit. Read complete current requirements with docket extension show ${entry.id} --json before invoking it. Workflow pointers are withheld in this response; no configuration text was truncated and presented as authoritative.`,
      });
      outputLimited = true;
    } else {
      packages.push(entry);
      workflows.push(...pointers);
    }
    consumed++;
  }
  return {
    ...base,
    ok:
      !inventory.diagnostics.some((entry) => entry.severity === "error") &&
      selected
        .slice(0, consumed)
        .every(
          (entry) =>
            !entry.diagnostics.some(
              (diagnostic) => diagnostic.severity === "error",
            ),
        ),
    packages,
    workflows,
    outputLimited,
    ...(offset + consumed < matching.length
      ? { nextOffset: offset + consumed }
      : {}),
  };
}
