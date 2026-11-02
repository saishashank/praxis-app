// FAM-004 stop-distance cap (M14, D-216; docs/M14_design.md 2.1). Pure and exact.
// The distance is (reference - initial stop) / reference at the reference price (the D close on the
// fill basis); a candidate whose distance is above `max_stop_distance_pct` is blocked as
// `skipped_stop_distance`. The cap is an execution-wide entry rule, not a parameter of a lineage.
import { cmpRat, makeRational, type Rational } from "@/lib/money/rational";
import { initialStop } from "./exits";
import type { Candidate } from "./types";

export const STOP_DISTANCE_REASON = "skipped_stop_distance";

/** Stop distance as an exact fraction of the reference price (ref > 0). */
export function stopDistance(c: Pick<Candidate, "stopSpec">, refPriceMicro: bigint): Rational {
  if (refPriceMicro <= 0n) throw new RangeError("reference price must be positive");
  return makeRational(refPriceMicro - initialStop(c.stopSpec, refPriceMicro), refPriceMicro);
}

/** True when the distance is strictly above the cap (exactly 12 % passes at a 12 % cap). */
export function exceedsStopCap(
  c: Pick<Candidate, "stopSpec">,
  refPriceMicro: bigint,
  cap: Rational,
): boolean {
  return cmpRat(stopDistance(c, refPriceMicro), cap) > 0;
}
