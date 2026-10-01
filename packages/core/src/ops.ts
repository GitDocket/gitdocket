// Write operations. Every surface (CLI, MCP, web, App) calls these — there is
// exactly one write path. Mutations are targeted line edits inside the
// frontmatter block, never a full YAML re-serialize, so hand-authored
// formatting and comments survive.

import { createHash } from "node:crypto";
import {
  isMap,
  isScalar,
  parseDocument,
  stringify as stringifyYaml,
} from "yaml";
import { z } from "zod";
import { type Bundle, loadMetadataBundle } from "./bundle";
import { numberedIdPattern, reservedConceptIds } from "./concept-ids";
import type { DocketConfig } from "./config";
import { mapFiles } from "./file-batch";
import type { FileStore } from "./filestore";
import type { WorkItemIdCoordinator } from "./id-allocation";
import { resolveLink } from "./lint";
import { parseMetadataConcept } from "./parse";
import { buildSchemas } from "./schema";
import {
  canTransitionWorkItem,
  isPriority,
  isStatus,
  type Priority,
  type Status,
  type WorkItemType,
} from "./states";

export interface CreateInput {
  title: string;
  type?: WorkItemType;
  description?: string;
  epic?: string;
  dependsOn?: string[];
  priority?: Priority;
  rank?: number;
  assignee?: string;
  tags?: string[];
  slug?: string;
  /** Complete authored Markdown body; omission retains the legacy skeleton. */
  body?: string;
}

const creationInput = z
  .object({
    title: z.string().trim().min(1).max(8192),
    type: z.enum(["Task", "Epic"]).optional(),
    description: z.string().max(65536).optional(),
    epic: z.string().max(2048).optional(),
    dependsOn: z.array(z.string().min(1).max(256)).max(128).optional(),
    priority: z.enum(["p0", "p1", "p2", "p3"]).optional(),
    rank: z.number().finite().optional(),
    assignee: z.string().max(2048).optional(),
    tags: z.array(z.string().min(1).max(1024)).max(128).optional(),
    slug: z.string().optional(),
    body: z.string().min(1).max(65536).optional(),
  })
  .strict();

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "item"
  );
}

