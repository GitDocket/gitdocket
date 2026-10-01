// The context packet: the compact, deterministic subset of the graph
// a fresh session needs to begin work on a task — frontmatter + body, the
// epic, dependency statuses, one-hop linked concepts, and the task's commit
// trail. Everything derives from the bundle plus git activity the caller
// supplies; no new state.

import type { Bundle } from "./bundle";
import type { FileStore } from "./filestore";
import { type ProjectGuidance, readProjectGuidance } from "./guidance";
import { resolveLink } from "./lint";
import { parseConcept } from "./parse";
import { buildSchemas, type WorkItemFrontmatter } from "./schema";
import { taskDriftReceipt } from "./task-drift";
import type { TaskProgressEvidence } from "./task-observations";
import {
  readWorkflowFreshness,
  type WorkflowFreshness,
} from "./workflow-freshness";

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
  task: {
    path: string;
    fm: WorkItemFrontmatter;
    body: string;
    version?: string;
  };
  epic?: { path: string; id?: string; title?: string; status?: string };
  deps: PacketDep[];
  linked: PacketLink[];
  commits: CommitRef[];
  guidance: ProjectGuidance;
  drift?: ReturnType<typeof taskDriftReceipt>;
  instructions?: WorkflowFreshness;
}

export interface EpicSupervisionRoute {
  outcome: "route";
  route: { intent: "epic-supervision"; workflow: "docket-epic" };
  suggestedSessionTitle: string;
  epic: {
    path: string;
    fm: WorkItemFrontmatter;
    body: string;
    version?: string;
  };
}

const bodyWithoutFrontmatter = (source: string): string =>
  source.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

/** Resolve a named Epic without changing its status, selecting a child, or touching pickup state. */
export async function buildEpicSupervisionRoute(
  store: FileStore,
  bundle: Bundle,
  id: string,
): Promise<EpicSupervisionRoute> {
  const item = bundle.byId(id);
  if (item?.kind !== "work" || item.fm.type !== "Epic")
    throw new Error(`no epic with id ${id}`);

  const source = await store.read(item.path);
  const parsed = parseConcept(item.path, source, buildSchemas(bundle.config));
  if (
    parsed.concept?.kind !== "work" ||
    parsed.concept.fm.type !== "Epic" ||
    JSON.stringify(parsed.concept.fm) !== JSON.stringify(item.fm)
  )
    throw new Error(`epic changed or is invalid: ${item.path}`);

  return {
    outcome: "route",
    route: { intent: "epic-supervision", workflow: "docket-epic" },
    suggestedSessionTitle: `Epic ${item.fm.id} — ${item.fm.title ?? ""}`,
    epic: {
      path: item.path,
      version: parsed.concept.sourceVersion,
      fm: item.fm,
      body: bodyWithoutFrontmatter(source),
    },
  };
}

/**
 * Build the packet for a work item. `commits` is the task's trailer-matched
 * history, newest first — callers with a repo get it from `scanActivity`
 * (`@gitdocket/core/cache`); repo-less callers pass `[]`.
 */
export async function buildContextPacket(
  store: FileStore,
  bundle: Bundle,
  id: string,
  commits: CommitRef[] = [],
  progress?: TaskProgressEvidence,
): Promise<ContextPacket> {
  const item = bundle.byId(id);
  if (item?.kind !== "work") throw new Error(`no work item with id ${id}`);

  const source = await store.read(item.path);
  // Only this task's Markdown links are needed; the surrounding bundle may
  // be a metadata projection. Parse the same source returned in the packet.
  const parsed = parseConcept(item.path, source, buildSchemas(bundle.config));
  if (
    parsed.concept?.kind !== "work" ||
    JSON.stringify(parsed.concept.fm) !== JSON.stringify(item.fm)
  )
    throw new Error(`task changed or is invalid: ${item.path}`);
  const body = bodyWithoutFrontmatter(source);

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
  for (const link of parsed.concept.links) {
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
    task: {
      path: item.path,
      fm: item.fm,
      body,
      version: parsed.concept.sourceVersion,
    },
    epic,
    deps,
    linked,
    commits,
    guidance: await readProjectGuidance(store, bundle.config),
    ...(progress ? { drift: taskDriftReceipt(item.fm.id, progress) } : {}),
    instructions: await readWorkflowFreshness(store),
  };
}
