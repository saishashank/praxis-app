// Research engine, costs (M23 R1; D-1626, D-1627, D-1655). Pure: the fee of a fill from a named cost profile through the
// app's own fee engine (never a copy), the net of one simulated trade in parts per million of its entry value, and the
// survivorship haircut of D-893. Money is exact bigint micro units; rounding is half away from zero, once, on an exact
// rational. Nothing here reads a clock, the network or a database.
import { costProfileByCode, feeFor, quantityAt } from "@/lib/arena/costs";
import { makeRational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";

export type Micro = bigint;

/** A fee for one fill: side, the fill's value, the code and the whole shares (micro, exact). */
export type CostFn = (
  side: "buy" | "sell",
  notionalMicro: Micro,
  code: string,
  quantity: bigint,
) => Micro;

/** The base book's parcel in micro (FAM-005, 600 whole units of the market currency). */
export const PARCEL_BASE_MICRO: Micro = 600_000_000n; // threshold-ok: FAM-005 parcel of the Cortex book
/** The sensitivity parcel (CXA-003 variants): shown only with the label below, never able to trade (D-1628). */
export const PARCEL_LARGE_MICRO: Micro = 5_000_000_000n; // threshold-ok: CXA-003 sensitivity parcel
/** The words every figure at the larger parcel carries (D-1627). */
export const LARGER_ACCOUNT_LABEL = "Larger account, not your book";

const PPM = 1_000_000n; // threshold-ok: parts per million

/** The label for a figure at `parcelMicro`: null for the base parcel, the larger-account words for any other. */
export function parcelLabel(
  parcelMicro: Micro,
  baseMicro: Micro = PARCEL_BASE_MICRO,
): string | null {
  return parcelMicro === baseMicro ? null : LARGER_ACCOUNT_LABEL;
}

/** A cost function over a named profile of the app's fee engine (D-895: the default research profile). */
export function profileCostFn(profileCode: string): CostFn {
  const profile = costProfileByCode(profileCode);
  return (side, notionalMicro, code, quantity) =>
    feeFor(profile, notionalMicro, side, { code, quantity });
}

/** A cost function that charges nothing (the "without costs" reading and tests). */
export const NO_COST: CostFn = () => 0n;

export type TradeInput = {
  readonly code: string;
  readonly entryMicro: Micro;
  readonly exitMicro: Micro;
  readonly parcelMicro: Micro;
  readonly cost: CostFn;
};

export type TradeResult = {
  readonly quantity: bigint;
  readonly entryValueMicro: Micro;
  readonly feesMicro: Micro;
  readonly netMicro: Micro;
  /** Net over the entry value, parts per million, rounded half away from zero (exact). */
  readonly netPpm: bigint;
};

/**
 * One trade: whole shares = floor(parcel / entry price), at least 1; bought at the entry price, sold at the exit price,
 * a fee on each side from the profile on that side's value. The net is in parts per million of the entry value, so a
 * larger parcel changes the result only through the fees (D-1627 sensitivity).
 */
export function simulateTrade(t: TradeInput): TradeResult {
  if (t.entryMicro <= 0n || t.exitMicro <= 0n) throw new RangeError("prices must be positive");
  if (t.parcelMicro <= 0n) throw new RangeError("parcel must be positive");
  const quantity = quantityAt(t.parcelMicro, t.entryMicro);
  const buyValue = quantity * t.entryMicro;
  const sellValue = quantity * t.exitMicro;
  const fees =
    t.cost("buy", buyValue, t.code, quantity) + t.cost("sell", sellValue, t.code, quantity);
  const netMicro = sellValue - buyValue - fees;
  return {
    quantity,
    entryValueMicro: buyValue,
    feesMicro: fees,
    netMicro,
    netPpm: roundHalfAwayFromZero(makeRational(netMicro * PPM, buyValue)),
  };
}

/** The survivorship haircut rule: `ppmPerBlock` parts per million for every `blockSessions` sessions held (D-893). */
export type HaircutRule = { readonly ppmPerBlock: number; readonly blockSessions: number };

/** One percentage point (10,000 ppm) per 60 sessions held: the assumed home-market haircut (D-893, D-1626). */
export const ASSUMED_HAIRCUT_RULE: HaircutRule = { ppmPerBlock: 10_000, blockSessions: 60 }; // threshold-ok: D-893

/** The haircut of a hold, ppm, exact (half away from zero once). A null rule is no haircut. */
export function haircutPpm(hold: number, rule: HaircutRule | null): bigint {
  if (rule === null) return 0n;
  if (!Number.isInteger(hold) || hold < 0)
    throw new RangeError("hold must be a non-negative integer");
  return roundHalfAwayFromZero(
    makeRational(BigInt(rule.ppmPerBlock) * BigInt(hold), BigInt(rule.blockSessions)),
  );
}

/** Round-trip fee drag of a flat trade (entry price = exit price) in ppm of the entry value: the cost profile alone. */
export function roundTripCostPpm(input: {
  code: string;
  priceMicro: Micro;
  parcelMicro: Micro;
  cost: CostFn;
}): bigint {
  const r = simulateTrade({
    code: input.code,
    entryMicro: input.priceMicro,
    exitMicro: input.priceMicro,
    parcelMicro: input.parcelMicro,
    cost: input.cost,
  });
  return -r.netPpm;
}