/** Allocate within one prefix, reserving primary IDs and aliases of both kinds. */
export function nextId(
  bundle: Bundle,
  knownIds: ReadonlySet<string> = new Set(),
  prefix = bundle.config.project,
): string {
  if (
    !prefix ||
    prefix.startsWith(".") ||
    /[\\/]/.test(prefix) ||
    [...prefix].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    throw new Error("invalid ID prefix");
  const pattern = numberedIdPattern(prefix);
  let max = 0;
  for (const id of [...bundle.workItems, ...bundle.decisions]
    .flatMap((item) => [item.fm.id, ...item.fm.aliases])
    .concat([...knownIds])) {
    const match = id.match(pattern);
    if (match?.[1]) max = Math.max(max, Number(match[1]));
  }
  if (!Number.isSafeInteger(max + 1)) throw new Error("ID sequence exhausted");
  return `${prefix}-${max + 1}`;
}

async function localIds(store: FileStore): Promise<Set<string>> {
  const ids = await mapFiles(await store.list(), async (path) =>
    reservedConceptIds(await store.read(path), path),
  );
  return new Set(ids.flat());
}

function creationSlug(title: string, slug?: string): string {
  if (typeof title !== "string" || !title.trim())
    throw new Error("title must not be empty");
  const value = slug ?? slugify(title);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
    throw new Error(
      "slug must contain lowercase letters, digits and single hyphens",
    );
  return value;
}

async function writeNew(
  store: FileStore,
  path: string,
  source: string,
): Promise<void> {
  if (!store.createExclusive)
    throw new Error("store does not support exclusive creation");
  if (!(await store.createExclusive(path, source)))
    throw new Error(`destination already exists: ${path}`);
}

export interface CreateDecisionInput {
  title: string;
  description?: string;
  tags?: string[];
  context?: string;
  decision?: string;
  consequences?: string;
  slug?: string;
}

/** Record an accepted choice; this never starts work or changes project guidance. */
export const createDecision = (
  store: FileStore,
  config: DocketConfig,
  input: CreateDecisionInput,
  coordinator?: WorkItemIdCoordinator,
): Promise<{ id: string; path: string; version: string }> =>
  mutate(store, async () => {
    const slug = creationSlug(input.title, input.slug);
    const create = async (knownIds: ReadonlySet<string>) => {
      const bundle = await loadMetadataBundle(store, config);
      const reserved = new Set([...knownIds, ...(await localIds(store))]);
      const id = nextId(bundle, reserved, config.ids.decision_prefix);
      const path = `decisions/${id}-${slug}.md`;
      const source = `---\n${stringifyYaml({ type: "Decision", title: input.title, ...(input.description ? { description: input.description } : {}), id, status: "accepted", ...(input.tags?.length ? { tags: input.tags } : {}), timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }, { lineWidth: 0 }).trimEnd()}\n---\n\n# Context\n\n${input.context ?? "(context, relevant links and alternatives considered)"}\n\n# Decision\n\n${input.decision ?? "(the accepted choice and why)"}\n\n# Consequences\n\n${input.consequences ?? "(tradeoffs and follow-up effects)"}\n`;
      await writeNew(store, path, source);
      return { id, path, version: sourceVersion(source) };
    };
    return coordinator
      ? coordinator.allocate(config.ids.decision_prefix, create)
      : create(new Set());
  });

const yamlLine = (key: string, value: unknown): string =>
  stringifyYaml({ [key]: value }, { lineWidth: 0 }).trimEnd();

export const createWorkItem = (
  ...args: Parameters<typeof createWorkItemUnlocked>
) => mutate(args[0], () => createWorkItemUnlocked(...args));

async function createWorkItemUnlocked(
  store: FileStore,
  config: DocketConfig,
  input: CreateInput,
  coordinator?: WorkItemIdCoordinator,
): Promise<{ id: string; path: string; version: string }> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TaskEditError(
      "invalid-request",
      "Work creation requires a structured input object.",
    );
  if (
    input.type !== undefined &&
    input.type !== "Task" &&
    input.type !== "Epic"
  )
    throw new TaskEditError(
      "invalid-request",
      `unsupported work type "${input.type}"; use Task or Epic, or decision create for a Decision`,
    );
  const checked = creationInput.safeParse(input);
  if (!checked.success)
    throw new TaskEditError(
      "invalid-request",
      "Invalid bounded work creation input.",
    );
  input = checked.data;
  if (
    input.body !== undefined &&
    (!input.body.trim() ||
      input.body.includes("\0") ||
      Buffer.byteLength(input.body) > 65536)
  )
    throw new TaskEditError(
      "invalid-request",
      "Authored body must be nonblank Markdown without NUL and at most 64 KiB.",
    );
  // Validate every authored field before calling the shared allocator. Actual
  // identity, inventory and exclusive destination checks remain inside it.
  const fields = {
    ...input,
    type: input.type ?? "Task",
    id: `${config.project}-1`,
    status: "todo",
    tags: input.tags ?? [],
  };
  if (!buildSchemas(config).workItem.safeParse(fields).success)
    throw new TaskEditError(
      "invalid-request",
      "Invalid work creation metadata.",
    );
  const slug = creationSlug(input.title, input.slug);
  const create = async (
    knownIds: ReadonlySet<string>,
  ): Promise<{ id: string; path: string; version: string }> => {
    // Load inside the coordination boundary: another caller may have created
    // an item while this process waited for the shared lock.
    const bundle = await loadMetadataBundle(store, config);
    const id = nextId(
      bundle,
      new Set([...knownIds, ...(await localIds(store))]),
    );
    if (bundle.byId(id) || knownIds.has(id))
      throw new Error(`id collision on ${id} — bundle has duplicate ids?`);

    const type = input.type ?? "Task";
    const dir = type === "Epic" ? "work/epics" : "work/tasks";
    const path = `${dir}/${id}-${slug}.md`;

    const lines = [
      yamlLine("type", type),
      yamlLine("title", input.title),
      ...(input.description
        ? [yamlLine("description", input.description)]
        : []),
      yamlLine("id", id),
      yamlLine("status", "todo"),
      ...(input.epic ? [yamlLine("epic", input.epic)] : []),
      ...(input.dependsOn?.length
        ? [
            `depends_on: ${stringifyYaml(input.dependsOn, { collectionStyle: "flow", flowCollectionPadding: false, lineWidth: 0 }).trimEnd()}`,
          ]
        : []),
      yamlLine("priority", input.priority ?? "p2"),
      ...(input.rank !== undefined ? [yamlLine("rank", input.rank)] : []),
      ...(input.assignee ? [yamlLine("assignee", input.assignee)] : []),
      ...(input.tags?.length
        ? [
            `tags: ${stringifyYaml(input.tags, { collectionStyle: "flow", flowCollectionPadding: false, lineWidth: 0 }).trimEnd()}`,
          ]
        : []),
      yamlLine("timestamp", new Date().toISOString().replace(/\.\d{3}Z$/, "Z")),
    ];

    const context = input.epic
      ? `See [epic](${input.epic}).`
      : "(links to specs/docs here)";
    const body =
      input.body ??
      `# Context\n\n${context}\n\n# Acceptance Criteria\n\n- [ ] …\n`;

    const source = `---\n${lines.join("\n")}\n---\n\n${body}`;
    await writeNew(store, path, source);
    return { id, path, version: sourceVersion(source) };
  };

  return coordinator
    ? coordinator.allocate(config.project, create)
    : create(new Set());
}

