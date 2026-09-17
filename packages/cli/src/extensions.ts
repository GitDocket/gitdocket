import {
  DOCKET_VERSION,
  type ExtensionInventory,
  type ExtensionOperation,
  type ExtensionScalar,
  findRepoRoot,
  inspectExtensionPackage,
  mutateExtension,
  readExtensions,
  validateExtensions,
} from "@gitdocket/core";
import type { Command } from "commander";
import { refreshExtensionDiscovery } from "./extension-discovery";

interface OutputOptions {
  json?: boolean;
  dryRun?: boolean;
}

/** Discovery carries source identity; complete Markdown stays in the source reader. */
export function summarizeExtensionInventory(inventory: ExtensionInventory) {
  return {
    ...inventory,
    packages: inventory.packages.map(({ sources, ...entry }) => ({
      ...entry,
      sources: Object.fromEntries(
        Object.entries(sources).map(([path, { text: _text, ...source }]) => [
          path,
          source,
        ]),
      ),
    })),
  };
}

/** Human rendering keeps the same evidence as JSON, with readable key/value nesting. */
export function renderExtensionResult(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}(none)`;
    return value.map((entry) => renderExtensionResult(entry, depth)).join("\n");
  }
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([key, entry]) =>
        entry && typeof entry === "object"
          ? `${indent}${key}:\n${renderExtensionResult(entry, depth + 1)}`
          : `${indent}${key}: ${String(entry ?? "(absent)")}`,
      )
      .join("\n");
  return `${indent}${String(value ?? "(absent)")}`;
}

function objectArgument(source: string | undefined, label: string) {
  if (source === undefined) return undefined;
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function choicesArgument(source: string | undefined) {
  const value = objectArgument(source, "--set");
  if (!value) return undefined;
  const entries = Object.entries(value).map(
    ([key, entry]): [string, ExtensionScalar] => {
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry))
      )
        return [key, entry];
      throw new Error(`--set.${key} must be a finite JSON scalar`);
    },
  );
  return Object.fromEntries(entries);
}

function bindingsArgument(source: string | undefined) {
  const value = objectArgument(source, "--bindings");
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "string")
        throw new Error(`--bindings.${key} must name an existing host tool`);
      return [key, entry];
    }),
  );
}

export function registerExtensions(
  program: Command,
  bundleRoot: () => Promise<string>,
  print: (value: string) => Promise<void>,
): void {
  const extension = program
    .command("extension")
    .description("inspect and manage local workflow content packages");

  const projectForBundle = async (root: string) => {
    const project =
      (await findRepoRoot(root)) ?? (await findRepoRoot(process.cwd()));
    if (!project)
      throw new Error("No project root found for extension pointer refresh.");
    return project;
  };
  const mutate = async (
    operation: ExtensionOperation,
    options: OutputOptions,
  ) => {
    const root = await bundleRoot();
    const result = await mutateExtension(root, operation, {
      dryRun: options.dryRun,
    });
    if (!result.ok) return result;
    try {
      const discovery = await refreshExtensionDiscovery(
        await projectForBundle(root),
        root,
        {
          dryRun: options.dryRun,
          ...(options.dryRun ? { inventory: result.inventory } : {}),
        },
      );
      return { ...result, lifecycleOk: true, ok: discovery.ok, discovery };
    } catch (error) {
      return {
        ...result,
        lifecycleOk: true,
        ok: false,
        diagnostics: [
          ...result.diagnostics,
          {
            code: "discovery-refresh-failed",
            severity: "error",
            message: String(error),
            remediation:
              "The source lifecycle result is retained. Resolve the destination issue and run docket extension refresh; stale pointers still require a fresh availability read.",
          },
        ],
      };
    }
  };

  const run = async (
    options: OutputOptions,
    operation: () => Promise<unknown>,
  ) => {
    try {
      const result = await operation();
      await print(
        options.json
          ? JSON.stringify(result, null, 2)
          : renderExtensionResult(result),
      );
      if (
        result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false
      )
        process.exitCode = 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        ok: false,
        engineVersion: DOCKET_VERSION,
        diagnostics: [{ code: "cli-error", severity: "error", message }],
      };
      await print(
        options.json
          ? JSON.stringify(result, null, 2)
          : renderExtensionResult(result),
      );
      process.exitCode = 1;
    }
  };

  extension
    .command("refresh")
    .description(
      "refresh owned discovery pointers from current authoritative state",
    )
    .option("--dry-run", "inspect pointer changes without writing")
    .option("--json", "machine-readable output")
    .action((options: OutputOptions) =>
      run(options, async () => {
        const root = await bundleRoot();
        return refreshExtensionDiscovery(await projectForBundle(root), root, {
          dryRun: options.dryRun,
        });
      }),
    );

  extension
    .command("inspect <source>")
    .description("validate a local package and inspect exact identity/content")
    .option("--json", "machine-readable output")
    .action((source: string, options: OutputOptions) =>
      run(options, async () =>
        inspectExtensionPackage(source, { bundleRoot: await bundleRoot() }),
      ),
    );

  extension
    .command("list")
    .description("read package availability and qualified workflow names")
    .option("--json", "machine-readable output")
    .action((options: OutputOptions) =>
      run(options, async () =>
        summarizeExtensionInventory(await readExtensions(await bundleRoot())),
      ),
    );

  extension
    .command("show <id>")
    .description("read installed sources, ownership, choices and diagnostics")
    .option("--json", "machine-readable output")
    .action((id: string, options: OutputOptions) =>
      run(options, async () => {
        const inventory = await readExtensions(await bundleRoot());
        const found = inventory.packages.find((entry) => entry.id === id);
        if (!found) throw new Error(`extension ${id} is not installed`);
        return { engineVersion: inventory.engineVersion, ...found };
      }),
    );

  extension
    .command("install <source>")
    .description("install a pinned local package, disabled unless requested")
    .option("--enable", "request immediate compatible workflow availability")
    .option("--dry-run", "report projected changes without writing")
    .option("--json", "machine-readable output")
    .action((source: string, options: OutputOptions & { enable?: boolean }) =>
      run(options, async () =>
        mutate({ kind: "install", source, enable: options.enable }, options),
      ),
    );

  extension
    .command("update <id> <source>")
    .description("preflight a newer package and preserve project adaptations")
    .option("--dry-run", "report projected changes without writing")
    .option("--json", "machine-readable output")
    .action((id: string, source: string, options: OutputOptions) =>
      run(options, () => mutate({ kind: "update", id, source }, options)),
    );

  extension
    .command("reconcile <id>")
    .description(
      "acknowledge exact current source bytes after reviewing adaptations",
    )
    .requiredOption(
      "--acknowledge-local",
      "confirm current local content has been reviewed",
    )
    .option("--dry-run", "report projected review hashes without writing")
    .option("--json", "machine-readable output")
    .action((id: string, options: OutputOptions) =>
      run(options, () =>
        mutate({ kind: "reconcile", id, acknowledgeLocal: true }, options),
      ),
    );

  extension
    .command("validate [id]")
    .description(
      "report mechanical checks and separate unrun protocol/behavioral evidence",
    )
    .option("--candidate <source>", "preflight a proposed local package update")
    .option("--json", "machine-readable output")
    .action(
      (
        id: string | undefined,
        options: OutputOptions & { candidate?: string },
      ) =>
        run(options, async () =>
          validateExtensions(await bundleRoot(), {
            id,
            candidate: options.candidate,
          }),
        ),
    );

  for (const kind of ["enable", "disable", "remove"] as const)
    extension
      .command(`${kind} <id>`)
      .description(
        kind === "remove"
          ? "retire discovery while retaining source, choices and project history"
          : `${kind} future discovery of an installed workflow package`,
      )
      .option("--dry-run", "report projected changes without writing")
      .option("--json", "machine-readable output")
      .action((id: string, options: OutputOptions) =>
        run(options, async () => mutate({ kind, id }, options)),
      );

  extension
    .command("configure <id>")
    .description("set inspectable project choices and existing-host tool hints")
    .option("--set <json>", "JSON object of project configuration overrides")
    .option("--bindings <json>", "JSON object of capability-to-host-tool hints")
    .option("--reset <key>", "remove a project override and use its default")
    .option("--unbind <capability>", "remove a project host-tool hint")
    .option("--dry-run", "report projected changes without writing")
    .option("--json", "machine-readable output")
    .action(
      (
        id: string,
        options: OutputOptions & {
          set?: string;
          bindings?: string;
          reset?: string;
          unbind?: string;
        },
      ) =>
        run(options, async () =>
          mutate(
            {
              kind: "configure",
              id,
              set: choicesArgument(options.set),
              bindings: bindingsArgument(options.bindings),
              reset: options.reset ? [options.reset] : undefined,
              unbind: options.unbind ? [options.unbind] : undefined,
            },
            options,
          ),
        ),
    );

  extension
    .command("recover")
    .description("inspect or roll back an interrupted owned extension mutation")
    .option("--dry-run", "report recovery without writing")
    .option("--json", "machine-readable output")
    .action((options: OutputOptions) =>
      run(options, async () => mutate({ kind: "recover" }, options)),
    );
}
