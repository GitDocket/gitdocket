// Manual lane order: rank is one global number per task, lower
// first, unranked trailing. A drop writes only the dragged card's rank —
// the midpoint of its new neighbors — so reordering never renumbers files.

export interface RankedCard {
  id: string;
  rank: number | null;
}

/** Gap left when there is no neighbor on one side to take a midpoint with. */
const STEP = 10;

/**
 * Rank for dropping `draggedId` before `beforeId` (null = end of the lane),
 * given the lane's cards in displayed manual order. Ranked cards form a
 * prefix of that order, so a drop into the unranked tail lands at the end of
 * the ranked section. Returns null when the drop changes nothing.
 */
export function dropRank(
  cards: readonly RankedCard[],
  draggedId: string,
  beforeId: string | null,
): number | null {
  const rest = cards.filter((c) => c.id !== draggedId);
  const at =
    beforeId === null ? rest.length : rest.findIndex((c) => c.id === beforeId);
  if (at === -1) return null; // dropped on itself or an unknown card

  const prev = rest[at - 1]?.rank ?? null;
  const next = rest[at]?.rank ?? null;
  const to =
    prev !== null && next !== null
      ? (prev + next) / 2
      : prev !== null
        ? prev + STEP
        : next !== null
          ? next - STEP
          : // No ranked neighbor: drop into (or after) the unranked tail —
            // append to the lane's ranked section, or start one.
            Math.max(0, ...rest.map((c) => c.rank ?? 0)) + STEP;

  const current = cards.find((c) => c.id === draggedId)?.rank ?? null;
  return to === current ? null : to;
}
