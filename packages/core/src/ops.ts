// Write operations. Every surface (CLI, MCP, web, App) calls these — there is
// exactly one write path. Mutations are targeted line edits inside the
// frontmatter block, never a full YAML re-serialize, so hand-authored
// formatting and comments survive.

import { stringify as stringifyYaml } from "yaml";
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
}

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
): Promise<{ id: string; path: string }> =>
  mutate(store, async () => {
    const slug = creationSlug(input.title, input.slug);
    const create = async (knownIds: ReadonlySet<string>) => {
      const bundle = await loadMetadataBundle(store, config);
      const reserved = new Set([...knownIds, ...(await localIds(store))]);
      const id = nextId(bundle, reserved, config.ids.decision_prefix);
      const path = `decisions/${id}-${slug}.md`;
      const source = `---\n${stringifyYaml({ type: "Decision", title: input.title, ...(input.description ? { description: input.description } : {}), id, status: "accepted", ...(input.tags?.length ? { tags: input.tags } : {}), timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }, { lineWidth: 0 }).trimEnd()}\n---\n\n# Context\n\n${input.context ?? "(context, relevant links and alternatives considered)"}\n\n# Decision\n\n${input.decision ?? "(the accepted choice and why)"}\n\n# Consequences\n\n${input.consequences ?? "(tradeoffs and follow-up effects)"}\n`;
      await writeNew(store, path, source);
      return { id, path };
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
): Promise<{ id: string; path: string }> {
  if (
    input.type !== undefined &&
    input.type !== "Task" &&
    input.type !== "Epic"
  )
    throw new Error(
      `unsupported work type "${input.type}"; use Task or Epic, or decision create for a Decision`,
    );
  const slug = creationSlug(input.title, input.slug);
  const create = async (
    knownIds: ReadonlySet<string>,
  ): Promise<{ id: string; path: string }> => {
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
        ? [`depends_on: [${input.dependsOn.join(", ")}]`]
        : []),
      yamlLine("priority", input.priority ?? "p2"),
      ...(input.rank !== undefined ? [yamlLine("rank", input.rank)] : []),
      ...(input.assignee ? [yamlLine("assignee", input.assignee)] : []),
      ...(input.tags?.length ? [`tags: [${input.tags.join(", ")}]`] : []),
      yamlLine("timestamp", new Date().toISOString().replace(/\.\d{3}Z$/, "Z")),
    ];

    const context = input.epic
      ? `See [epic](${input.epic}).`
      : "(links to specs/docs here)";
    const body = `# Context\n\n${context}\n\n# Acceptance Criteria\n\n- [ ] …\n`;

    await writeNew(store, path, `---\n${lines.join("\n")}\n---\n\n${body}`);
    return { id, path };
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
): Promise<{ id: string; path: string; from: Status; to: Status }> {
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
  await store.write(
    item.path,
    opts.note?.trim() ? withLogEntry(content, opts.note.trim()) : content,
  );
  return { id: item.fm.id, path: item.path, from, to };
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
): Promise<{ path: string }> {
  const { item, source } = await readResolved(store, config, id);
  if (!item) throw new Error(`no item with id ${id}`);

  await store.write(item.path, withLogEntry(source, entry));
  return { path: item.path };
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
