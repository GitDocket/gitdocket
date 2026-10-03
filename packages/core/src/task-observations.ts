import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Bundle } from "./bundle";
import type { GitWorktreeEvidence } from "./cache";
import { CONFIG_FILENAME, type DocketConfig, parseConfig } from "./config";
import { parseMetadataConcept } from "./parse";
import { buildSchemas, type Schemas } from "./schema";

export interface ObservedTask {
  id: string;
  path: string;
  title: string;
  status: string;
  version?: string;
  epic?: string;
}
export interface TaskObservation {
  task: ObservedTask;
  base: ObservedTask | null;
  baselineAvailable: boolean;
  head: string;
  baselineRevision?: string;
  /** Committed snapshot remains distinct when saved worktree bytes are dirty. */
  committed?: {
    task: ObservedTask | null;
    integrated: boolean;
    configuration: ConfigurationProvenance;
    compatible: boolean;
  };
  refs: string[];
  worktree: string | null;
  active: boolean;
  uncommitted: boolean;
  integrated: boolean;
  configuration?: {
    source: ConfigurationProvenance;
    baseline: ConfigurationProvenance;
    compatible: boolean;
  };
}
export interface ConfigurationProvenance {
  project: string;
  bundle: string;
  version: string;
  origin: "saved" | "committed" | "defaults-missing";
}
interface ObservationConfiguration {
  config: DocketConfig;
  schemas: Schemas;
  provenance: ConfigurationProvenance;
}
export interface TaskProgress {
  id: string;
  title: string;
  localStatus: string | null;
  localPath?: string;
  localVersion?: string;
  state: "observed" | "conflict" | "unavailable";
  pickupSources?: string[];
  pickedUpElsewhere: boolean;
  observations: TaskObservation[];
}
export interface TaskObservationEvidence {
  observedAt: string;
  complete: boolean;
  diagnostics: string[];
  observations: TaskObservation[];
}
export interface TaskProgressEvidence extends TaskObservationEvidence {
  tasks: TaskProgress[];
}

type Run = (cwd: string, args: string[]) => Promise<string>;
type ReadBlobs = (
  cwd: string,
  hashes: readonly string[],
) => Promise<Map<string, Buffer>>;
const MAX_FILE = 256 * 1024;
const MAX_CANDIDATES = 512;
const MAX_SOURCES = 32;
const MAX_CACHE = 2048;

function metadata(
  path: string,
  source: string,
  schemas: Schemas,
): ObservedTask | null {
  const parsed = parseMetadataConcept(path, source, schemas);
  if (parsed.diagnostics.some((d) => d.severity === "error"))
    throw new Error(`Invalid task metadata: ${path}`);
  const c = parsed.concept;
  if (c?.kind !== "work" || c.fm.type !== "Task") return null;
  return {
    id: c.fm.id,
    path,
    title: c.fm.title ?? c.fm.id,
    status: c.fm.status,
    version: createHash("sha256").update(source).digest("hex"),
    ...(c.fm.epic ? { epic: c.fm.epic } : {}),
  };
}

function configuration(
  source: string | null,
  origin: "saved" | "committed",
  fallbackBundle: string,
): ObservationConfiguration {
  if (source !== null) {
    const raw = parseYaml(source);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid observation configuration: expected a mapping");
    for (const key of ["project", "bundle"])
      if (key in raw && (typeof raw[key] !== "string" || !raw[key].trim()))
        throw new Error(`Invalid observation configuration: ${key}`);
  }
  // Older fixtures/repos may have no configuration. Declare the engine defaults
  // and caller's bundle explicitly; never silently fall back after a read error.
  const config =
    source === null
      ? { ...parseConfig(), bundle: fallbackBundle }
      : parseConfig(source);
  return {
    config,
    schemas: buildSchemas(config),
    provenance: {
      project: config.project,
      bundle: config.bundle,
      version: createHash("sha256")
        .update(source ?? JSON.stringify({ defaults: config }))
        .digest("hex"),
      origin: source === null ? "defaults-missing" : origin,
    },
  };
}

function safePath(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
    throw new Error("Task path escapes checkout");
  return full;
}

