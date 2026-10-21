// Entry sizing (spec 05 ARN-023, ARN-024, ARN-024a, ARN-013; M3 design 4.3; D-069/D-070/D-071).
// Pure functions over bigint micro-AUD and exact rationals. Every rounding is one of:
//   shares = floor (ARN-023), fill price = adverse tick rounding (slippage.ts), brokerage and the
//   cash buffer = one half-away-from-zero rounding to 1 micro (decisions 6 and 7).
// HIGH-RISK money maths: no float, no iteration (ARN-024a s13).
import { type Micro } from "@/lib/money/micro";
import {
  addRat,
  divFloor,
  makeRational,
  mulRat,
  subRat,
  type Rational,
} from "@/lib/money/rational";
import { floorRat, roundHalfAwayFromZero } from "@/lib/money/round";
import { feeFor, type CostProfile, type FeeContext } from "./costs";
import type { Tier } from "./schema";
import {
  DEFAULT_TICK_CROSS_FACTOR,
  SLIPPAGE_BUCKETS,
  stallFloorSlippageMicro,
  slippageFill,
  untradeableReason,
  type SlippageBucket,
  type UntradeableReason,
} from "./slippage";

/** [VERIFY] ARN-024 (l.56): AU minimum marketable parcel A$500. Not Owner-approved yet. */
export const MIN_MARKETABLE_PARCEL_MICRO: Micro = 500_000_000n;
/** ARN-024 (l.56) / ch.15 `participation_cap`: 1 % of the 20-session ADV (in shares). */
export const DEFAULT_PARTICIPATION_CAP: Rational = makeRational(1n, 100n);
/** ARN-024a (l.57) / ch.15 `cash_buffer`: 1 % of NAV. */
export const DEFAULT_CASH_BUFFER: Rational = makeRational(1n, 100n);
/** Stall floor (spec 05 section 5.1): entry slippage is taken at 10 bps of the parcel. */
export const STALL_FLOOR_SLIPPAGE_BPS: Rational = makeRational(10n);

/**
 * Why a buy is not placed (mirrors `KNOWN_REJECT_REASONS` in schema.ts). Stall condition (b) of
 * section 5.1 counts sessions where EVERY reason is `parcel` or `whole_share`.
 */
export type SizingReason = "cash" | "whole_share" | "parcel" | "participation";

export type SizingInput = {
  /** Settled / matched cash available (ARN-024a), micro-AUD. */
  readonly settledCashMicro: Micro;
  /** NAV at the decision close; the buffer is a fraction of it. */
  readonly navMicro: Micro;
  /** Sleeve margin that will be moved out of cash if a sleeve opens with this entry (ARN-003). */
  readonly sleeveMarginMicro?: Micro;
  /** Raw reference price for the fill (the next open), micro-AUD per share, > 0. */
  readonly refPriceMicro: Micro;
  /** 20-session ADV as traded value, micro-AUD (slippage bucket and ARN-013 label). */
  readonly advValueMicro: Micro;
  /** 20-session ADV in shares (participation cap). */
  readonly adv20Shares: bigint;
  readonly tier: Tier;
  readonly profile: CostProfile;
  readonly feeContext?: FeeContext;
  readonly minParcelMicro?: Micro;
  readonly participationCap?: Rational;
  readonly cashBuffer?: Rational;
  readonly tickCrossFactor?: Rational;
  readonly buckets?: readonly SlippageBucket[];
  readonly untradeableAdvFraction?: Rational;
};

export type SizingResult = {
  /** True when no reason applies: the order may be placed for `qty` shares. */
  readonly accepted: boolean;
  /** Every failed rule, in the order cash, whole_share, parcel, participation. Empty if accepted. */
  readonly reasons: readonly SizingReason[];
  /** Whole shares sized (also reported for a rejection, so the log shows what was refused). */
  readonly qty: bigint;
  /** Expected fill price per share, slippage included (ARN-024a), adverse on the tick grid. */
  readonly fillPriceMicro: Micro;
  readonly slipMicro: Micro;
  readonly bufferMicro: Micro;
  /** Cash minus sleeve margin minus buffer, before the brokerage estimate. */
  readonly preBrokerageMicro: Micro;
  readonly estBrokerageMicro: Micro;
  readonly deployableMicro: Micro;
  readonly orderValueMicro: Micro;
  /** Actual brokerage recomputed on the real order value (ARN-024a s13). */
  readonly brokerageMicro: Micro;
  readonly totalCostMicro: Micro;
  /** Settled cash left after the entry and any sleeve margin moved. */
  readonly cashAfterMicro: Micro;
  /** Participation cap in shares (floor of cap x ADV shares). */
  readonly capShares: bigint;
  /** ARN-013 label (a label, never a rejection); null when tradeable. */
  readonly untradeable: UntradeableReason | null;
};

/** ARN-024 text for the `arena_order.reject_reason` column: reasons joined by a comma. */
export function rejectReasonText(reasons: readonly SizingReason[]): string {
  return reasons.join(",");
}

/**
 * True when every reason is a parcel / whole-share reason (stall condition (b), section 5.1).
 * An accepted result (no reasons) is not a rejection.
 */
export function isParcelOnlyRejection(reasons: readonly SizingReason[]): boolean {
  return reasons.length > 0 && reasons.every((r) => r === "parcel" || r === "whole_share");
}

