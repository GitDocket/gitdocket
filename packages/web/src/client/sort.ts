// Board column sorting is a pure client concern. The server keeps
// returning one canonical order; a column with no mode
// selected renders that order untouched, and every mode is a stable re-sort
// on top of it.

export interface SortableCard {
  id: string;
  priority: string | null;
  timestamp: string | null;
}

export type SortMode = {
  key: "priority" | "recency" | "id";
  dir: "asc" | "desc";
} | null;

// Click cycle: server default → priority high-first → low-first →
// newest-first → oldest-first → id high-first → low-first →
// back to default.
const CYCLE: SortMode[] = [
  null,
  { key: "priority", dir: "asc" },
  { key: "priority", dir: "desc" },
  { key: "recency", dir: "desc" },
  { key: "recency", dir: "asc" },
  { key: "id", dir: "desc" },
  { key: "id", dir: "asc" },
];

export function nextMode(mode: SortMode): SortMode {
  const at = CYCLE.findIndex(
    (m) => m?.key === mode?.key && m?.dir === mode?.dir,
  );
  return CYCLE[(at + 1) % CYCLE.length] ?? null;
}

export function modeLabel(mode: SortMode): string {
  if (!mode) return "⇅";
  if (mode.key === "priority") return mode.dir === "asc" ? "p0→" : "p3→";
  if (mode.key === "id") return mode.dir === "desc" ? "id↓" : "id↑";
  return mode.dir === "desc" ? "new→" : "old→";
}

/** Stable sort; missing priority sorts as p9, missing timestamp as oldest. */
export function sortCards<T extends SortableCard>(
  cards: readonly T[],
  mode: SortMode,
): T[] {
  if (!mode) return [...cards];
  const value = (c: T): string => {
    if (mode.key === "priority") return c.priority ?? "p9";
    return mode.key === "id" ? c.id : (c.timestamp ?? "");
  };
  const flip = mode.dir === "asc" ? 1 : -1;
  // numeric: ids compare by their number.
  return cards
    .map((card, at) => ({ card, at }))
    .sort(
      (a, b) =>
        flip *
          value(a.card).localeCompare(value(b.card), undefined, {
            numeric: true,
          }) || a.at - b.at,
    )
    .map((entry) => entry.card);
}
