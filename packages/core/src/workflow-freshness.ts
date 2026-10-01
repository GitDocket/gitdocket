/** Actual canonical source comparison; banners/origin stamps do not prove content arrival. */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { FileStore } from "./filestore";
import { parseOrigin, recoverOrigin, shippedWorkflow } from "./shipped";
import { DOCKET_VERSION } from "./version";

const cache = new WeakMap<
  FileStore,
  Map<string, { input: string; result: WorkflowFreshness }>
>();
export interface WorkflowFreshness {
  path: string;
  status:
    | "current"
    | "outdated"
    | "review-required"
    | "unverifiable"
    | "absent"
    | "unavailable";
  sourceVersion?: string;
  origin?: string;
  engineVersion: string;
  reason?: string;
}
export async function readWorkflowFreshness(
  store: FileStore,
  slug = "docket-pickup",
): Promise<WorkflowFreshness> {
  const path = `workflows/${slug}.md`;
  const base = { path, engineVersion: DOCKET_VERSION };
  let input: string | undefined;
  try {
    try {
      input = await store.version?.(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { ...base, status: "absent" };
      throw error;
    }
    if (input) {
      const previous = cache.get(store)?.get(path);
      if (previous?.input === input) return previous.result;
    }
    if (!(await store.list()).includes(path))
      return { ...base, status: "absent" };
    const source = await store.read(path);
    if (Buffer.byteLength(source) > 262144)
      return {
        ...base,
        status: "unavailable",
        reason: "Canonical workflow exceeds the 256 KiB comparison budget.",
      };
    const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(source);
    const fields = match ? parseYaml(match[2] ?? "") : undefined;
    const valid =
      fields &&
      typeof fields === "object" &&
      !Array.isArray(fields) &&
      fields.type === "Workflow" &&
      typeof fields.title === "string";
    const body =
      match && valid ? source.slice(match[0].length).trim() : undefined;
    const stamp =
      valid && typeof fields.origin === "string" ? fields.origin : undefined;
    const origin = stamp ? parseOrigin(stamp) : recoverOrigin(source);
    const current = shippedWorkflow(slug, DOCKET_VERSION)?.trim();
    const historical =
      origin && origin.slug === slug
        ? shippedWorkflow(slug, origin.version)?.trim()
        : undefined;
    const status =
      body !== undefined && current !== undefined && body === current
        ? "current"
        : body !== undefined && historical !== undefined && body === historical
          ? "outdated"
          : origin?.slug === slug && historical !== undefined
            ? "review-required"
            : "unverifiable";
    const result: WorkflowFreshness = {
      ...base,
      status,
      sourceVersion: createHash("sha256").update(source).digest("hex"),
      ...(stamp && Buffer.byteLength(stamp) <= 128 ? { origin: stamp } : {}),
      ...(status === "current"
        ? {}
        : {
            reason:
              status === "outdated"
                ? "Canonical body matches an older shipped workflow; review the current source before invocation."
                : status === "review-required"
                  ? "Canonical body differs from current shipped instructions; differences may be authored policy or stale text. Review without overwriting customization."
                  : "Canonical workflow provenance/content equivalence cannot be established; inspect its source before invocation.",
          }),
    };
    if (input && (await store.version?.(path)) === input) {
      let entries = cache.get(store);
      if (!entries) {
        entries = new Map();
        cache.set(store, entries);
      }
      if (entries.size >= 16) entries.delete(entries.keys().next().value ?? "");
      entries.set(path, { input, result });
    }
    return result;
  } catch {
    return {
      ...base,
      status: "unavailable",
      reason:
        "Canonical workflow source could not be compared; do not infer arrival from a version stamp.",
    };
  }
}