/**
 * Size a new entry (ARN-024a):
 *   buffer = cash_buffer x NAV
 *   pre = cash - sleeve margin - buffer
 *   estimated brokerage = profile charge on an order worth the whole `pre`
 *   deployable = pre - estimated brokerage
 *   shares = floor(deployable / expected fill)   (expected fill already includes slippage)
 *   then: parcel >= minimum, shares <= cap x ADV shares; actual brokerage on the real value.
 */
export function sizeEntry(input: SizingInput): SizingResult {
  if (input.refPriceMicro <= 0n) throw new RangeError("reference price must be positive");
  if (input.adv20Shares < 0n) throw new RangeError("ADV shares cannot be negative");
  const quote = slippageFill(
    input.refPriceMicro,
    "buy",
    input.advValueMicro,
    input.tickCrossFactor ?? DEFAULT_TICK_CROSS_FACTOR,
    input.buckets ?? SLIPPAGE_BUCKETS,
  );
  const buffer = roundHalfAwayFromZero(
    mulRat(makeRational(input.navMicro), input.cashBuffer ?? DEFAULT_CASH_BUFFER),
  );
  const margin = input.sleeveMarginMicro ?? 0n;
  const pre = input.settledCashMicro - margin - buffer;
  const capShares = floorRat(
    mulRat(makeRational(input.adv20Shares), input.participationCap ?? DEFAULT_PARTICIPATION_CAP),
  );
  const base = {
    fillPriceMicro: quote.fillMicro,
    slipMicro: quote.slipMicro,
    bufferMicro: buffer,
    preBrokerageMicro: pre,
    capShares,
  };
  const nothing = {
    ...base,
    qty: 0n,
    estBrokerageMicro: 0n,
    deployableMicro: pre,
    orderValueMicro: 0n,
    brokerageMicro: 0n,
    totalCostMicro: 0n,
    cashAfterMicro: input.settledCashMicro - margin,
    untradeable: null,
  };
  const noCash = (estBrokerageMicro: Micro, deployableMicro: Micro): SizingResult => ({
    ...nothing,
    accepted: false,
    reasons: ["cash"],
    estBrokerageMicro,
    deployableMicro,
  });
  if (pre <= 0n) return noCash(0n, pre);

  const feeContext = input.feeContext ?? {};
  const est = feeFor(input.profile, pre, "buy", feeContext);
  const deployable = pre - est;
  if (deployable <= 0n) return noCash(est, deployable);

  const qty = divFloor(deployable, quote.fillMicro);
  if (qty === 0n) {
    return {
      ...nothing,
      accepted: false,
      reasons: ["whole_share"],
      estBrokerageMicro: est,
      deployableMicro: deployable,
    };
  }
  const value = qty * quote.fillMicro;
  const brokerage = feeFor(input.profile, value, "buy", feeContext);
  const total = value + brokerage;
  const reasons: SizingReason[] = [];
  // Cannot happen with a non-decreasing profile (P5); guards a profile whose fee falls with value.
  if (total > pre) reasons.push("cash");
  if (value < (input.minParcelMicro ?? MIN_MARKETABLE_PARCEL_MICRO)) reasons.push("parcel");
  if (qty > capShares) reasons.push("participation");
  return {
    ...base,
    accepted: reasons.length === 0,
    reasons,
    qty,
    estBrokerageMicro: est,
    deployableMicro: deployable,
    orderValueMicro: value,
    brokerageMicro: brokerage,
    totalCostMicro: total,
    cashAfterMicro: input.settledCashMicro - margin - total,
    untradeable: untradeableReason({
      tradeValueMicro: value,
      advMicro: input.advValueMicro,
      tier: input.tier,
      advFraction: input.untradeableAdvFraction,
    }),
  };
}

export type StallFloorInput = {
  readonly profile: CostProfile;
  readonly parcelMicro?: Micro;
  readonly cashBuffer?: Rational;
  /** Slippage as bps of the parcel (default 10, spec section 5.1). */
  readonly slippageBps?: Rational;
  /**
   * Optional reference price: slippage per share becomes max(slippage bps, one tick) rounded
   * adverse (decision 4, `stallFloorSlippageMicro`), scaled to the parcel as shares-equivalent.
   */
  readonly refPriceMicro?: Micro;
};

/**
 * Stall floor (spec 05 section 5.1, decision 4): the NAV below which a fresh entry cannot meet
 * the parcel: (parcel + entry brokerage + entry slippage) / (1 - buffer), rounded once.
 * With defaults and P5 this is 510_606_061 micro (the spec writes "about A$511").
 */
export function stallFloorMicro(input: StallFloorInput): Micro {
  const parcel = input.parcelMicro ?? MIN_MARKETABLE_PARCEL_MICRO;
  const buffer = input.cashBuffer ?? DEFAULT_CASH_BUFFER;
  const fee = feeFor(input.profile, parcel, "buy");
  let slip: Rational;
  if (input.refPriceMicro === undefined) {
    slip = mulRat(
      makeRational(parcel),
      mulRat(input.slippageBps ?? STALL_FLOOR_SLIPPAGE_BPS, makeRational(1n, 10_000n)),
    );
  } else {
    const perShare = stallFloorSlippageMicro(input.refPriceMicro, input.slippageBps);
    slip = mulRat(makeRational(parcel), makeRational(perShare, input.refPriceMicro));
  }
  const total = addRat(makeRational(parcel + fee), slip);
  const net = subRat(makeRational(1n), buffer);
  return roundHalfAwayFromZero(mulRat(total, makeRational(net.den, net.num)));
}
