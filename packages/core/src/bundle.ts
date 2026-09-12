// Bundle loading: FileStore → parsed concept graph with ID resolution
// (aliases included), duplicate detection, and derived readiness.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILENAME, type DocketConfig, parseConfig } from "./config";
import { mapFiles } from "./file-batch";
import { type FileStore, LocalFileStore } from "./filestore";
import {
  type Concept,
  type Decision,
  type Diagnostic,
  isReserved,
  parseConcept,
  parseMetadataConcept,
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
  return load(store, config, parseConcept);
}

/** Exact frontmatter, ID resolution, readiness and summaries; no link graph.
 * Use loadBundle for lint, search, context packets and any link consumer.
 */
export async function loadMetadataBundle(
  store: FileStore,
  config: DocketConfig,
  options: { signal?: AbortSignal; cache?: boolean } = {},
): Promise<Bundle> {
  // A versioned store can reuse validated metadata without retaining bodies.
  // The complete inventory and version tokens are checked on every call;
  // stores without reliable versions use the fresh canonical projection.
  options.signal?.throwIfAborted();
  if (options.cache === false || !store.version)
    return load(store, config, parseMetadataConcept, options.signal);
  const versionOf = store.version.bind(store);
  let state = metadataStates.get(store);
  if (!state) {
    state = { entries: new Map(), pending: Promise.resolve() };
    metadataStates.set(store, state);
  }
  const owner = state;
  const next = owner.pending.then(async () => {
    options.signal?.throwIfAborted();
    const key = JSON.stringify(config);
    const schemas = buildSchemas(config);
    const paths = (await store.list()).filter((path) => !isReserved(path));
    const entries = await mapFiles(
      paths,
      async (path): Promise<[string, MetadataEntry]> => {
        let version = await versionOf(path);
        const old = owner.key === key ? owner.entries.get(path) : undefined;
        if (old?.version === version) return [path, old];
        for (let attempt = 0; attempt < 3; attempt++) {
          const source = await store.read(path);
          const after = await versionOf(path);
          if (after !== version) {
            version = after;
            continue;
          }
          return [
            path,
            { version, parsed: parseMetadataConcept(path, source, schemas) },
          ];
        }
        throw new Error(`file changed repeatedly while loading: ${path}`);
      },
      options.signal,
    );
    const bundle = assembleBundle(
      config,
      entries.flatMap(([, entry]) =>
        entry.parsed.concept ? [entry.parsed.concept] : [],
      ),
      entries.flatMap(([, entry]) => entry.parsed.diagnostics),
    );
    // Publish only after a complete successful reconciliation.
    owner.entries = new Map(entries);
    owner.key = key;
    return bundle;
  });
  owner.pending = next.then(
    () => {},
    () => {},
  );
  return next;
}

interface MetadataEntry {
  version: string;
  parsed: ReturnType<typeof parseConcept>;
}
const metadataStates = new WeakMap<
  FileStore,
  {
    key?: string;
    entries: Map<string, MetadataEntry>;
    pending: Promise<void>;
  }
>();

/** Reuse a full index's already parsed metadata. Every subsequent operation
 * still reconciles the complete live inventory and versions before using it.
 * This does not authorize a write from a retained read snapshot.
 */
export function seedMetadata(
  store: FileStore,
  config: DocketConfig,
  entries: Iterable<
    readonly [
      string,
      { version?: string; parsed: ReturnType<typeof parseConcept> },
    ]
  >,
): void {
  if (!store.version) return;
  const projected = new Map<string, MetadataEntry>();
  for (const [path, entry] of entries) {
    if (entry.version === undefined || isReserved(path)) continue;
    const { concept, diagnostics } = entry.parsed;
    projected.set(path, {
      version: entry.version,
      parsed: {
        diagnostics,
        ...(concept ? { concept: { ...concept, links: [] } } : {}),
      },
    });
  }
  const state = metadataStates.get(store);
  if (state) {
    state.entries = projected;
    state.key = JSON.stringify(config);
  } else
    metadataStates.set(store, {
      key: JSON.stringify(config),
      entries: projected,
      pending: Promise.resolve(),
    });
}

export function clearMetadata(store: FileStore): void {
  metadataStates.delete(store);
}

async function load(
  store: FileStore,
  config: DocketConfig,
  parse: typeof parseConcept,
  signal?: AbortSignal,
): Promise<Bundle> {
  const schemas = buildSchemas(config);
  const concepts: Concept[] = [];
  const diagnostics: Diagnostic[] = [];

  const parsedFiles = await mapFiles(
    (await store.list()).filter((path) => !isReserved(path)),
    async (path) => parse(path, await store.read(path), schemas),
    signal,
  );
  for (const parsed of parsedFiles) {
    diagnostics.push(...parsed.diagnostics);
    if (parsed.concept) concepts.push(parsed.concept);
  }

  return assembleBundle(config, concepts, diagnostics);
}

/** Rebuild cheap graph derivations from immutable per-file parse results. */
export function assembleBundle(
  config: DocketConfig,
  concepts: Concept[],
  parseDiagnostics: readonly Diagnostic[],
): Bundle {
  const diagnostics = [...parseDiagnostics];

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
