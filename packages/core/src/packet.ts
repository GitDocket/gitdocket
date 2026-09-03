// The context packet: the compact, deterministic subset of the graph
// a fresh session needs to begin work on a task — frontmatter + body, the
// epic, dependency statuses, one-hop linked concepts, and the task's commit
// trail. Everything derives from the bundle plus git activity the caller
// supplies; no new state.

import type { Bundle } from "./bundle";
import type { FileStore } from "./filestore";
import { resolveLink } from "./lint";
import type { WorkItemFrontmatter } from "./schema";

/** A commit carrying the task's trailer; the caller derives these from git. */
export interface CommitRef {
  sha: string;
  date: string;
  subject: string;
}

export interface PacketDep {
  id: string;
  title?: string;
  /** Undefined when the id resolves to nothing — lint flags that separately. */
  status?: string;
}

/** One-hop linked concept: enough to decide whether to open it, not its body. */
export interface PacketLink {
  path: string;
  type: string;
  title?: string;
  description?: string;
  status?: string;
}

export interface ContextPacket {
  /** Canonical host-neutral title intent for the current agent session. */
  suggestedSessionTitle: string;
  task: { path: string; fm: WorkItemFrontmatter; body: string };
  epic?: { path: string; id?: string; title?: string; status?: string };
  deps: PacketDep[];
  linked: PacketLink[];
  commits: CommitRef[];
}

/**
 * Build the packet for a work item. `commits` is the task's trailer-matched
 * history, newest first — callers with a repo get it from `scanActivity`
 * (`@docket/core/cache`); repo-less callers pass `[]`.
 */
export async function buildContextPacket(
  store: FileStore,
  bundle: Bundle,
  id: string,
  commits: CommitRef[] = [],
): Promise<ContextPacket> {
  const item = bundle.byId(id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);

  const source = await store.read(item.path);
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

  const conceptAt = (path: string | undefined) =>
    path ? bundle.concepts.find((c) => c.path === path) : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;

  const epicPath =
    typeof item.fm.epic === "string"
      ? resolveLink(item.path, item.fm.epic)
      : undefined;
  const epicConcept = conceptAt(epicPath);
  const epic =
    epicPath && epicConcept
      ? {
          path: epicPath,
          id: str(epicConcept.fm.id),
          title: epicConcept.fm.title,
          status: str(epicConcept.fm.status),
        }
      : undefined;

  const deps: PacketDep[] = item.fm.depends_on.map((depId) => {
    const dep = bundle.byId(depId);
    return { id: depId, title: dep?.fm.title, status: dep?.fm.status };
  });

  // One-hop targets from the body, minus what the packet already carries
  // as structure (the task itself, its epic, its dependencies).
  const skip = new Set([item.path, epicPath]);
  for (const dep of item.fm.depends_on) {
    const target = bundle.byId(dep);
    if (target) skip.add(target.path);
  }
  const linked: PacketLink[] = [];
  for (const link of item.links) {
    if (!link.internal) continue;
    const resolved = resolveLink(item.path, link.target);
    if (!resolved || skip.has(resolved)) continue;
    const concept = conceptAt(resolved);
    if (!concept) continue;
    skip.add(resolved); // dedupe repeat links
    linked.push({
      path: resolved,
      type: concept.fm.type,
      title: concept.fm.title,
      description: concept.fm.description,
      status: str(concept.fm.status),
    });
  }

  return {
    suggestedSessionTitle: `${item.fm.id} — ${item.fm.title ?? ""}`,
    task: { path: item.path, fm: item.fm, body },
    epic,
    deps,
    linked,
    commits,
  };
}
