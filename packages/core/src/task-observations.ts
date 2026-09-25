import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Bundle } from "./bundle";
import type { GitWorktreeEvidence } from "./cache";
import { parseConfig } from "./config";
import { parseMetadataConcept } from "./parse";
import { buildSchemas } from "./schema";

export interface ObservedTask {
  id: string;
  path: string;
  title: string;
  status: string;
  epic?: string;
}
export interface TaskObservation {
  task: ObservedTask;
  base: ObservedTask | null;
  baselineAvailable: boolean;
  head: string;
  refs: string[];
  worktree: string | null;
  active: boolean;
  uncommitted: boolean;
  integrated: boolean;
}
export interface TaskProgress {
  id: string;
  title: string;
  localStatus: string | null;
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
const schemas = buildSchemas(parseConfig());
const MAX_FILE = 256 * 1024;
const MAX_CANDIDATES = 512;
const MAX_SOURCES = 32;
const MAX_CACHE = 2048;

function metadata(path: string, source: string): ObservedTask | null {
  const parsed = parseMetadataConcept(path, source, schemas);
  if (
    /^type:\s*Task\s*$/m.test(source) &&
    parsed.diagnostics.some((d) => d.severity === "error")
  )
    throw new Error(`Invalid task metadata: ${path}`);
  const c = parsed.concept;
  if (c?.kind !== "work" || c.fm.type !== "Task") return null;
  return {
    id: c.fm.id,
    path,
    title: c.fm.title ?? c.fm.id,
    status: c.fm.status,
    ...(c.fm.epic ? { epic: c.fm.epic } : {}),
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
  clear() {
    this.cache.clear();
  }
  private async committed(
    root: string,
    revision: string,
    path: string,
    logical: string,
    run: Run,
  ) {
    const key = `${root}\0${revision}\0${path}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
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
      );
    }
    if (this.cache.size >= MAX_CACHE)
      this.cache.delete(this.cache.keys().next().value ?? "");
    this.cache.set(key, task);
    return task;
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
  ): Promise<TaskObservationEvidence> {
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
    let prefix: string;
    try {
      prefix = `${relative(root, safePath(root, bundlePath)).replaceAll("\\", "/").replace(/\/$/, "")}/`;
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
        for (const path of [...candidates]
          .filter((p) => p.startsWith(prefix) && p.endsWith(".md"))
          .sort()) {
          if (++count > MAX_CANDIDATES || Date.now() >= deadline) {
            fail("Task observation time or candidate budget exceeded");
            break;
          }
          const logical = path.slice(prefix.length);
          try {
            const task = w
              ? metadata(logical, await saved(w.path, path))
              : await this.committed(root, source.head, path, logical, run);
            if (!task) continue;
            const ancestor = await this.committed(
              root,
              base,
              path,
              logical,
              run,
            );
            const active = w?.activeTaskId === task.id;
            // Status inherited from the shared ancestor is not new progress.
            if (
              !active &&
              ancestor?.id === task.id &&
              ancestor.status === task.status
            )
              continue;
            if (merged && !dirty.has(path) && !active) continue;
            result.observations.push({
              task,
              base: ancestor,
              baselineAvailable: true,
              head: source.head,
              refs: source.refs,
              worktree: w?.path ?? null,
              active,
              uncommitted: dirty.has(path),
              integrated: merged && !dirty.has(path),
            });
          } catch (error) {
            fail(
              `${w?.path ?? source.refs.join(",")}:${logical}: ${String(error)}`,
            );
          }
        }
        if (
          w &&
          (await run(w.path, ["rev-parse", "HEAD"])).trim() !== source.head
        ) {
          result.observations.splice(sourceStart);
          throw new Error("Worktree HEAD changed during observation");
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
    const group = groups.get(row.task.id) ?? [];
    group.push(row);
    groups.set(row.task.id, group);
  }
  const pickups = new Map<string, string[]>();
  for (const w of worktrees)
    if (!w.current && w.activeTaskId) {
      const paths = pickups.get(w.activeTaskId) ?? [];
      paths.push(w.path);
      pickups.set(w.activeTaskId, paths);
      if (!groups.has(w.activeTaskId)) groups.set(w.activeTaskId, []);
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
              localStatus !== o.base?.status),
        );
      return {
        id,
        title: local?.fm.title ?? observations[0]?.task.title ?? id,
        localStatus,
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
