// UXN-307 list shape (M17 WP7, D-383): up to 10 picks per profile, no per-family or per-sector cap, and the
// `pick_min_chance` floor (55 %) applied ONLY to a pick of an allowed or live-tested family that shows a chance.
// Shadow families (all of them today) are gated by the V1 rules alone, so the floor is dormant. Plus the
// concentration line: how many picks come from each family. Pure; never reads Cortex output for V1 generation.
import { familyBadge } from "@/lib/ui/familyBadge";
import type { ChanceDisplay, ChanceStatus } from "./chance";

export const PICKS_PER_PROFILE = 10; // threshold-ok: UXN-307 list length

export type FloorPick = {
  readonly family: string;
  readonly status: ChanceStatus;
  readonly chance: ChanceDisplay;
};

const PCT_BASE = 100; // threshold-ok: percent scale

/** True when the floor applies to this pick (allowed or live-tested family with a shown chance). */
export function floorApplies(p: FloorPick): boolean {
  return (p.status === "allowed" || p.status === "live-tested") && p.chance.kind === "chance";
}

/** `minChancePct` is the `pick_min_chance` key as a percent (55). Keeps input order; caps at `limit`. */
export function applyFloor<T extends FloorPick>(
  rows: readonly T[],
  minChancePct: number,
  limit: number = PICKS_PER_PROFILE,
): T[] {
  const kept = rows.filter(
    (r) => !floorApplies(r) || (r.chance.kind === "chance" && r.chance.pct >= minChancePct),
  );
  return kept.slice(0, limit);
}

export type ConcentrationItem = {
  readonly family: string;
  readonly label: string;
  readonly code: string;
  readonly count: number;
  /** Whole-percent share of the list. */
  readonly sharePct: number;
};

/** The concentration line: families by count (ties by family code); labels from the one badge table. */
export function concentration(rows: readonly { readonly family: string }[]): ConcentrationItem[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.family, (counts.get(r.family) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([family, count]) => {
      const b = familyBadge(family);
      return {
        family,
        label: b.label,
        code: b.code,
        count,
        sharePct: Math.round((count / rows.length) * PCT_BASE),
      };
    });
}