function splitFrontmatter(source: string): { fm: string; rest: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) throw new Error("file has no frontmatter block");
  return { fm: match[0], rest: source.slice(match[0].length) };
}

async function readResolved(
  store: FileStore,
  config: DocketConfig,
  id: string,
) {
  const bundle = await loadMetadataBundle(store, config);
  const resolved = bundle.byId(id);
  if (!resolved) return { bundle, item: undefined, source: "" };
  const source = await store.read(resolved.path);
  const parsed = parseMetadataConcept(
    resolved.path,
    source,
    buildSchemas(config),
  ).concept;
  if (
    !parsed ||
    parsed.kind === "generic" ||
    parsed.fm.id !== resolved.fm.id ||
    ![parsed.fm.id, ...parsed.fm.aliases].includes(id)
  )
    throw new Error(`item changed or is invalid; retry lookup: ${id}`);
  return { bundle, item: parsed, source };
}

export const setStatus = (...args: Parameters<typeof setStatusUnlocked>) =>
  mutate(args[0], () => setStatusUnlocked(...args));

async function setStatusUnlocked(
  store: FileStore,
  config: DocketConfig,
  id: string,
  to: string,
  opts: { note?: string } = {},
): Promise<{
  id: string;
  path: string;
  from: Status;
  to: Status;
  version: string;
}> {
  if (!isStatus(to)) throw new Error(`unknown status "${to}"`);
  if (to === "closed" && !opts.note?.trim()) {
    throw new Error("closing without completion requires a disposition note");
  }
  const { item, source } = await readResolved(store, config, id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);

  const from = item.fm.status;
  if (from === to) throw new Error(`${item.fm.id} is already ${to}`);
  if (
    !canTransitionWorkItem(from, to, item.fm.type, config.workflow.reopenClosed)
  ) {
    throw new Error(`invalid transition ${from} → ${to} for ${item.fm.id}`);
  }
  if (from === "closed" && to === "todo" && !opts.note?.trim()) {
    throw new Error("reopening closed work requires a reason note");
  }

  const { fm, rest } = splitFrontmatter(source);
  let updated = fm.replace(/^status:.*$/m, `status: ${to}`);
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (/^timestamp:.*$/m.test(updated)) {
    updated = updated.replace(/^timestamp:.*$/m, `timestamp: ${stamp}`);
  }
  const content = updated + rest;
  const saved = opts.note?.trim()
    ? withLogEntry(content, opts.note.trim())
    : content;
  await store.write(item.path, saved);
  return {
    id: item.fm.id,
    path: item.path,
    from,
    to,
    version: sourceVersion(saved),
  };
}

