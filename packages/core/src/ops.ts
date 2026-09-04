// Write operations. Every surface (CLI, MCP, web, App) calls these — there is
// exactly one write path. Mutations are targeted line edits inside the
// frontmatter block, never a full YAML re-serialize, so hand-authored
// formatting and comments survive.

import { stringify as stringifyYaml } from "yaml";
import { type Bundle, loadBundle } from "./bundle";
import type { DocketConfig } from "./config";
import type { FileStore } from "./filestore";
import type { WorkItemIdCoordinator } from "./id-allocation";
import { resolveLink } from "./lint";
import {
  canTransition,
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

/** Next work-item number: max over ids matching `<project>-<n>`, plus one. */
export function nextId(
  bundle: Bundle,
  knownIds: ReadonlySet<string> = new Set(),
): string {
  const pattern = new RegExp(`^${bundle.config.project}-(\\d+)$`);
  let max = 0;
  for (const id of [
    ...bundle.workItems.map((item) => item.fm.id),
    ...knownIds,
  ]) {
    const match = id.match(pattern);
    if (match?.[1]) max = Math.max(max, Number(match[1]));
  }
  return `${bundle.config.project}-${max + 1}`;
}

const yamlLine = (key: string, value: unknown): string =>
  stringifyYaml({ [key]: value }).trimEnd();

export async function createWorkItem(
  store: FileStore,
  config: DocketConfig,
  input: CreateInput,
  coordinator?: WorkItemIdCoordinator,
): Promise<{ id: string; path: string }> {
  const create = async (
    knownIds: ReadonlySet<string>,
  ): Promise<{ id: string; path: string }> => {
    // Load inside the coordination boundary: another caller may have created
    // an item while this process waited for the shared lock.
    const bundle = await loadBundle(store, config);
    const id = nextId(bundle, knownIds);
    if (bundle.byId(id) || knownIds.has(id))
      throw new Error(`id collision on ${id} — bundle has duplicate ids?`);

    const type = input.type ?? "Task";
    const slug = input.slug ?? slugify(input.title);
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

    await store.write(path, `---\n${lines.join("\n")}\n---\n\n${body}`);
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

export async function setStatus(
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
  const bundle = await loadBundle(store, config);
  const item = bundle.byId(id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);

  const from = item.fm.status;
  if (from === to) throw new Error(`${item.fm.id} is already ${to}`);
  if (!canTransition(from, to)) {
    throw new Error(`invalid transition ${from} → ${to} for ${item.fm.id}`);
  }

  const source = await store.read(item.path);
  const { fm, rest } = splitFrontmatter(source);
  let updated = fm.replace(/^status:.*$/m, `status: ${to}`);
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (/^timestamp:.*$/m.test(updated)) {
    updated = updated.replace(/^timestamp:.*$/m, `timestamp: ${stamp}`);
  }
  await store.write(item.path, updated + rest);

  if (opts.note?.trim())
    await appendLog(store, config, item.fm.id, opts.note.trim());
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

export async function setPriority(
  store: FileStore,
  config: DocketConfig,
  id: string,
  to: string,
): Promise<{ id: string; path: string; from: Priority; to: Priority }> {
  if (!isPriority(to)) throw new Error(`unknown priority "${to}"`);
  const bundle = await loadBundle(store, config);
  const item = bundle.byId(id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);

  const from = item.fm.priority ?? "p2";
  if (from === to) throw new Error(`${item.fm.id} is already ${to}`);

  const source = await store.read(item.path);
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
export async function setRank(
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
  const bundle = await loadBundle(store, config);
  const item = bundle.byId(id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);
  if (item.fm.type === "Epic")
    throw new Error(`${item.fm.id} is an epic — rank orders tasks`);

  const from = item.fm.rank ?? null;
  if (from === to)
    throw new Error(`${item.fm.id} rank is already ${to ?? "unset"}`);

  const source = await store.read(item.path);
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

export async function setEpic(
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
  const bundle = await loadBundle(store, config);
  const item = bundle.byId(id);
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

  const source = await store.read(item.path);
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
export async function appendLog(
  store: FileStore,
  config: DocketConfig,
  id: string,
  entry: string,
): Promise<{ path: string }> {
  const bundle = await loadBundle(store, config);
  const item = bundle.byId(id);
  if (!item) throw new Error(`no item with id ${id}`);

  const date = new Date().toISOString().slice(0, 10);
  const line = `**${date}** — ${entry}`;
  const source = await store.read(item.path);

  // Consume the blank lines after the heading and re-emit them around the new
  // entry, so consecutive entries stay separated by exactly one blank line.
  const updated = /^# Log\s*$/m.test(source)
    ? `${source.replace(/^# Log[ \t]*\n*/m, `# Log\n\n${line}\n\n`).trimEnd()}\n`
    : `${source.trimEnd()}\n\n# Log\n\n${line}\n`;

  await store.write(item.path, updated);
  return { path: item.path };
}
