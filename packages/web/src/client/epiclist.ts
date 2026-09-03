// Pure filter/sort logic for the epics page. Like the all-tasks view, state
// lives in the URL hash query so a filtered
// page survives copy-paste, and this module is the single translation between
// that query string and the rendered rollup list.

export interface EpicRow {
  path: string;
  id: string;
  title: string | null;
  status: string | null;
  priority: string | null;
  tags: string[];
  total: number;
  done: number;
  closed: number;
  needsCleanup: boolean;
  lastActivity: string;
}

export type EpicSortKey = "activity" | "progress" | "priority" | "status";

export interface EpicListState {
  status: string;
  tag: string;
  done: boolean; // legacy URL flag: show terminal (done + closed) epics
  cleanup: boolean;
  sort: EpicSortKey;
}

export const DEFAULT_EPICS: EpicListState = {
  status: "",
  tag: "",
  done: false,
  cleanup: false,
  sort: "activity",
};

const SORT_KEYS: readonly string[] = [
  "activity",
  "progress",
  "priority",
  "status",
];

export function parseEpicListState(query: string): EpicListState {
  const p = new URLSearchParams(query);
  const sort = p.get("sort") ?? "";
  return {
    status: p.get("status") ?? "",
    tag: p.get("tag") ?? "",
    done: p.get("done") === "show",
    cleanup: p.get("cleanup") === "needed",
    sort: SORT_KEYS.includes(sort) ? (sort as EpicSortKey) : DEFAULT_EPICS.sort,
  };
}

/** Canonical query string for a state — empty when everything is default. */
export function epicListQuery(state: EpicListState): string {
  const p = new URLSearchParams();
  if (state.status) p.set("status", state.status);
  if (state.tag) p.set("tag", state.tag);
  if (state.done) p.set("done", "show");
  if (state.cleanup) p.set("cleanup", "needed");
  if (state.sort !== DEFAULT_EPICS.sort) p.set("sort", state.sort);
  return p.toString();
}

export function epicListEmptyMessage(state: EpicListState): string {
  if (!state.cleanup) return "nothing matches";
  return state.status || state.tag || state.done
    ? "No cleanup-needed epics match these filters."
    : "No epics need cleanup.";
}

const idNum = (id: string) => Number(id.split("-").pop());
const progress = (e: EpicRow) => (e.total ? e.done / e.total : 0);

// Lifecycle order for the status sort: active work first, terminal history last;
// unknown statuses sink to the bottom.
const STATUS_ORDER: readonly string[] = [
  "in-progress",
  "todo",
  "blocked",
  "in-review",
  "done",
  "closed",
];
const statusRank = (e: EpicRow) => {
  const i = STATUS_ORDER.indexOf(e.status ?? "");
  return i === -1 ? STATUS_ORDER.length : i;
};

// Each sort key has a fixed, natural direction: freshest first, closest to
// done first, most urgent first, most active first. Ties fall back to newest id.
const cmp: Record<EpicSortKey, (a: EpicRow, z: EpicRow) => number> = {
  activity: (a, z) => z.lastActivity.localeCompare(a.lastActivity),
  progress: (a, z) => progress(z) - progress(a),
  priority: (a, z) => (a.priority ?? "p2").localeCompare(z.priority ?? "p2"),
  status: (a, z) => statusRank(a) - statusRank(z),
};

const terminal = (status: string | null): boolean =>
  status === "done" || status === "closed";

/** Filters AND together; an explicit status filter overrides hidden history. */
export function applyEpicList(
  rows: EpicRow[],
  state: EpicListState,
): EpicRow[] {
  return rows
    .filter(
      (e) =>
        (state.status
          ? e.status === state.status
          : state.done || !terminal(e.status)) &&
        (!state.tag || e.tags.includes(state.tag)) &&
        (!state.cleanup || e.needsCleanup),
    )
    .sort((a, z) => cmp[state.sort](a, z) || idNum(z.id) - idNum(a.id));
}
