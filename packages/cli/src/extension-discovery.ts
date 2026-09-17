import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type ExtensionDiagnostic,
  type ExtensionInventory,
  type ExtensionWorkflowView,
  LocalFileStore,
  readExtensions,
} from "@gitdocket/core";
import {
  AGENT_ADAPTERS,
  AGENT_TARGETS,
  type AgentTarget,
} from "./agent-adapters";

export interface ExtensionDiscoveryStep {
  path: string;
  action:
    | "create"
    | "update"
    | "remove"
    | "unchanged"
    | "conflict"
    | "unsupported";
  reason?: string;
}

export interface ExtensionDiscoveryReport {
  ok: boolean;
  dryRun: boolean;
  changed: boolean;
  engineVersion: string;
  registryHash: string | null;
  steps: ExtensionDiscoveryStep[];
  diagnostics: ExtensionDiagnostic[];
}

const MAX_POINTER_BYTES = 1024 * 1024;
const NATIVE_NAME_LIMIT = 64;
const NATIVE_DESCRIPTION_LIMIT = 1024;
const SECTION_END = "<!-- <<< docket-extension-discovery <<< -->";
const SECTION =
  /<!-- >>> docket-extension-discovery@1 prefix=(0|2) sha256=([a-f0-9]{64}) >>> -->\n([\s\S]*?)<!-- <<< docket-extension-discovery <<< -->\n?/g;
const POINTER =
  /^<!-- docket-extension-pointer@1 ([a-z][a-z0-9-]*:[a-z][a-z0-9-]*) sha256=([a-f0-9]{64}) -->\n/gm;
const sha = (source: string) =>
  createHash("sha256").update(source, "utf8").digest("hex");
const absent = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";
const diag = (
  code: string,
  message: string,
  path?: string,
): ExtensionDiagnostic => ({
  code,
  message,
  path,
  severity: "error",
  remediation:
    "Preserve handwritten content, resolve the reported destination or source conflict, then run docket extension refresh --dry-run and docket extension refresh. Canonical availability remains authoritative.",
});
const oneLine = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/[\\`*_[\]]/g, "\\$&")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const literal = (text: string) =>
  JSON.stringify(text)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
const nativeDescription = (workflow: ExtensionWorkflowView) =>
  `${workflow.identity} — ${workflow.description}`;

/** The native name cap is this adapter's explicit support boundary. It never
 * changes the package's canonical identity or claims fresh-host qualification. */
export function renderExtensionSkill(
  workflow: ExtensionWorkflowView,
  bundlePath: string,
): string {
  const source = `${bundlePath.replace(/\/$/, "")}/${workflow.path}`;
  const body = `---
name: ${workflow.nativeName}
description: ${literal(nativeDescription(workflow))}
---

Before every invocation, including continuation in an already-running session, read fresh authoritative availability with \`docket extension list --json\` and \`docket extension show ${workflow.packageId} --json\`, or the host-exposed read-only MCP tool \`workflow_extensions\`. Require the exact identity \`${workflow.identity}\` to be currently available. Missing, disabled, removed, incompatible, invalid, review-required or pending-recovery state stops invocation; this cached pointer never overrides current state.

Read the current canonical workflow at ${literal(source)} using the filesystem, \`docket source <bundle-relative-path> --json\`, or MCP \`source_page\`; the exact bundle-relative path is ${literal(workflow.path)}. Treat paths as literal data and follow source continuations. Read current effectiveConfig with default/project ownership and bindings before selecting commands or reviewers. Read the package's listed guidance, relevant linked templates/procedures and optional project guidance, then follow the workflow only within the user's authorized scope. Package defaults cannot weaken project requirements; report material contradictions for judgment under user/host/repository precedence.

Installation, discovery and proposal-only work grant no task creation/pickup, execution of unrelated procedures or external-write authority. Direct work stays direct; tracked work requires its existing explicit pickup authority. Tool bindings are hints for already exposed host tools and never install servers, credentials or permissions. Keep authored project records outside package-owned sources. Fresh sessions can discover this pointer; an already-running host may require explicit rereading or a new session to notice discovery changes.
`;
  return `${body}\n<!-- docket-extension-pointer@1 ${workflow.identity} sha256=${sha(body)} -->\n`;
}

