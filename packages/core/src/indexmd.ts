// Generated index.md: derived content is never hand-maintained.
// Everything above the marker is human preamble and survives regeneration;
// everything below is machine-owned and rendered deterministically from the
// bundle (lockfile pattern — committed, and CI fails on drift).

import type { Bundle } from "./bundle";
import type { GenericConcept, WorkItem } from "./parse";
import { isTerminalStatus } from "./states";

export const INDEX_MARKER = "<!-- docket:generated -->";

const idNum = (id: string): number => Number(id.match(/(\d+)$/)?.[1] ?? 0);
const byId = (a: { fm: { id: string } }, b: { fm: { id: string } }): number =>
  idNum(a.fm.id) - idNum(b.fm.id);

const link = (text: string, path: string): string => `[${text}](/${path})`;

const taskLine = (t: WorkItem, ready: ReadonlySet<string>): string => {
  const text = link(`${t.fm.id} — ${t.fm.title ?? t.fm.id}`, t.path);
  if (t.fm.status === "done") return `- ✅ ${text}`;
  if (t.fm.status === "closed") return `- ⏹️ ${text} *(closed)*`;
  if (t.fm.status === "in-progress" || t.fm.status === "in-review")
    return `- 🔄 ${text}`;
  if (t.fm.status === "blocked") return `- 🚫 ${text}`;
  return ready.has(t.fm.id) ? `- ${text} *(ready)*` : `- ${text}`;
};

const tsOf = (t: WorkItem): string =>
  typeof t.fm.timestamp === "string" ? t.fm.timestamp : "";

/**
 * Liveness order: what's moving, then what could move, then the
 * queue, then terminal history newest-first (timestamp is the transition time; ISO
 * strings compare chronologically). File-derived and deterministic: no
 * wall-clock input, so regeneration without a bundle change never diffs.
 */
export function byLiveness(
  ready: ReadonlySet<string>,
): (a: WorkItem, b: WorkItem) => number {
  const rank = (t: WorkItem): number => {
    if (t.fm.status === "in-progress" || t.fm.status === "in-review") return 0;
    if (ready.has(t.fm.id)) return 1;
    if (isTerminalStatus(t.fm.status)) return 3;
    return 2; // todo (unready) + blocked
  };
  return (a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (rank(a) === 3) {
      const byClose = tsOf(b).localeCompare(tsOf(a));
      if (byClose !== 0) return byClose;
    }
    return byId(a, b);
  };
}

/** The machine-owned body: generic concepts by directory, decisions, work by epic. */
export function renderIndex(bundle: Bundle): string {
  const sections: string[] = [];

  const groups = new Map<string, GenericConcept[]>();
  for (const c of bundle.concepts) {
    if (c.kind !== "generic") continue;
    const dir = c.path.includes("/") ? (c.path.split("/")[0] ?? "") : "";
    const group = groups.get(dir) ?? [];
    group.push(c);
    groups.set(dir, group);
  }
  for (const [dir, items] of [...groups.entries()].sort()) {
    const name = dir ? dir[0]?.toUpperCase() + dir.slice(1) : "Concepts";
    const lines = items
      .sort((a, z) => a.path.localeCompare(z.path))
      .map(
        (c) =>
          `- ${link(c.fm.title ?? c.path, c.path)}${c.fm.description ? ` — ${c.fm.description}` : ""}`,
      );
    sections.push(`## ${name}\n\n${lines.join("\n")}`);
  }

  if (bundle.decisions.length > 0) {
    const lines = [...bundle.decisions].sort(byId).map((d) => {
      const text = link(`${d.fm.id} — ${d.fm.title ?? d.fm.id}`, d.path);
      return d.fm.status === "superseded"
        ? `- ~~${text}~~ *(superseded)*`
        : `- ${text}`;
    });
    sections.push(`## Decisions\n\n${lines.join("\n")}`);
  }

  const ready = new Set(bundle.readyIds());
  const epics = bundle.workItems.filter((w) => w.fm.type === "Epic").sort(byId);
  const tasks = bundle.workItems.filter((w) => w.fm.type === "Task").sort(byId);
  if (epics.length > 0 || tasks.length > 0) {
    const work: string[] = ["## Work"];
    const claimed = new Set<string>();
    const order = byLiveness(ready);
    for (const epic of epics) {
      const own = tasks.filter((t) => t.fm.epic?.includes(`/${epic.fm.id}-`));
      for (const t of own) claimed.add(t.fm.id);
      // Fully-done epics collapse to their rollup: the history lives
      // in git and on the epic page; the index is orientation, not archive.
      const finished =
        epic.fm.status === "done" &&
        own.length > 0 &&
        own.every((t) => t.fm.status === "done");
      const head = `### ${link(epic.fm.title ?? epic.fm.id, epic.path)} *(${epic.fm.status})*`;
      if (finished) {
        work.push(`${head}\n\n✅ all ${own.length} tasks done`);
        continue;
      }
      work.push(head);
      if (own.length > 0)
        work.push(
          own
            .sort(order)
            .map((t) => taskLine(t, ready))
            .join("\n"),
        );
    }
    const orphans = tasks.filter((t) => !claimed.has(t.fm.id));
    if (orphans.length > 0) {
      work.push("### No epic");
      work.push(
        orphans
          .sort(order)
          .map((t) => taskLine(t, ready))
          .join("\n"),
      );
    }
    sections.push(work.join("\n\n"));
  }

  return sections.join("\n\n");
}

/** Splice the generated body below the marker, preserving the human preamble above it. */
export function applyIndex(current: string, body: string): string {
  const at = current.indexOf(INDEX_MARKER);
  const preamble =
    at >= 0
      ? current.slice(0, at)
      : current.trim()
        ? `${current.trimEnd()}\n\n`
        : "# Index\n\n";
  return `${preamble}${INDEX_MARKER}\n\n${body}\n`;
}