// Replace (or remove, line = null) a frontmatter field in place; when the
// field is absent, insert after the first matching anchor so the result keeps
// the field order createWorkItem writes. Anchored fields are single-line in
// CLI-shape files; block-style lists are skipped as anchors on purpose.
function upsertFmLine(
  fm: string,
  key: string,
  line: string | null,
  anchors: readonly RegExp[],
): string {
  const existing = new RegExp(`^${key}:.*$`, "m");
  if (existing.test(fm)) {
    if (line !== null) return fm.replace(existing, line);
    return fm.replace(new RegExp(`^${key}:.*\\n`, "m"), "");
  }
  if (line === null) return fm;
  for (const anchor of anchors) {
    const match = fm.match(anchor);
    if (match?.index !== undefined) {
      const at = match.index + match[0].length;
      return `${fm.slice(0, at)}\n${line}${fm.slice(at)}`;
    }
  }
  throw new Error(`no anchor line to place ${key}: after`);
}

export interface TaskFieldPatch {
  priority?: string;
  rank?: number | null;
  epic?: string | null;
}
export type TaskEditMutation = "unchanged" | "applied" | "unknown";
export class TaskEditError extends Error {
  constructor(
    readonly code:
      | "invalid-request"
      | "source-conflict"
      | "write-failed"
      | "unavailable",
    message: string,
    readonly mutation: TaskEditMutation = "unchanged",
    readonly version?: string,
  ) {
    super(message);
  }
  receipt() {
    return {
      schema: "task-edit/v1",
      error: { code: this.code, message: this.message.slice(0, 512) },
      mutation: this.mutation,
      ...(this.version ? { version: this.version } : {}),
      recovery:
        this.mutation === "unchanged"
          ? "Correct the request or reconcile the current source before retrying."
          : "Review the current source before retrying; no rollback is claimed.",
    };
  }
}
const sourceVersion = (source: string) =>
  createHash("sha256").update(source).digest("hex");