function ownedPointer(text: string, nativeName: string): boolean {
  const matches = [...text.matchAll(POINTER)];
  const match = matches[0];
  if (matches.length !== 1 || !match) return false;
  const identity = match[1];
  if (`docket-ext-${identity?.replace(":", "-")}` !== nativeName) return false;
  // Renderer adds one separator newline before its ownership marker.
  return sha(text.replace(match[0], "").replace(/\n$/, "")) === match[2];
}

function sectionBody(
  workflows: ExtensionWorkflowView[],
  bundlePath: string,
): string {
  return `## Installed workflow extensions

These are discovery pointers. Before every relevant invocation or continuation, read fresh \`docket extension list --json\` and \`docket extension show <package-id> --json\`, or MCP \`workflow_extensions\`. Require the exact qualified workflow to be available, then read its current canonical source through the filesystem, \`docket source <bundle-relative-path> --json\`, or MCP \`source_page\`, following continuations. Read current effectiveConfig with default/project ownership and bindings, package guidance, relevant linked templates/procedures and project guidance. This snapshot contains no cached project choices and cannot override disabled, removed, incompatible, missing, locally edited or unresolved current sources.

${workflows.map((workflow) => `- \`${workflow.identity}\` — ${oneLine(workflow.title)}: ${oneLine(workflow.description)} Source: ${literal(`${bundlePath.replace(/\/$/, "")}/${workflow.path}`)}.`).join("\n")}

Resolve ambiguous titles to a qualified identity. Preserve user/host/repository precedence and surface material contradictions; package defaults cannot weaken project requirements. Discovery and proposal preparation do not authorize task creation/pickup, unrelated procedures or external actions. Direct and explicitly tracked work retain their existing intent boundaries. Already-running sessions must reread current availability; the host may require a new session to discover newly generated native pointers.

`;
}

function composeSection(
  existing: string | null,
  body: string | null,
): { text: string | null; conflict?: string } {
  const original = existing ?? "";
  const matches = [...original.matchAll(SECTION)];
  const match = matches[0];
  const hasMarker = original.includes("docket-extension-discovery");
  if ((hasMarker && matches.length !== 1) || matches.length > 1)
    return {
      text: existing,
      conflict:
        "Malformed or competing extension discovery spans; preserve and reconcile them manually.",
    };
  if (match) {
    const prefix = Number(match[1]);
    const start = (match.index ?? 0) - prefix;
    if (
      sha(match[3] ?? "") !== match[2] ||
      start < 0 ||
      (prefix === 2 && original.slice(start, start + 2) !== "\n\n")
    )
      return {
        text: existing,
        conflict:
          "Extension discovery span was edited after generation; handwritten changes remain untouched.",
      };
    const section =
      body === null
        ? ""
        : `${"\n".repeat(prefix)}<!-- >>> docket-extension-discovery@1 prefix=${prefix} sha256=${sha(body)} >>> -->\n${body}${SECTION_END}\n`;
    const text =
      original.slice(0, start) +
      section +
      original.slice((match.index ?? 0) + match[0].length);
    return { text: text || null };
  }
  if (body === null) return { text: existing };
  const prefix = original ? 2 : 0;
  return {
    text: `${original}${"\n".repeat(prefix)}<!-- >>> docket-extension-discovery@1 prefix=${prefix} sha256=${sha(body)} >>> -->\n${body}${SECTION_END}\n`,
  };
}

async function safePath(root: string, path: string): Promise<void> {
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Unsafe discovery destination: ${path}`);
  let current = resolve(root);
  if (!(await lstat(current)).isDirectory())
    throw new Error("Project root is not a regular directory.");
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    const names = await readdir(current);
    if (
      names.some(
        (name) => name !== part && name.toLowerCase() === part.toLowerCase(),
      )
    )
      throw new Error(`Case-insensitive destination collision at ${path}.`);
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        (index < parts.length - 1
          ? !info.isDirectory()
          : !info.isDirectory() && !info.isFile())
      )
        throw new Error(
          `Symlink or nonregular discovery destination at ${path}.`,
        );
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
  }
}

