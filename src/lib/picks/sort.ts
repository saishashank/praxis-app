// UXN-309 pick order (M17 WP7). "chance": chance descending, ties by expected net gain, then rank; picks with no
// chance go last in the V1/Cortex rank order. "expected_gain": gain descending, picks with no gain last, then rank.
// With every family in shadow no pick has a chance, so the order is plain rank order. Pure; never mutates.
import type { ChanceDisplay } from "./chance";

export type SortablePick = {
  readonly rank: number;
  readonly chance: ChanceDisplay;
  /** Expected net gain, ppm of the buy price; null when none is stored. */
  readonly expectedGainPpm: number | null;
};

export type SortBasis = "chance" | "expected_gain";

const gain = (g: number | null): number => (g === null ? Number.NEGATIVE_INFINITY : g);

export function sortPicks<T extends SortablePick>(rows: readonly T[], basis: SortBasis): T[] {
  const out = [...rows];
  if (basis === "expected_gain") {
    return out.sort((a, b) => gain(b.expectedGainPpm) - gain(a.expectedGainPpm) || a.rank - b.rank);
  }
  return out.sort((a, b) => {
    const ac = a.chance.kind === "chance" ? a.chance.pct : null;
    const bc = b.chance.kind === "chance" ? b.chance.pct : null;
    if (ac === null && bc === null) return a.rank - b.rank;
    if (ac === null) return 1;
    if (bc === null) return -1;
    return bc - ac || gain(b.expectedGainPpm) - gain(a.expectedGainPpm) || a.rank - b.rank;
  });
}
