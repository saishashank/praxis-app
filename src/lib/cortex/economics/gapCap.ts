// Gap-risk cap (M15 C3a; spec ch. 17 CTX-022b, CTX-013 step 7, CTX-028 O06; keys `max_loss_pct`,
// `entry_gap_cap_pct`).
//
//   skip if stop distance + matched-setup gap95 > max_loss_pct
//
// The stop distance is referenced to the actual fill (re-checked at the fill, O06_stop_gap95) and
// to the planned entry price at decision time (G07_gap_cap). The comparison is EXACT (review S1):
// the stop distance is a Rational of micro-dollars, gap95 (the cell's float 95th-percentile adverse
// overnight gap, C2 `CellStatistic.gap95`) is rounded once to parts per million and carried as a
// Rational, and `max_loss_pct` is a Rational — so 14 % + 4 % = 18 % passes, which float addition
// (0.14 + 0.04 > 0.18) would refuse.
import type { Micro } from "@/lib/money/micro";
import { addRat, cmpRat, makeRational, type Rational } from "@/lib/money/rational";

const PPM = 1_000_000n;

/** Default `max_loss_pct` (18 %; 12–25) as an exact fraction. */
export const DEFAULT_MAX_LOSS: Rational = makeRational(18n, 100n); // threshold-ok: CTX-022b 18 %
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

/** The float of a stop distance (display / statistics only; micro amounts are inside 2^53). */
export function stopDistanceFraction(refMicro: Micro, stopMicro: Micro): number {
  const r = stopDistanceRat(refMicro, stopMicro);
  return Number(r.num) / Number(r.den);
}

/** A float fraction (a statistic) as an exact Rational in parts per million, rounded half up. */
export function fractionToPpmRat(fraction: number): Rational {
  if (!(fraction >= 0) || !Number.isFinite(fraction))
    throw new RangeError("fraction must be a finite number >= 0");
  return makeRational(BigInt(Math.round(fraction * 1_000_000)), PPM);
}

export type GapCapInput = {
  /** Stop distance as an exact fraction of the reference price (`stopDistanceRat`). */
  readonly stopDistance: Rational;
  /** The matched cell's 95th-percentile adverse overnight gap (float fraction, rounded to ppm here). */
  readonly gap95: number;
  /** `max_loss_pct` as an exact fraction; default 18/100. */
  readonly maxLoss?: Rational;
};

export type GapCapResult =
  | { readonly pass: true; readonly total: Rational; readonly maxLoss: Rational }
  | {
      readonly pass: false;
      readonly total: Rational;
      readonly maxLoss: Rational;
      readonly label: string;
    };

/** CTX-022b: pass when stop distance + gap95 ≤ max_loss, exactly (equality passes). */
export function gapCapTest(input: GapCapInput): GapCapResult {
  const maxLoss = input.maxLoss ?? DEFAULT_MAX_LOSS;
  if (input.stopDistance.num < 0n) throw new RangeError("stop distance must be >= 0");
  if (maxLoss.num <= 0n) throw new RangeError("max loss must be > 0");
  const total = addRat(input.stopDistance, fractionToPpmRat(input.gap95));
  return cmpRat(total, maxLoss) <= 0
    ? { pass: true, total, maxLoss }
    : { pass: false, total, maxLoss, label: GAP_CAP_LABEL };
}