async function saved(root: string, path: string): Promise<string> {
  const full = safePath(root, path);
  const actual = await realpath(full);
  safePath(await realpath(root), relative(await realpath(root), actual));
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE)
      throw new Error("Task file exceeds read budget or is not a regular file");
    const bytes = Buffer.alloc(MAX_FILE + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      bytesRead > MAX_FILE ||
      before.size !== bytesRead ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Task file changed during observation");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Bounded immutable metadata cache; saved files are always reobserved. */
export class TaskObservationReader {
  private cache = new Map<string, ObservedTask | null>();
  private failures = new Map<string, unknown>();
  private configurations = new Map<string, ObservationConfiguration>();
  clear() {
    this.cache.clear();
    this.failures.clear();
    this.configurations.clear();
  }
  private key(
    root: string,
    revision: string,
    path: string,
    logical: string,
    config: ObservationConfiguration,
  ) {
    return `${root}\0${revision}\0${path}\0${logical}\0${config.provenance.version}`;
  }
  private remember(key: string, task: ObservedTask | null) {
    if (this.cache.size >= MAX_CACHE)
      this.cache.delete(this.cache.keys().next().value ?? "");
    this.cache.set(key, task);
  }
  /** Immutable commits permit a bounded catalog/read batch; saved files stay live. */
  private async prefetch(
    root: string,
    revision: string,
    paths: { path: string; logical: string }[],
    config: ObservationConfiguration,
    run: Run,
    readBlobs: ReadBlobs | undefined,
    deadline: number,
  ) {
    if (!readBlobs) return;
    const missing = paths.filter(
      ({ path, logical }) =>
        !this.cache.has(this.key(root, revision, path, logical, config)),
    );
    for (
      let offset = 0;
      offset < missing.length && Date.now() < deadline;
      offset += 16
    ) {
      const chunk = missing.slice(offset, offset + 16);
      try {
        const listing = await run(root, [
          "ls-tree",
          "-l",
          "-z",
          revision,
          "--",
          ...chunk.map(({ path }) => `:(literal)${path}`),
        ]);
        const entries = new Map<
          string,
          { hash: string; size: number; regular: boolean }
        >();
        for (const entry of listing.split("\0").filter(Boolean)) {
          const tab = entry.indexOf("\t");
          const match = entry
            .slice(0, tab)
            .match(/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40,64})\s+(\d+|-)$/);
          if (tab < 0 || !match) throw new Error("Invalid Git task catalog");
          entries.set(entry.slice(tab + 1), {
            hash: match[3] as string,
            size: Number(match[4]),
            regular:
              match[2] === "blob" &&
              (match[1] === "100644" || match[1] === "100755"),
          });
        }
        const hashes = [
          ...new Set(
            chunk.flatMap(({ path }) => {
              const entry = entries.get(path);
              return entry?.regular &&
                Number.isSafeInteger(entry.size) &&
                entry.size <= MAX_FILE
                ? [entry.hash]
                : [];
            }),
          ),
        ];
        const blobs = await readBlobs(root, hashes);
        for (const { path, logical } of chunk) {
          const key = this.key(root, revision, path, logical, config);
          try {
            const entry = entries.get(path);
            if (!entry) {
              this.remember(key, null);
              continue;
            }
            if (!entry.regular)
              throw new Error("Task is not a regular Git blob");
            if (!Number.isSafeInteger(entry.size) || entry.size > MAX_FILE)
              throw new Error("Task blob exceeds read budget");
            const blob = blobs.get(entry.hash);
            if (!blob || blob.length !== entry.size)
              throw new Error("Task blob does not match pinned catalog");
            this.remember(
              key,
              metadata(logical, blob.toString("utf8"), config.schemas),
            );
          } catch (error) {
            this.failures.set(key, error);
          }
        }
      } catch (error) {
        for (const { path, logical } of chunk)
          this.failures.set(
            this.key(root, revision, path, logical, config),
            error,
          );
      }
    }
  }
  private async committed(
    root: string,
    revision: string,
    path: string,
    logical: string,
    run: Run,
    config: ObservationConfiguration,
  ) {
    const key = this.key(root, revision, path, logical, config);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    if (this.failures.has(key)) throw this.failures.get(key);
    const entry = await run(root, ["ls-tree", "-z", revision, "--", path]);
    let task: ObservedTask | null = null;
    if (entry) {
      if (
        !entry.startsWith("100644 blob ") &&
        !entry.startsWith("100755 blob ")
      )
        throw new Error("Task is not a regular Git blob");
      const size = Number(
        (await run(root, ["cat-file", "-s", `${revision}:${path}`])).trim(),
      );
      if (size > MAX_FILE) throw new Error("Task blob exceeds read budget");
      task = metadata(
        logical,
        await run(root, ["show", `${revision}:${path}`]),
        config.schemas,
      );
    }
    this.remember(key, task);
    return task;
  }

  private async readConfiguration(
    root: string,
    revision: string | null,
    bundle: string,
    run: Run,
  ) {
    const key = revision === null ? null : `${root}\0${revision}\0${bundle}`;
    if (key && this.configurations.has(key))
      return this.configurations.get(key) as ObservationConfiguration;
    let source: string | null = null;
    if (revision === null) {
      try {
        source = await saved(root, CONFIG_FILENAME);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A dangling symlink is unavailable configuration, not an absent file.
        const entry = await lstat(safePath(root, CONFIG_FILENAME)).catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return null;
            throw e;
          },
        );
        if (entry) throw error;
      }
    } else {
      const entry = await run(root, [
        "ls-tree",
        "-z",
        revision,
        "--",
        CONFIG_FILENAME,
      ]);
      if (entry) {
        if (
          !entry.startsWith("100644 blob ") &&
          !entry.startsWith("100755 blob ")
        )
          throw new Error("Configuration is not a regular Git blob");
        const size = Number(
          (
            await run(root, [
              "cat-file",
              "-s",
              `${revision}:${CONFIG_FILENAME}`,
            ])
          ).trim(),
        );
        if (!Number.isFinite(size) || size > MAX_FILE)
          throw new Error("Configuration blob exceeds read budget");
        source = await run(root, ["show", `${revision}:${CONFIG_FILENAME}`]);
      }
    }
    const result = configuration(
      source,
      revision === null ? "saved" : "committed",
      bundle,
    );
    if (key) {
      if (this.configurations.size >= 64)
        this.configurations.delete(
          this.configurations.keys().next().value ?? "",
        );
      this.configurations.set(key, result);
    }
    return result;
  }

  async capture(
    root: string,
    bundlePath: string,
    revision: string,
    worktrees: GitWorktreeEvidence[],
    refs: { ref: string; head: string }[],
    byId: Bundle["byId"],
    run: Run,
    deadline: number,
    readBlobs?: ReadBlobs,
  ): Promise<TaskObservationEvidence> {
    // A failed process/batch is transient evidence, never an immutable cache entry.
    this.failures.clear();
    const result: TaskObservationEvidence = {
      observedAt: new Date().toISOString(),
      complete: true,
      diagnostics: [],
      observations: [],
    };
    const fail = (message: string) => {
      result.complete = false;
      if (result.diagnostics.length < 32) result.diagnostics.push(message);
    };
    try {
      safePath(root, bundlePath);
    } catch {
      fail("Configured bundle is outside the checkout");
      return result;
    }
    const foreign = worktrees.filter((w) => !w.current);
    const represented = new Set(worktrees.map((w) => w.head));
    const sources = [
      ...foreign.map((w) => ({
        head: w.head,
        refs: [
          ...new Set([
            ...refs.filter((r) => r.head === w.head).map((r) => r.ref),
            ...(w.ref ? [w.ref] : []),
          ]),
        ].sort(),
        worktree: w,
      })),
      ...[
        ...new Set(
          refs.filter((r) => !represented.has(r.head)).map((r) => r.head),
        ),
      ].map((head) => ({
        head,
        refs: refs
          .filter((r) => r.head === head)
          .map((r) => r.ref)
          .sort(),
        worktree: null,
      })),
    ];
    // Active and dirty checkouts take precedence over historical branch inventory.
    sources.sort(
      (a, b) =>
        Number(!!(b.worktree?.activeTaskId || b.worktree?.dirty)) -
        Number(!!(a.worktree?.activeTaskId || a.worktree?.dirty)),
    );
    if (sources.length > MAX_SOURCES)
      fail(`Task observation source limit (${MAX_SOURCES}) exceeded`);
    let count = 0;
    for (const source of sources.slice(0, MAX_SOURCES)) {
      if (Date.now() >= deadline || count >= MAX_CANDIDATES) {
        fail("Task observation time or candidate budget exceeded");
        break;
      }
      const w = source.worktree;
      if (w && !w.available) {
        fail(`Worktree unavailable: ${w.path}`);
        continue;
      }
      try {
        const sourceStart = result.observations.length;
        if (
          w &&
          (await run(w.path, ["rev-parse", "HEAD"])).trim() !== source.head
        )
          throw new Error("Worktree HEAD changed during observation");
        const base = (
          await run(root, ["merge-base", revision, source.head])
        ).trim();
        const sourceConfig = await this.readConfiguration(
          w?.path ?? root,
          w ? null : source.head,
          bundlePath,
          run,
        );
        const headConfig = w
          ? await this.readConfiguration(root, source.head, bundlePath, run)
          : sourceConfig;
        const baseConfig = await this.readConfiguration(
          root,
          base,
          bundlePath,
          run,
        );
        const sourceRoot = w?.path ?? root;
        const prefix = `${relative(sourceRoot, safePath(sourceRoot, sourceConfig.config.bundle)).replaceAll("\\", "/").replace(/\/$/, "")}/`;
        const basePrefix = `${relative(root, safePath(root, baseConfig.config.bundle)).replaceAll("\\", "/").replace(/\/$/, "")}/`;
        const headPrefix = `${relative(root, safePath(root, headConfig.config.bundle)).replaceAll("\\", "/").replace(/\/$/, "")}/`;
        const merged = base === source.head;
        const candidates = new Set<string>();
        if (!merged)
          for (const p of (
            await run(root, [
              "diff",
              "--name-only",
              "-z",
              base,
              source.head,
              "--",
              prefix,
              basePrefix,
            ])
          ).split("\0"))
            candidates.add(p);
        const dirty = new Set<string>();
        if (w) {
          for (const args of [
            ["diff", "--name-only", "-z", source.head, "--", prefix],
            ["ls-files", "--others", "--exclude-standard", "-z", "--", prefix],
          ]) {
            for (const p of (await run(w.path, args)).split("\0")) {
              if (p) {
                candidates.add(p);
                dirty.add(p);
              }
            }
          }
          const active = w.activeTaskId ? byId(w.activeTaskId) : undefined;
          if (active) candidates.add(prefix + active.path);
        }
        const paths = [...candidates]
          .filter((p) => p.startsWith(prefix) && p.endsWith(".md"))
          .sort();
        const admitted = paths.slice(0, Math.max(0, MAX_CANDIDATES - count));
        const pinned = (p: string) => ({
          path: p,
          logical: p.slice(prefix.length),
        });
        if (!w)
          await this.prefetch(
            root,
            source.head,
            admitted.map(pinned),
            sourceConfig,
            run,
            readBlobs,
            deadline,
          );
        await this.prefetch(
          root,
          base,
          admitted.map((p) => ({
            path: basePrefix + p.slice(prefix.length),
            logical: p.slice(prefix.length),
          })),
          baseConfig,
          run,
          readBlobs,
          deadline,
        );
        if (w)
          await this.prefetch(
            root,
            source.head,
            admitted.map((p) => ({
              path: headPrefix + p.slice(prefix.length),
              logical: p.slice(prefix.length),
            })),
            headConfig,
            run,
            readBlobs,
            deadline,
          );
        for (const path of paths) {
          if (++count > MAX_CANDIDATES || Date.now() >= deadline) {
            fail("Task observation time or candidate budget exceeded");
            break;
          }
          const logical = path.slice(prefix.length);
          try {
            const task = w
              ? metadata(
                  logical,
                  await saved(w.path, path),
                  sourceConfig.schemas,
                )
              : await this.committed(
                  root,
                  source.head,
                  path,
                  logical,
                  run,
                  sourceConfig,
                );
            if (!task) continue;
            const ancestor = await this.committed(
              root,
              base,
              basePrefix + logical,
              logical,
              run,
              baseConfig,
            );
            const active = w?.activeTaskId === task.id;
            const committed = w
              ? await this.committed(
                  root,
                  source.head,
                  headPrefix + logical,
                  logical,
                  run,
                  headConfig,
                )
              : task;
            // An unchanged inherited copy is not new progress. Body-only edits
            // still matter to a same-task writer; saved status is not committed proof.
            if (
              !active &&
              ancestor?.id === task.id &&
              ancestor.version === task.version &&
              ancestor.version === committed?.version
            )
              continue;
            if (merged && !dirty.has(path) && !active) continue;
            result.observations.push({
              task,
              base: ancestor,
              baselineAvailable: true,
              head: source.head,
              baselineRevision: base,
              committed: {
                task: committed,
                integrated: merged,
                configuration: headConfig.provenance,
                compatible:
                  headConfig.config.project === baseConfig.config.project &&
                  headPrefix === basePrefix,
              },
              refs: source.refs,
              worktree: w?.path ?? null,
              active,
              uncommitted: dirty.has(path),
              integrated: merged && !dirty.has(path),
              configuration: {
                source: sourceConfig.provenance,
                baseline: baseConfig.provenance,
                compatible:
                  sourceConfig.config.project === baseConfig.config.project &&
                  prefix === basePrefix,
              },
            });
          } catch (error) {
            fail(
              `${w?.path ?? source.refs.join(",")}:${logical}: ${String(error)}`,
            );
          }
        }
        if (
          w &&
          ((await run(w.path, ["rev-parse", "HEAD"])).trim() !== source.head ||
            (await this.readConfiguration(w.path, null, bundlePath, run))
              .provenance.version !== sourceConfig.provenance.version)
        ) {
          result.observations.splice(sourceStart);
          throw new Error(
            "Worktree HEAD or configuration changed during observation",
          );
        }
      } catch (error) {
        fail(
          `${w?.path ?? source.refs.join(",")}: baseline or source unavailable: ${String(error)}`,
        );
      }
    }
    return result;
  }
}

