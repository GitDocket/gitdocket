// Board filter and swimlane state. Filters live in the URL hash
// query — the same convention as the all-tasks view — so a filtered
// board survives copy-paste; this module is the translation between that
// query string and the card set each column renders.

export interface EpicRef {
  path: string;
  id: string;
  title: string | null;
}

export interface FacetedCard {
  epic: EpicRef | null;
  tags: string[];
  assignee: string | null;
}

export interface BoardState {
  epic: string; // epic id
  tag: string;
  assignee: string;
  group: boolean; // group-by-epic swimlanes
}

export const DEFAULT_BOARD: BoardState = {
  epic: "",
  tag: "",
  assignee: "",
  group: false,
};

export function parseBoardState(query: string): BoardState {
  const p = new URLSearchParams(query);
  return {
    epic: p.get("epic") ?? "",
    tag: p.get("tag") ?? "",
    assignee: p.get("assignee") ?? "",
    group: p.get("group") === "epic",
  };
}

/** Canonical query string for a state — empty when everything is default. */
export function boardStateQuery(state: BoardState): string {
  const p = new URLSearchParams();
  if (state.epic) p.set("epic", state.epic);
  if (state.tag) p.set("tag", state.tag);
  if (state.assignee) p.set("assignee", state.assignee);
  if (state.group) p.set("group", "epic");
  return p.toString();
}

/** Filters AND together; grouping is layout, not a filter. */
export function filterCards<T extends FacetedCard>(
  cards: readonly T[],
  state: BoardState,
): T[] {
  return cards.filter(
    (c) =>
      (!state.epic || c.epic?.id === state.epic) &&
      (!state.tag || c.tags.includes(state.tag)) &&
      (!state.assignee || c.assignee === state.assignee),
  );
}

export interface BoardLane<T> {
  epic: EpicRef | null;
  cards: T[];
}

const idNum = (id: string) => Number(id.split("-").pop());

/** Swimlane partition: newest epic first (id order), cards without an epic last. */
export function groupByEpic<T extends FacetedCard>(
  cards: readonly T[],
): BoardLane<T>[] {
  const lanes = new Map<string, BoardLane<T>>();
  for (const card of cards) {
    const key = card.epic?.id ?? "";
    const lane = lanes.get(key) ?? { epic: card.epic, cards: [] };
    lane.cards.push(card);
    lanes.set(key, lane);
  }
  return [...lanes.values()].sort((a, z) => {
    if (!a.epic || !z.epic) return a.epic ? -1 : 1;
    return idNum(z.epic.id) - idNum(a.epic.id);
  });
}