async function readPointer(root: string, path: string): Promise<string | null> {
  await safePath(root, path);
  try {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.size > MAX_POINTER_BYTES)
      throw new Error(
        `Discovery file is not a regular file within the 1 MiB pointer limit: ${path}`,
      );
    const bytes = await readFile(join(root, path));
    if (bytes.length > MAX_POINTER_BYTES)
      throw new Error(`Discovery file exceeds 1 MiB: ${path}`);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

interface WritePlan {
  path: string;
  before: string | null;
  after: string | null;
}

/** Refresh only derivative owned pointers; authoritative state is never written
 * here. Each stale pointer requires fresh availability before any invocation. */
export async function refreshExtensionDiscovery(
  repoRoot: string,
  bundleRoot: string,
  options: {
    dryRun?: boolean;
    inventory?: ExtensionInventory;
    nativeTargets?: AgentTarget[];
    engineVersion?: string;
  } = {},
): Promise<ExtensionDiscoveryReport> {
  const dryRun = options.dryRun ?? false;
  const store = new LocalFileStore(bundleRoot);
  return store.withMutation(async () => {
    const inventory =
      dryRun && options.inventory
        ? options.inventory
        : await readExtensions(bundleRoot, {
            engineVersion: options.engineVersion,
          });
    const report: ExtensionDiscoveryReport = {
      ok: inventory.ok,
      dryRun,
      changed: false,
      engineVersion: inventory.engineVersion,
      registryHash: inventory.registryHash,
      steps: [],
      diagnostics: [
        ...inventory.diagnostics,
        ...inventory.packages.flatMap((entry) => entry.diagnostics),
      ],
    };
    const bundlePath = relative(repoRoot, bundleRoot).replaceAll("\\", "/");
    if (!bundlePath || bundlePath.startsWith("../") || isAbsolute(bundlePath)) {
      report.ok = false;
      report.diagnostics.push(
        diag(
          "unsupported-bundle-location",
          "Discovery requires a bundle inside the project root.",
        ),
      );
      return report;
    }
    const plans: WritePlan[] = [];
    const conflict = (
      path: string,
      reason: string,
      action: "conflict" | "unsupported" = "conflict",
    ) => {
      report.ok = false;
      report.steps.push({ path, action, reason });
      report.diagnostics.push(diag(`discovery-${action}`, reason, path));
    };
    const plan = (
      path: string,
      before: string | null,
      after: string | null,
    ) => {
      if (
        after !== null &&
        Buffer.byteLength(after, "utf8") > MAX_POINTER_BYTES
      ) {
        conflict(
          path,
          "Generated discovery output would exceed the 1 MiB pointer inspection limit; the existing destination is preserved so future refresh and withdrawal remain possible.",
          "unsupported",
        );
        return;
      }
      report.steps.push({
        path,
        action:
          before === after
            ? "unchanged"
            : after === null
              ? "remove"
              : before === null
                ? "create"
                : "update",
      });
      if (before !== after) plans.push({ path, before, after });
    };
    const body = inventory.workflows.length
      ? sectionBody(inventory.workflows, bundlePath)
      : null;
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const before = await readPointer(repoRoot, name);
        if (body === null && !before?.includes("docket-extension-discovery"))
          continue;
        if (before === null && (name !== "AGENTS.md" || body === null))
          continue;
        const composed = composeSection(before, body);
        if (composed.conflict) conflict(name, composed.conflict);
        else plan(name, before, composed.text);
      } catch (error) {
        conflict(name, String(error));
      }
    }
    for (const target of AGENT_TARGETS) {
      const root = AGENT_ADAPTERS[target].skillsRoot.replaceAll("\\", "/");
      let names: string[] = [];
      try {
        await safePath(repoRoot, root);
        try {
          names = await readdir(join(repoRoot, root));
        } catch (error) {
          if (!absent(error)) throw error;
          if (!options.nativeTargets?.includes(target)) continue;
        }
      } catch (error) {
        conflict(root, String(error));
        continue;
      }
      const desired = new Map<string, ExtensionWorkflowView>();
      const candidates = new Set(
        inventory.workflows.map((workflow) => workflow.nativeName),
      );
      for (const name of candidates) {
        const matches = inventory.workflows.filter(
          (workflow) => workflow.nativeName === name,
        );
        const path = `${root}/${name}/SKILL.md`;
        if (matches.length > 1)
          conflict(
            path,
            `Native name collides between ${matches.map((workflow) => workflow.identity).join(", ")}; neither owner is selected.`,
          );
        else if (name.length > NATIVE_NAME_LIMIT)
          conflict(
            path,
            `Native name has ${name.length} characters; the v1 ${target} adapter supports at most ${NATIVE_NAME_LIMIT}. Use canonical portable invocation.`,
            "unsupported",
          );
        else if (
          matches[0] &&
          [...nativeDescription(matches[0])].length > NATIVE_DESCRIPTION_LIMIT
        )
          conflict(
            path,
            `Formatted native description exceeds the v1 ${target} adapter's ${NATIVE_DESCRIPTION_LIMIT}-character limit. Use canonical portable invocation.`,
            "unsupported",
          );
        else if (matches[0]) desired.set(name, matches[0]);
      }
      for (const name of new Set([
        ...names.filter((name) => name.startsWith("docket-ext-")),
        ...desired.keys(),
      ])) {
        const path = `${root}/${name}/SKILL.md`;
        try {
          const before = await readPointer(repoRoot, path);
          const workflow = desired.get(name);
          if (before !== null && !ownedPointer(before, name)) {
            if (
              workflow ||
              candidates.has(name) ||
              before.includes("docket-extension-pointer@1 ")
            )
              conflict(
                path,
                "Handwritten or locally edited native stub occupies this destination; it remains untouched.",
              );
            continue;
          }
          if (before === null && !workflow) continue;
          plan(
            path,
            before,
            workflow ? renderExtensionSkill(workflow, bundlePath) : null,
          );
        } catch (error) {
          conflict(path, String(error));
        }
      }
    }
    if (dryRun) {
      report.changed = plans.length > 0;
      return report;
    }
    // Validate the entire plan before its first write, then recheck each file
    // immediately before publication. Independent safe destinations can still
    // refresh when an adapter-only conflict affects another destination.
    for (const item of plans) {
      try {
        if ((await readPointer(repoRoot, item.path)) !== item.before)
          throw new Error("Destination changed during refresh planning.");
      } catch (error) {
        conflict(item.path, String(error));
        return report;
      }
    }
    for (const item of plans) {
      const temporary = join(
        repoRoot,
        dirname(item.path),
        `.docket-extension-${randomUUID()}.tmp`,
      );
      try {
        if ((await readPointer(repoRoot, item.path)) !== item.before)
          throw new Error("Destination changed before refresh publication.");
        if (item.after === null) {
          await unlink(join(repoRoot, item.path));
          if (item.path.endsWith("/SKILL.md"))
            await rmdir(join(repoRoot, dirname(item.path))).catch(
              () => undefined,
            );
        } else {
          await mkdir(join(repoRoot, dirname(item.path)), { recursive: true });
          await safePath(repoRoot, item.path);
          await writeFile(temporary, item.after, {
            encoding: "utf8",
            flag: "wx",
          });
          await safePath(repoRoot, item.path);
          if ((await readPointer(repoRoot, item.path)) !== item.before)
            throw new Error(
              "Destination changed while preparing the replacement; the handwritten edit was preserved.",
            );
          await rename(temporary, join(repoRoot, item.path));
        }
        report.changed = true;
      } catch (error) {
        conflict(
          item.path,
          `Pointer refresh is incomplete: ${String(error)}. Source lifecycle changes remain committed; rerun extension refresh after resolving this destination.`,
        );
        break;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
    return report;
  });
}