/** Preserve source slices and value quoting, including inline field comments. */
function patchFmField(
  fm: string,
  key: string,
  value: string | number | null,
  anchors: readonly RegExp[],
) {
  const offset = fm.startsWith("---\r\n") ? 5 : 4;
  const eol = offset === 5 ? "\r\n" : "\n";
  const inner = fm.slice(offset, fm.lastIndexOf("\n---")).replace(/\r$/, "");
  const doc = parseDocument(inner);
  if (doc.errors.length || !isMap(doc.contents))
    throw new Error("Invalid editable frontmatter");
  const node = doc.contents.get(key, true);
  if (!node) {
    if (value === null) return fm;
    for (const anchor of anchors) {
      const match = fm.match(anchor);
      if (match?.index !== undefined) {
        const at = match.index + match[0].replace(/\r$/, "").length;
        return fm.slice(0, at) + eol + yamlLine(key, value) + fm.slice(at);
      }
    }
    throw new Error(`No anchor line to place ${key}`);
  }
  if (!isScalar(node) || !node.range)
    throw new Error(`Unsupported ${key} source shape`);
  const start = offset + node.range[0];
  const end = offset + node.range[1];
  const block = node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
  const blockComment = block
    ? (fm
        .slice(start, fm.indexOf("\n", start))
        .replace(/\r$/, "")
        .match(/[ \t]+#.*$/)?.[0] ?? "")
    : "";
  if (value === null) {
    const lineStart = fm.lastIndexOf("\n", start) + 1;
    const lineEnd = fm[end - 1] === "\n" ? end - 1 : fm.indexOf("\n", end);
    const suffix =
      blockComment || fm.slice(end, lineEnd < 0 ? fm.length : lineEnd);
    return (
      fm.slice(0, lineStart) +
      (suffix.trimStart().startsWith("#")
        ? `${suffix.trimStart().replace(/\r$/, "")}${eol}`
        : "") +
      fm.slice(lineEnd < 0 ? fm.length : lineEnd + 1)
    );
  }
  const next =
    typeof value === "string" && node.type === "QUOTE_DOUBLE"
      ? JSON.stringify(value)
      : typeof value === "string" && node.type === "QUOTE_SINGLE"
        ? `'${value.replaceAll("'", "''")}'`
        : yamlLine(key, value).slice(key.length + 2);
  return (
    fm.slice(0, start) +
    next +
    blockComment +
    (fm.slice(start, end).endsWith("\n") ? eol : "") +
    fm.slice(end)
  );
}

/** Validate every field against one source and serialize one coordinated write. */
export async function editWorkItem(
  store: FileStore,
  config: DocketConfig,
  id: string,
  patch: TaskFieldPatch,
  expectedVersion?: string,
) {
  let disposition: TaskEditMutation = "unchanged";
  let lastVersion: string | undefined;
  try {
    return await mutate(store, async () => {
      if (
        !patch ||
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        !Object.keys(patch).length ||
        Object.keys(patch).some(
          (key) => !["priority", "rank", "epic"].includes(key),
        )
      )
        throw new TaskEditError(
          "invalid-request",
          "Provide priority, rank or epic fields only.",
        );
      if (
        "priority" in patch &&
        (typeof patch.priority !== "string" || !isPriority(patch.priority))
      )
        throw new TaskEditError("invalid-request", "Priority must be p0..p3.");
      if (
        "rank" in patch &&
        patch.rank !== null &&
        (typeof patch.rank !== "number" || !Number.isFinite(patch.rank))
      )
        throw new TaskEditError(
          "invalid-request",
          "Rank must be a finite number or null.",
        );
      if (
        "epic" in patch &&
        patch.epic !== null &&
        (typeof patch.epic !== "string" || !patch.epic.trim())
      )
        throw new TaskEditError(
          "invalid-request",
          "Epic must be a nonempty bundle link or null.",
        );
      if (
        expectedVersion !== undefined &&
        (typeof expectedVersion !== "string" ||
          !/^[a-f0-9]{64}$/.test(expectedVersion))
      )
        throw new TaskEditError(
          "invalid-request",
          "Expected version must be a complete source content version.",
        );
      const { bundle, item, source } = await readResolved(store, config, id);
      if (item?.kind !== "work")
        throw new TaskEditError(
          "invalid-request",
          `No work item with id ${id}`,
        );
      const version = sourceVersion(source);
      if (expectedVersion && expectedVersion !== version)
        throw new TaskEditError(
          "source-conflict",
          "Source changed since the supplied version; no requested fields were written.",
          "unchanged",
          version,
        );
      if (item.fm.type === "Epic" && ("rank" in patch || "epic" in patch))
        throw new TaskEditError(
          "invalid-request",
          "Epics cannot have task rank or a parent epic.",
        );
      const fields: Record<
        string,
        { from: string | number | null; to: string | number | null }
      > = {};
      if (patch.priority !== undefined)
        fields.priority = { from: item.fm.priority, to: patch.priority };
      if (patch.rank !== undefined)
        fields.rank = { from: item.fm.rank ?? null, to: patch.rank };
      if (patch.epic !== undefined) {
        const link =
          patch.epic === null
            ? null
            : patch.epic.startsWith("/")
              ? patch.epic
              : `/${patch.epic}`;
        if (link) {
          const path = resolveLink(item.path, link);
          const target = bundle.concepts.find((c) => c.path === path);
          if (target?.kind !== "work" || target.fm.type !== "Epic")
            throw new TaskEditError("invalid-request", `No epic at ${link}`);
          // Revalidate the referenced target while the same mutation lock is held.
          const current = parseMetadataConcept(
            target.path,
            await store.read(target.path),
            buildSchemas(config),
          ).concept;
          if (
            current?.kind !== "work" ||
            current.fm.type !== "Epic" ||
            current.fm.id !== target.fm.id
          )
            throw new TaskEditError(
              "source-conflict",
              "Epic target changed; no requested fields were written.",
            );
        }
        fields.epic = { from: item.fm.epic ?? null, to: link };
      }
      const match = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/);
      if (!match)
        throw new TaskEditError(
          "invalid-request",
          "File has no editable frontmatter block.",
        );
      const fm = match[0];
      const rest = source.slice(fm.length);
      let updated = fm;
      for (const key of ["priority", "rank", "epic"] as const) {
        const change = fields[key];
        if (change && change.from !== change.to)
          updated = patchFmField(
            updated,
            key,
            change.to,
            key === "epic"
              ? [/^status:.*$/m]
              : [
                  /^priority:.*$/m,
                  /^depends_on: \[.*$/m,
                  /^epic:.*$/m,
                  /^status:.*$/m,
                ],
          );
      }
      const content = updated + rest;
      const parsed = parseMetadataConcept(
        item.path,
        content,
        buildSchemas(config),
      );
      if (
        parsed.diagnostics.some((d) => d.severity === "error") ||
        parsed.concept?.kind !== "work"
      )
        throw new TaskEditError(
          "invalid-request",
          "The requested patch does not produce valid task metadata.",
        );
      if (sourceVersion(await store.read(item.path)) !== version)
        throw new TaskEditError(
          "source-conflict",
          "Source changed during edit; no requested fields were written.",
        );
      const changed = content !== source;
      if (changed) {
        disposition = "unknown";
        try {
          await store.write(item.path, content);
          disposition = "applied";
          lastVersion = sourceVersion(content);
        } catch {
          let mutation: TaskEditMutation = "unknown";
          let observedVersion: string | undefined;
          try {
            const observed = await store.read(item.path);
            observedVersion = sourceVersion(observed);
            mutation =
              observed === source
                ? "unchanged"
                : observed === content
                  ? "applied"
                  : "unknown";
          } catch {}
          throw new TaskEditError(
            "write-failed",
            "Task source write failed; mutation disposition reflects the observed readback, not a rollback.",
            mutation,
            observedVersion,
          );
        }
      }
      return {
        schema: "task-edit/v1",
        id: item.fm.id,
        path: item.path,
        changed,
        mutation: changed ? "applied" : "unchanged",
        version: sourceVersion(content),
        ...fields,
      };
    });
  } catch (error) {
    if (error instanceof TaskEditError) throw error;
    throw new TaskEditError(
      "unavailable",
      error instanceof Error ? error.message : "Task edit unavailable.",
      disposition,
      lastVersion,
    );
  }
}

export const setPriority = (...args: Parameters<typeof setPriorityUnlocked>) =>
  mutate(args[0], () => setPriorityUnlocked(...args));

async function setPriorityUnlocked(
  store: FileStore,
  config: DocketConfig,
  id: string,
  to: string,
): Promise<{ id: string; path: string; from: Priority; to: Priority }> {
  if (!isPriority(to)) throw new Error(`unknown priority "${to}"`);
  const { item, source } = await readResolved(store, config, id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);

  const from = item.fm.priority ?? "p2";
  if (from === to) throw new Error(`${item.fm.id} is already ${to}`);

  const { fm, rest } = splitFrontmatter(source);
  // No timestamp bump: timestamp marks status transitions (the epic lists
  // order on it); a priority tweak shouldn't reshuffle those.
  const updated = upsertFmLine(fm, "priority", yamlLine("priority", to), [
    /^depends_on: \[.*$/m,
    /^epic:.*$/m,
    /^status:.*$/m,
  ]);
  await store.write(item.path, updated + rest);
  return { id: item.fm.id, path: item.path, from, to };
}

// Rank is the manual within-lane order: one global number per task,
// lower first, decimals allowed so an insert between neighbors takes the
// midpoint and touches only the moved task's file. Unranked sorts last.
export const setRank = (...args: Parameters<typeof setRankUnlocked>) =>
  mutate(args[0], () => setRankUnlocked(...args));

async function setRankUnlocked(
  store: FileStore,
  config: DocketConfig,
  id: string,
  to: number | null,
): Promise<{
  id: string;
  path: string;
  from: number | null;
  to: number | null;
}> {
  if (to !== null && !Number.isFinite(to))
    throw new Error(`rank must be a finite number, got ${to}`);
  const { item, source } = await readResolved(store, config, id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);
  if (item.fm.type === "Epic")
    throw new Error(`${item.fm.id} is an epic — rank orders tasks`);

  const from = item.fm.rank ?? null;
  if (from === to)
    throw new Error(`${item.fm.id} rank is already ${to ?? "unset"}`);

  const { fm, rest } = splitFrontmatter(source);
  // No timestamp bump — same reasoning as priority: reordering a lane
  // shouldn't reshuffle the activity-ordered lists.
  const updated = upsertFmLine(
    fm,
    "rank",
    to === null ? null : yamlLine("rank", to),
    [/^priority:.*$/m, /^depends_on: \[.*$/m, /^epic:.*$/m, /^status:.*$/m],
  );
  await store.write(item.path, updated + rest);
  return { id: item.fm.id, path: item.path, from, to };
}

export const setEpic = (...args: Parameters<typeof setEpicUnlocked>) =>
  mutate(args[0], () => setEpicUnlocked(...args));

async function setEpicUnlocked(
  store: FileStore,
  config: DocketConfig,
  id: string,
  to: string | null,
): Promise<{
  id: string;
  path: string;
  from: string | null;
  to: string | null;
}> {
  const { bundle, item, source } = await readResolved(store, config, id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);
  if (item.fm.type === "Epic")
    throw new Error(`${item.fm.id} is an epic — epics don't nest`);

  let link: string | null = null;
  if (to) {
    link = to.startsWith("/") ? to : `/${to}`;
    const resolved = resolveLink(item.path, link);
    const target = resolved
      ? bundle.concepts.find((c) => c.path === resolved)
      : undefined;
    if (target?.kind !== "work" || target.fm.type !== "Epic")
      throw new Error(`no epic at ${link}`);
  }

  const from = typeof item.fm.epic === "string" ? item.fm.epic : null;
  if (from === link)
    throw new Error(`${item.fm.id} epic is already ${link ?? "unset"}`);

  const { fm, rest } = splitFrontmatter(source);
  const updated = upsertFmLine(
    fm,
    "epic",
    link === null ? null : yamlLine("epic", link),
    [/^status:.*$/m],
  );
  await store.write(item.path, updated + rest);
  return { id: item.fm.id, path: item.path, from, to: link };
}

/** Insert a dated entry directly under `# Log` (newest first), creating the section if needed. */
export const appendLog = (...args: Parameters<typeof appendLogUnlocked>) =>
  mutate(args[0], () => appendLogUnlocked(...args));

async function appendLogUnlocked(
  store: FileStore,
  config: DocketConfig,
  id: string,
  entry: string,
): Promise<{ path: string; version: string }> {
  const { item, source } = await readResolved(store, config, id);
  if (!item) throw new Error(`no item with id ${id}`);

  const saved = withLogEntry(source, entry);
  await store.write(item.path, saved);
  return { path: item.path, version: sourceVersion(saved) };
}

function withLogEntry(source: string, entry: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const line = `**${date}** — ${entry}`;

  // Consume the blank lines after the heading and re-emit them around the new
  // entry, so consecutive entries stay separated by exactly one blank line.
  return /^# Log\s*$/m.test(source)
    ? `${source.replace(/^# Log[ \t]*\n*/m, `# Log\n\n${line}\n\n`).trimEnd()}\n`
    : `${source.trimEnd()}\n\n# Log\n\n${line}\n`;
}

// Hosted stores can supply their own transaction boundary. The fallback
// serializes shared in-process stores; LocalFileStore also coordinates processes.
const mutationQueues = new WeakMap<FileStore, Promise<void>>();
export function mutate<T>(
  store: FileStore,
  operation: () => Promise<T>,
): Promise<T> {
  if (store.withMutation) return store.withMutation(operation);
  const next = (mutationQueues.get(store) ?? Promise.resolve()).then(operation);
  mutationQueues.set(
    store,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}
