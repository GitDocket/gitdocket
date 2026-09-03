// Pure filter/sort logic for the all-tasks view. List state lives in
// the URL hash query so a filtered view survives copy-paste; this module is
// the single translation between that query string and a rendered row set.

export interface TaskRow {
  path: string;
  id: string;
  type: string;
  title: string | null;
  status: string;
  priority: string;
  tags: string[];
  ready: boolean;
  epic: { path: string; id: string; title: string | null } | null;
}

export type SortKey = "id" | "title" | "status" | "priority";

export interface ListState {
  type: string;
  status: string;
  epic: string;
  priority: string;
  tag: string;
  q: string;
  sort: SortKey;
  dir: "asc" | "desc";
}

export const DEFAULT_STATE: ListState = {
  type: "",
  status: "",
  epic: "",
  priority: "",
  tag: "",
  q: "",
  sort: "id",
  dir: "desc",
};

const FACETS = ["type", "status", "epic", "priority", "tag", "q"] as const;
const SORT_KEYS: readonly string[] = ["id", "title", "status", "priority"];

export function parseListState(query: string): ListState {
  const p = new URLSearchParams(query);
  const sort = p.get("sort") ?? "";
  const dir = p.get("dir");
  return {
    type: p.get("type") ?? "",
    status: p.get("status") ?? "",
    epic: p.get("epic") ?? "",
    priority: p.get("priority") ?? "",
    tag: p.get("tag") ?? "",
    q: p.get("q") ?? "",
    sort: SORT_KEYS.includes(sort) ? (sort as SortKey) : DEFAULT_STATE.sort,
    dir: dir === "asc" || dir === "desc" ? dir : DEFAULT_STATE.dir,
  };
}

/** Canonical query string for a state — empty when everything is default. */
export function listStateQuery(state: ListState): string {
  const p = new URLSearchParams();
  for (const key of FACETS) if (state[key]) p.set(key, state[key]);
  if (state.sort !== DEFAULT_STATE.sort || state.dir !== DEFAULT_STATE.dir) {
    p.set("sort", state.sort);
    p.set("dir", state.dir);
  }
  return p.toString();
}

const idNum = (id: string) => Number(id.split("-").pop());

/** Filters AND together; free text matches id + title, case-insensitive. */
export function applyList(
  rows: TaskRow[],
  states: string[],
  state: ListState,
): TaskRow[] {
  const q = state.q.trim().toLowerCase();
  const filtered = rows.filter(
    (r) =>
      (!state.type || r.type === state.type) &&
      (!state.status || r.status === state.status) &&
      (!state.epic || r.epic?.id === state.epic) &&
      (!state.priority || r.priority === state.priority) &&
      (!state.tag || r.tags.includes(state.tag)) &&
      (!q || `${r.id} ${r.title ?? ""}`.toLowerCase().includes(q)),
  );
  const cmp: Record<SortKey, (a: TaskRow, z: TaskRow) => number> = {
    id: (a, z) => idNum(a.id) - idNum(z.id),
    title: (a, z) => (a.title ?? "").localeCompare(z.title ?? ""),
    status: (a, z) => states.indexOf(a.status) - states.indexOf(z.status),
    priority: (a, z) => a.priority.localeCompare(z.priority),
  };
  const sign = state.dir === "asc" ? 1 : -1;
  return filtered.sort(
    (a, z) => sign * cmp[state.sort](a, z) || idNum(z.id) - idNum(a.id),
  );
}
