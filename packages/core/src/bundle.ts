// Bundle loading: FileStore → parsed concept graph with ID resolution
// (aliases included), duplicate detection, and derived readiness.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILENAME, type DocketConfig, parseConfig } from "./config";
import { type FileStore, LocalFileStore } from "./filestore";
import {
  type Concept,
  type Decision,
  type Diagnostic,
  parseConcept,
  type WorkItem,
} from "./parse";
import { buildSchemas } from "./schema";
import { byManualOrder, isReady, isStatus, type Status } from "./states";

export interface Bundle {
  config: DocketConfig;
  concepts: Concept[];
  workItems: WorkItem[];
  decisions: Decision[];
  diagnostics: Diagnostic[];
  /** Resolve a work item or decision by id — aliases included. */
  byId(id: string): WorkItem | Decision | undefined;
  statusById: ReadonlyMap<string, Status>;
  /** Tasks that are `todo` with every dependency `done`. Derived, never stored. */
  readyIds(): string[];
}

/**
 * The canonical ready queue used by every surface, including bare
 * `docket task start`. Readiness comes from the bundle; manual rank and
 * priority supply the user-controlled order, with task ID as the stable
 * fallback.
 */
export function readyWorkItems(bundle: Bundle): WorkItem[] {
  return bundle
    .readyIds()
    .map((id) => bundle.byId(id))
    .filter((item): item is WorkItem => item?.kind === "work")
    .sort((a, z) => byManualOrder(a.fm, z.fm));
}

export async function loadBundle(
  store: FileStore,
  config: DocketConfig,
): Promise<Bundle> {
  const schemas = buildSchemas(config);
  const concepts: Concept[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const path of await store.list()) {
    const parsed = parseConcept(path, await store.read(path), schemas);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.concept) concepts.push(parsed.concept);
  }

  const workItems = concepts.filter((c): c is WorkItem => c.kind === "work");
  const decisions = concepts.filter(
    (c): c is Decision => c.kind === "decision",
  );

  const index = new Map<string, WorkItem | Decision>();
  for (const item of [...workItems, ...decisions]) {
    for (const id of [item.fm.id, ...item.fm.aliases]) {
      const existing = index.get(id);
      if (existing) {
        diagnostics.push({
          path: item.path,
          message: `duplicate id ${id} (also in ${existing.path})`,
          severity: "error",
        });
      } else {
        index.set(id, item);
      }
    }
  }

  const statusById = new Map<string, Status>();
  for (const item of workItems) {
    if (isStatus(item.fm.status)) {
      for (const id of [item.fm.id, ...item.fm.aliases])
        statusById.set(id, item.fm.status);
    }
  }

  return {
    config,
    concepts,
    workItems,
    decisions,
    diagnostics,
    byId: (id) => index.get(id),
    statusById,
    readyIds: () =>
      workItems
        .filter((w) => w.fm.type === "Task")
        .filter((w) => isReady(w.fm.status, w.fm.depends_on, statusById))
        .map((w) => w.fm.id),
  };
}

/** Walk upward from `start` to the nearest directory containing docket.yaml. */
export async function findRepoRoot(start: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    const found = await readFile(join(dir, CONFIG_FILENAME), "utf8").then(
      () => true,
      () => false,
    );
    if (found) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Convenience: load the bundle of a repo checkout from its docket.yaml. */
export async function loadRepo(repoRoot: string): Promise<Bundle> {
  const configSource = await readFile(
    join(repoRoot, CONFIG_FILENAME),
    "utf8",
  ).catch(() => undefined);
  const config = parseConfig(configSource);
  return loadBundle(new LocalFileStore(join(repoRoot, config.bundle)), config);
}
