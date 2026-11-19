// The cost bar of the Committee trial (M22 C2; VAL-111, D-1421): one round trip at the home market's default cost profile,
// in parts per million of the notional. Frozen into the pre-registration, so a later fee change cannot move the bar of a
// running trial. Conservative on purpose: the slippage bucket is the least liquid one (zero average daily value), which
// is the dearest, so a PASS must clear the highest round-trip cost the cost gate would ever charge. Pure.
import { roundTripCost } from "@/lib/agents/costGate";
import { getCostProfile } from "@/lib/arena/costs";
import { makeRational, mulRat } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";

const PPM = 1_000_000n; // threshold-ok: parts per million
/** The default cost profile of the home market (the picks and the cost gate use the same one). */
const DEFAULT_PROFILE = "P5";

/** One round trip (fees on both sides plus slippage on both fills) in ppm, an integer. */
export function roundTripThresholdPpm(): number {
  const cost = roundTripCost(getCostProfile(DEFAULT_PROFILE), 0n);
  return Number(roundHalfAwayFromZero(mulRat(cost, makeRational(PPM))));
}
