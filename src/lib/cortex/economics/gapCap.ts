// Gap-risk cap (M15 C3a; spec ch. 17 CTX-022b, CTX-013 step 7, CTX-028 O06; keys `max_loss_pct`,
// `entry_gap_cap_pct`).
//
//   skip if stop distance + matched-setup gap95 > max_loss_pct
//
// The stop distance is referenced to the actual fill (re-checked at the fill, O06_stop_gap95) and
// to the planned entry price at decision time (G07_gap_cap). gap95 is the cell's 95th-percentile
// adverse overnight gap (a bootstrap-free order statistic, float, C2 `CellStatistic.gap95`), so the
// comparison is a statistic in floats; the stop distance itself is exact until the boundary here.
import type { Micro } from "@/lib/money/micro";
import { makeRational, type Rational } from "@/lib/money/rational";

/** Default `max_loss_pct` (18 %; 12–25) as a fraction. */
export const DEFAULT_MAX_LOSS = 0.18;
/** Default `entry_gap_cap_pct` (8 %; 4–12) as an exact fraction (the limit formula is money). */
export const DEFAULT_ENTRY_GAP_CAP: Rational = makeRational(8n, 100n); // threshold-ok: CTX-022b 8 %

/** The plain label of the G07 / O06 failure. */
export const GAP_CAP_LABEL = "a bad overnight gap could cost more than we allow";

/** Stop distance as an exact fraction of the reference (fill or planned entry) price. */
export function stopDistanceRat(refMicro: Micro, stopMicro: Micro): Rational {
  if (refMicro <= 0n) throw new RangeError("reference price must be positive");
  if (stopMicro <= 0n || stopMicro >= refMicro)
    throw new RangeError("stop must be positive and below the reference price");
  return makeRational(refMicro - stopMicro, refMicro);
}

/** The float of a stop distance (money → statistics boundary; micro amounts are inside 2^53). */
export function stopDistanceFraction(refMicro: Micro, stopMicro: Micro): number {
  const r = stopDistanceRat(refMicro, stopMicro);
  return Number(r.num) / Number(r.den);
}

export type GapCapInput = {
  /** Stop distance as a fraction of the reference price (`stopDistanceFraction`). */
  readonly stopDistance: number;
  /** The matched cell's 95th-percentile adverse overnight gap (fraction). */
  readonly gap95: number;
  /** `max_loss_pct` as a fraction. */
  readonly maxLoss?: number;
};

export type GapCapResult =
  | { readonly pass: true; readonly total: number; readonly maxLoss: number }
  | {
      readonly pass: false;
      readonly total: number;
      readonly maxLoss: number;
      readonly label: string;
    };

/** CTX-022b: pass when stop distance + gap95 ≤ max_loss (equality passes). */
export function gapCapTest(input: GapCapInput): GapCapResult {
  const maxLoss = input.maxLoss ?? DEFAULT_MAX_LOSS;
  if (!(input.stopDistance >= 0) || !(input.gap95 >= 0) || !(maxLoss > 0))
    throw new RangeError("stop distance and gap95 must be >= 0, max loss > 0");
  const total = input.stopDistance + input.gap95;
  return total <= maxLoss
    ? { pass: true, total, maxLoss }
    : { pass: false, total, maxLoss, label: GAP_CAP_LABEL };
}