export function resolveTaskProgress(
  evidence: TaskObservationEvidence,
  byId: Bundle["byId"],
  currentActiveId?: string | null,
  worktrees: GitWorktreeEvidence[] = [],
): TaskProgressEvidence {
  const groups = new Map<string, TaskObservation[]>();
  for (const row of evidence.observations) {
    const canonical = byId(row.task.id)?.fm.id ?? row.task.id;
    const group = groups.get(canonical) ?? [];
    group.push(row);
    groups.set(canonical, group);
  }
  const pickups = new Map<string, string[]>();
  for (const w of worktrees)
    if (!w.current && w.activeTaskId) {
      const canonical = byId(w.activeTaskId)?.fm.id ?? w.activeTaskId;
      const paths = pickups.get(canonical) ?? [];
      paths.push(w.path);
      pickups.set(canonical, paths);
      if (!groups.has(canonical)) groups.set(canonical, []);
    }
  const tasks = [...groups]
    .map(([id, observations]): TaskProgress => {
      const local = byId(id);
      const localStatus = local?.kind === "work" ? local.fm.status : null;
      const pickupSources =
        pickups.get(id) ??
        observations
          .filter((o) => o.active)
          .flatMap((o) => (o.worktree ? [o.worktree] : []));
      const pickedUpElsewhere = pickupSources.length > 0;
      const conflict =
        pickupSources.length + Number(currentActiveId === id) > 1 ||
        new Set(observations.map((o) => o.task.status)).size > 1 ||
        new Set(observations.map((o) => o.task.path)).size > 1 ||
        observations.some(
          (o) =>
            !o.baselineAvailable ||
            (local && (local.path !== o.task.path || local.fm.id !== id)) ||
            (o.base && o.base.id !== id) ||
            (localStatus !== null &&
              localStatus !== o.task.status &&
              localStatus !== o.base?.status) ||
            (local?.kind === "work" &&
              local.sourceVersion &&
              o.base?.version &&
              o.task.version &&
              o.task.version !== o.base.version &&
              local.sourceVersion !== o.base.version &&
              local.sourceVersion !== o.task.version),
        );
      return {
        id,
        title: local?.fm.title ?? observations[0]?.task.title ?? id,
        localStatus,
        ...(local?.kind === "work"
          ? { localPath: local.path, localVersion: local.sourceVersion }
          : {}),
        state: conflict
          ? "conflict"
          : observations.length
            ? "observed"
            : "unavailable",
        ...(pickupSources.length ? { pickupSources } : {}),
        pickedUpElsewhere,
        observations,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { ...evidence, tasks };
}
