// Leverage sleeve engine (spec 05 ARN-003, ARN-040..048, ARN-101; M3 design 2.2 R4/R5, 4.2 steps
// 3/5/6, 4.5; D-069 decisions 5, 7, 8, 19; D-071 rulings on TST101-036/037/043; T8 proposals
// D-075). HIGH-RISK money module: bigint micro-AUD and exact rationals, no floats, no division
// operator, one half-away-from-zero rounding per quantity. Pure functions; sleeveWriter.ts is the
// DB side.
//
// MODEL
//   margin   = min(A$20, 4 % of NAV)            (ARN-040), moved out of settled cash into the
//   notional = margin x leverage                 sleeve_margin balance (ARN-041); no compounding
//   price P/L = round(notional x (price/f - entry) / entry), f = split-neutral price factor since
//               the entry (ARN-043 s11): raw prices only, the factor re-bases the entry
//   financing = round(notional x rate x days / basis), CUMULATIVE from the open date, days = calendar
//               days since the open (D-069 decision 8); a day's charge = accrued(d) - accrued(d-1)
//   close-out = price P/L + accrued financing <= -closeout x margin (default 50 %): an IS exit at a
//               price LEVEL rounded down to a whole micro (ARN-044)
//   loss cap  = price P/L + financing >= -margin; brokerage (on notional, both sides) is charged in
//               addition, and slippage sits inside the fill prices (D-071 TST101-036)
//   cash back = margin + capped price P/L - financing - exit brokerage. When that is negative (the
//               margin is gone) the shortfall is drawn from main settled cash (D-071 TST101-037 [VERIFY])
//   lock      = a trade whose net result (capped price P/L - financing - brokerage) is negative locks
//               the sleeve and records loss_to_recover = that net loss (D-069 decision 5)
//   unlock    = REC-1..REC-4 (ARN-047), judged at a close
//   shadow    = while locked, hypothetical trades are logged with the same arithmetic and no cash
//               effect (ARN-048); REC-3 reads them
import { type Micro } from "@/lib/money/micro";
import {
  cmpRat,
  divFloor,
  divRat,
  makeRational,
  mulRat,
  subRat,
  type Rational,
} from "@/lib/money/rational";
import { floorRat, roundHalfAwayFromZero } from "@/lib/money/round";
import { sessionsBetween, addDays, type CalendarRow } from "@/lib/data/calendar";
import { COST_PROFILES, feeFor, type CostProfile, type FeeContext } from "./costs";
import {
  fillCloseSignalExit,
  fillEntryAtOpen,
  fillIntradayStop,
  type FillEnv,
  type SimulatedFill,
} from "./fills";
import {
  assertTradingDate,
  type LedgerRow,
  type LedgerTxn,
  type Posting,
  type QtyAdjustment,
} from "./ledger";
import type { RecoveryMode, SleeveClosedBy, SleeveLockState, Tier } from "./schema";
import { sizeEntry, type SizingInput, type SizingResult } from "./sizing";

// ---- configuration -----------------------------------------------------------------------------

/** ARN-040 / ch.15 `sleeve_margin`: min(A$20, 4 % of NAV). */
export const SLEEVE_MARGIN_CAP_MICRO: Micro = 20_000_000n;
export const SLEEVE_MARGIN_NAV_FRACTION: Rational = makeRational(4n, 100n);
/** ARN-040 / ch.15 `sleeve_leverage`: 10x (hypothetical). */
export const SLEEVE_LEVERAGE_DEFAULT = 10n;
/** ARN-044 / ch.15 `sleeve_closeout_pct`: 50 % of the margin (bounds 30 % to 100 %). */
export const SLEEVE_CLOSEOUT_FRACTION: Rational = makeRational(1n, 2n);
/** ARN-045 / ch.15 `sleeve_financing_rate`: 9 % p.a. [VERIFY]; divisor 365 (13_review FIX-042). */
export const SLEEVE_FINANCING_RATE: Rational = makeRational(9n, 100n);
export const SLEEVE_FINANCING_BASIS = 365n;
/** ARN-047 REC-4: unlock after 10 sessions. */
export const SLEEVE_REC4_SESSIONS = 10;
export const SLEEVE_RATES_VERIFIED = false;

export type SleeveConfig = {
  readonly leverage: bigint;
  readonly marginCapMicro: Micro;
  readonly marginNavFraction: Rational;
  readonly closeoutFraction: Rational;
  readonly financingRate: Rational;
  readonly financingBasis: bigint;
  readonly recoveryMode: RecoveryMode;
  readonly rec4Sessions: number;
  /** `sleeve_cost_profile`: the execution's profile by default (ARN-045). */
  readonly profile: CostProfile;
  readonly feeContext?: FeeContext;
};

export function defaultSleeveConfig(profile: CostProfile = COST_PROFILES.P5): SleeveConfig {
  return {
    leverage: SLEEVE_LEVERAGE_DEFAULT,
    marginCapMicro: SLEEVE_MARGIN_CAP_MICRO,
    marginNavFraction: SLEEVE_MARGIN_NAV_FRACTION,
    closeoutFraction: SLEEVE_CLOSEOUT_FRACTION,
    financingRate: SLEEVE_FINANCING_RATE,
    financingBasis: SLEEVE_FINANCING_BASIS,
    recoveryMode: "REC-2",
    rec4Sessions: SLEEVE_REC4_SESSIONS,
    profile,
  };
}

export function assertSleeveConfig(cfg: SleeveConfig): void {
  if (cfg.leverage < 1n) throw new RangeError("sleeve leverage must be at least 1");
  if (cfg.marginCapMicro <= 0n) throw new RangeError("sleeve margin cap must be positive");
  const one = makeRational(1n);
  if (
    cmpRat(cfg.closeoutFraction, makeRational(0n)) <= 0 ||
    cmpRat(cfg.closeoutFraction, one) > 0
  ) {
    throw new RangeError("sleeve close-out fraction must be in (0, 1]");
  }
  if (cmpRat(cfg.marginNavFraction, makeRational(0n)) <= 0) {
    throw new RangeError("sleeve margin fraction must be positive");
  }
  if (cfg.financingRate.num < 0n) throw new RangeError("financing rate cannot be negative");
  if (cfg.financingBasis < 1n) throw new RangeError("financing day-count basis must be positive");
}

/** ARN-040: margin = min(cap, fraction x NAV), the fraction rounded once; 0 when NAV is not positive. */
export function sleeveMarginMicro(navMicro: Micro, cfg: SleeveConfig): Micro {
  if (navMicro <= 0n) return 0n;
  const share = roundHalfAwayFromZero(mulRat(makeRational(navMicro), cfg.marginNavFraction));
  return share < cfg.marginCapMicro ? share : cfg.marginCapMicro;
}

export function sleeveNotionalMicro(marginMicro: Micro, cfg: SleeveConfig): Micro {
  if (marginMicro <= 0n) throw new RangeError("sleeve margin must be positive");
  return marginMicro * cfg.leverage;
}

// ---- eligibility (ARN-042) -----------------------------------------------------------------------

export type SleeveSkipReason = "u3" | "u2_not_allowed" | "not_eligible" | "locked" | "open_sleeve";

/** ARN-042: U1 or an index ETF (E10: U2 as well); never U3. Ineligible days are logged. */
export function sleeveEligibility(input: {
  readonly tier: Tier;
  readonly indexEtf?: boolean;
  readonly allowU2?: boolean;
}): { readonly eligible: boolean; readonly reason: SleeveSkipReason | null } {
  if (input.indexEtf === true) return { eligible: true, reason: null };
  if (input.tier === "U1") return { eligible: true, reason: null };
  if (input.tier === "U3") return { eligible: false, reason: "u3" };
  return input.allowU2 === true
    ? { eligible: true, reason: null }
    : { eligible: false, reason: "u2_not_allowed" };
}

// ---- trades --------------------------------------------------------------------------------------

/** One sleeve trade, open or closed (the `sleeve_trade` row in engine terms). */
export type SleeveTrade = {
  readonly id: string;
  readonly cohortId: string;
  readonly code: string;
  readonly shadow: boolean;
  readonly marginMicro: Micro;
  readonly leverage: bigint;
  readonly notionalMicro: Micro;
  readonly openD: string;
  /** The sleeve's own entry fill price (raw), slippage inside. */
  readonly entryPriceMicro: Micro;
  readonly entryFillId: string | null;
  readonly closed: SleeveClosed | null;
};

export type SleeveClosed = {
  readonly closeD: string;
  readonly exitPriceMicro: Micro;
  readonly closedBy: SleeveClosedBy;
  readonly exitFillId: string | null;
  /** Price P/L after the loss cap (price P/L + financing >= -margin). */
  readonly pricePlMicro: Micro;
  readonly financingMicro: Micro;
  /** Brokerage of both sides. */
  readonly costsMicro: Micro;
};

export function isOpen(trade: SleeveTrade): boolean {
  return trade.closed === null;
}

/** Net result of a closed trade: capped price P/L - financing - brokerage (negative = a loss). */
export function netPlMicro(closed: SleeveClosed): Micro {
  return closed.pricePlMicro - closed.financingMicro - closed.costsMicro;
}

// ---- dates and financing -------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000n;

function epochDay(d: string): bigint {
  assertTradingDate(d);
  return divFloor(BigInt(new Date(`${d}T00:00:00Z`).getTime()), MS_PER_DAY);
}

/** Calendar days from `fromD` to `toD` (0 on the same date). Refuses a negative span. */
export function daysBetween(fromD: string, toD: string): bigint {
  const days = epochDay(toD) - epochDay(fromD);
  if (days < 0n) throw new RangeError(`${toD} is before ${fromD}`);
  return days;
}

/** Cumulative financing after `days` calendar days: round(notional x rate x days / basis), once. */
export function financingAfterDays(notionalMicro: Micro, days: bigint, cfg: SleeveConfig): Micro {
  if (days < 0n) throw new RangeError("days cannot be negative");
  const exact = mulRat(
    mulRat(makeRational(notionalMicro), cfg.financingRate),
    makeRational(days, cfg.financingBasis),
  );
  return roundHalfAwayFromZero(exact);
}

/** Accrued financing of a trade at the end of `d` (exposure = notional, every calendar day). */
export function financingAccruedAt(trade: SleeveTrade, d: string, cfg: SleeveConfig): Micro {
  return financingAfterDays(trade.notionalMicro, daysBetween(trade.openD, d), cfg);
}

// ---- price P/L, cap, close-out level -------------------------------------------------------------

/**
 * Price factor since the entry (ARN-043 s11, DAT-220): the product of 1/ratio over the code's
 * quantity re-bases with entryD < ex-date <= toD. A 2-for-1 split gives 1/2 (post-event raw
 * prices are about half the pre-event ones). 1 when nothing happened.
 */
export function priceFactorSince(
  code: string,
  entryD: string,
  toD: string,
  adjustments: readonly QtyAdjustment[],
): Rational {
  let factor = makeRational(1n);
  for (const a of adjustments) {
    if (a.code !== code || a.exD <= entryD || a.exD > toD) continue;
    if (a.ratio.num <= 0n) throw new RangeError("a re-base ratio must be positive for a sleeve");
    factor = mulRat(factor, makeRational(a.ratio.den, a.ratio.num));
  }
  return factor;
}

/**
 * Price P/L of the sleeve at a raw `priceMicro`: notional x (price/f - entry) / entry, rounded
 * once half-away. `factor` is the split-neutral price factor since the entry (default 1).
 */
export function sleevePricePlMicro(input: {
  readonly notionalMicro: Micro;
  readonly entryPriceMicro: Micro;
  readonly priceMicro: Micro;
  readonly factor?: Rational;
}): Micro {
  if (input.entryPriceMicro <= 0n || input.priceMicro <= 0n) {
    throw new RangeError("sleeve prices must be positive");
  }
  const f = input.factor ?? makeRational(1n);
  const entryInPostTerms = mulRat(makeRational(input.entryPriceMicro), f);
  const move = divRat(subRat(makeRational(input.priceMicro), entryInPostTerms), entryInPostTerms);
  return roundHalfAwayFromZero(mulRat(makeRational(input.notionalMicro), move));
}

export type CappedLoss = {
  /** Price P/L after the cap. */
  readonly pricePlMicro: Micro;
  readonly capped: boolean;
};

/** ARN-044: price P/L + financing cannot lose more than the margin (financing itself stays charged). */
export function capSleeveLoss(
  rawPricePlMicro: Micro,
  financingMicro: Micro,
  marginMicro: Micro,
): CappedLoss {
  if (rawPricePlMicro - financingMicro >= -marginMicro) {
    return { pricePlMicro: rawPricePlMicro, capped: false };
  }
  return { pricePlMicro: financingMicro - marginMicro, capped: true };
}

/** Sleeve unrealised price P/L at a close (NAV, ARN-051): the capped price P/L, 0 for no trade. */
export function sleeveUnrealisedMicro(input: {
  readonly trade: SleeveTrade;
  readonly closeMicro: Micro;
  readonly factor?: Rational;
  readonly financingMicro: Micro;
}): Micro {
  const t = input.trade;
  const raw = sleevePricePlMicro({
    notionalMicro: t.notionalMicro,
    entryPriceMicro: t.entryPriceMicro,
    priceMicro: input.closeMicro,
    factor: input.factor,
  });
  return capSleeveLoss(raw, input.financingMicro, t.marginMicro).pricePlMicro;
}

/**
 * The raw price at which price P/L + accrued financing reaches -closeout x margin (ARN-044):
 * p* = f x entry x (notional + financing - closeout x margin) / notional, rounded DOWN to a whole
 * micro, so `price <= level` is exactly "the loss has reached the threshold" for integer prices.
 * Null when the level is not above zero (a threshold the price can never reach).
 */
export function closeoutLevelMicro(input: {
  readonly trade: SleeveTrade;
  readonly financingMicro: Micro;
  readonly factor?: Rational;
  readonly cfg: SleeveConfig;
}): Micro | null {
  const t = input.trade;
  const threshold = mulRat(input.cfg.closeoutFraction, makeRational(t.marginMicro));
  const inner = subRat(makeRational(t.notionalMicro + input.financingMicro), threshold);
  const ratio = divRat(inner, makeRational(t.notionalMicro));
  const level = floorRat(
    mulRat(mulRat(input.factor ?? makeRational(1n), makeRational(t.entryPriceMicro)), ratio),
  );
  return level > 0n ? level : null;
}

// ---- fills ---------------------------------------------------------------------------------------

/** Notional shares shown on the fill row: floor(notional / price), at least 1 (display only). */
function notionalShares(notionalMicro: Micro, priceMicro: Micro): bigint {
  const n = divFloor(notionalMicro, priceMicro);
  return n < 1n ? 1n : n;
}

/** Re-shape a one-share simulated fill into the sleeve's: brokerage on NOTIONAL (ARN-045). */
function sleeveFill(
  one: SimulatedFill,
  notionalMicro: Micro,
  qty: bigint,
  cfg: SleeveConfig,
): SimulatedFill {
  return {
    ...one,
    qty,
    valueMicro: qty * one.fillPriceMicro,
    brokerageMicro: feeFor(cfg.profile, notionalMicro, one.side, cfg.feeContext),
    costProfile: cfg.profile.code,
  };
}

export type SleeveEntryQuote = {
  readonly fill: SimulatedFill;
  readonly marginMicro: Micro;
  readonly notionalMicro: Micro;
  readonly entryPriceMicro: Micro;
  readonly entryBrokerageMicro: Micro;
};

/** The sleeve's entry at the session open (buy, slippage adverse on the tick grid). */
export function quoteSleeveEntry(
  env: FillEnv,
  marginMicro: Micro,
  cfg: SleeveConfig,
): SleeveEntryQuote {
  assertSleeveConfig(cfg);
  const notional = sleeveNotionalMicro(marginMicro, cfg);
  const one = fillEntryAtOpen(env, 1n);
  const fill = sleeveFill(one, notional, notionalShares(notional, one.fillPriceMicro), cfg);
  return {
    fill,
    marginMicro,
    notionalMicro: notional,
    entryPriceMicro: one.fillPriceMicro,
    entryBrokerageMicro: fill.brokerageMicro,
  };
}

/** Build the open trade record of a quote. */
export function openTrade(input: {
  readonly id: string;
  readonly cohortId: string;
  readonly code: string;
  readonly openD: string;
  readonly quote: SleeveEntryQuote;
  readonly entryFillId: string | null;
  readonly shadow?: boolean;
  readonly cfg: SleeveConfig;
}): SleeveTrade {
  assertTradingDate(input.openD);
  return {
    id: input.id,
    cohortId: input.cohortId,
    code: input.code,
    shadow: input.shadow === true,
    marginMicro: input.quote.marginMicro,
    leverage: input.cfg.leverage,
    notionalMicro: input.quote.notionalMicro,
    openD: input.openD,
    entryPriceMicro: input.quote.entryPriceMicro,
    entryFillId: input.shadow === true ? null : input.entryFillId,
    closed: null,
  };
}

export type SleeveExitMode =
  /** The family's CS exit: sell at the open. */
  | { readonly kind: "cs" }
  /** The family's IS exit at the stock's stop level. */
  | { readonly kind: "is"; readonly levelMicro: Micro; readonly afterOpen?: boolean }
  /** The 50 % close-out (ARN-044): an IS exit at the close-out level. */
  | {
      readonly kind: "closeout";
      readonly financingMicro: Micro;
      readonly factor?: Rational;
      readonly afterOpen?: boolean;
    };

export type SleeveExitQuote = { readonly fill: SimulatedFill; readonly closedBy: SleeveClosedBy };

/**
 * The sleeve's exit fill for one session bar, or null when a stop/close-out is not reached. The
 * fill rules are the stock rules (fills.ts); only the brokerage differs (on notional).
 */
export function quoteSleeveExit(
  env: FillEnv,
  trade: SleeveTrade,
  mode: SleeveExitMode,
  cfg: SleeveConfig,
): SleeveExitQuote | null {
  const qty = notionalShares(trade.notionalMicro, trade.entryPriceMicro);
  let one: SimulatedFill | null;
  let closedBy: SleeveClosedBy = "exit";
  if (mode.kind === "cs") {
    one = fillCloseSignalExit(env, 1n);
  } else if (mode.kind === "is") {
    one = fillIntradayStop(env, 1n, mode.levelMicro, { afterOpen: mode.afterOpen });
  } else {
    const level = closeoutLevelMicro({
      trade,
      financingMicro: mode.financingMicro,
      factor: mode.factor,
      cfg,
    });
    one = level === null ? null : fillIntradayStop(env, 1n, level, { afterOpen: mode.afterOpen });
    closedBy = "closeout";
  }
  return one === null ? null : { fill: sleeveFill(one, trade.notionalMicro, qty, cfg), closedBy };
}

function isAtOpen(f: SimulatedFill): boolean {
  return f.rule !== "level";
}

/**
 * Which of two exits fills first (ARN-021 ordering, D-072): an exit at the open precedes an
 * intraday level; two exits at the open are ambiguous so the worse (lower) price is taken; two
 * intraday levels: the higher level is hit first on a falling price. A tie keeps `a`.
 */
export function earlierSleeveExit(a: SleeveExitQuote, b: SleeveExitQuote): SleeveExitQuote {
  const ao = isAtOpen(a.fill);
  const bo = isAtOpen(b.fill);
  if (ao && !bo) return a;
  if (bo && !ao) return b;
  if (ao && bo) return b.fill.fillPriceMicro < a.fill.fillPriceMicro ? b : a;
  if (a.fill.refPriceMicro !== b.fill.refPriceMicro) {
    return a.fill.refPriceMicro > b.fill.refPriceMicro ? a : b;
  }
  return b.fill.fillPriceMicro < a.fill.fillPriceMicro ? b : a;
}

// ---- close ---------------------------------------------------------------------------------------

export type SleeveCloseResult = {
  readonly closed: SleeveClosed;
  /** Price P/L at the exit fill before the cap. */
  readonly rawPricePlMicro: Micro;
  readonly capped: boolean;
  readonly entryBrokerageMicro: Micro;
  readonly exitBrokerageMicro: Micro;
  /** margin + capped price P/L - financing: what the margin turns into, never negative. */
  readonly marginReturnedMicro: Micro;
  /** Change of settled cash at the close: margin returned - exit brokerage (may be negative). */
  readonly cashDeltaMicro: Micro;
  /** Settled cash drawn beyond the margin for exit brokerage (D-071 ruling, [VERIFY]); else 0. */
  readonly cashShortfallMicro: Micro;
  /** Capped price P/L - financing - brokerage; negative = the loss that locks the sleeve. */
  readonly netPlMicro: Micro;
};

/**
 * Close a sleeve trade at an exit fill (ARN-043/044/045). `financingMicro` is the cumulative
 * accrued financing at the close date (financingAccruedAt). Pure: the same arithmetic serves real
 * and shadow trades.
 */
export function closeSleeve(input: {
  readonly trade: SleeveTrade;
  readonly entryBrokerageMicro: Micro;
  readonly closeD: string;
  readonly exitPriceMicro: Micro;
  readonly exitBrokerageMicro: Micro;
  readonly closedBy: SleeveClosedBy;
  readonly exitFillId: string | null;
  readonly financingMicro: Micro;
  readonly factor?: Rational;
}): SleeveCloseResult {
  const t = input.trade;
  if (t.closed !== null) throw new RangeError(`sleeve trade ${t.id} is already closed`);
  assertTradingDate(input.closeD);
  if (input.closeD < t.openD) throw new RangeError("a sleeve cannot close before it opens");
  if (input.financingMicro < 0n) throw new RangeError("financing cannot be negative");
  if (input.entryBrokerageMicro < 0n || input.exitBrokerageMicro < 0n) {
    throw new RangeError("brokerage cannot be negative");
  }
  const raw = sleevePricePlMicro({
    notionalMicro: t.notionalMicro,
    entryPriceMicro: t.entryPriceMicro,
    priceMicro: input.exitPriceMicro,
    factor: input.factor,
  });
  const cap = capSleeveLoss(raw, input.financingMicro, t.marginMicro);
  const costs = input.entryBrokerageMicro + input.exitBrokerageMicro;
  const closed: SleeveClosed = {
    closeD: input.closeD,
    exitPriceMicro: input.exitPriceMicro,
    closedBy: input.closedBy,
    exitFillId: t.shadow ? null : input.exitFillId,
    pricePlMicro: cap.pricePlMicro,
    financingMicro: input.financingMicro,
    costsMicro: costs,
  };
  const marginReturned = t.marginMicro + cap.pricePlMicro - input.financingMicro;
  const cashDelta = marginReturned - input.exitBrokerageMicro;
  return {
    closed,
    rawPricePlMicro: raw,
    capped: cap.capped,
    entryBrokerageMicro: input.entryBrokerageMicro,
    exitBrokerageMicro: input.exitBrokerageMicro,
    marginReturnedMicro: marginReturned,
    cashDeltaMicro: cashDelta,
    cashShortfallMicro: cashDelta < 0n ? -cashDelta : 0n,
    netPlMicro: netPlMicro(closed),
  };
}

/** The trade record after a close. */
export function closedTrade(trade: SleeveTrade, result: SleeveCloseResult): SleeveTrade {
  return { ...trade, closed: result.closed };
}

// ---- ledger postings (real trades only; a shadow trade posts nothing) ------------------------------

function sleeveTxn(
  txnId: string,
  d: string,
  kind: LedgerTxn["kind"],
  tradeId: string,
  postings: readonly Posting[],
): LedgerTxn {
  const kept = postings.filter((p) => p.deltaMicro !== 0n);
  return { txnId, d, kind, refType: "sleeve_trade", refId: tradeId, postings: kept };
}

function realOnly(trade: SleeveTrade): void {
  if (trade.shadow) throw new RangeError(`shadow sleeve trade ${trade.id} has no ledger effect`);
}

/**
 * Open (ARN-041): the margin moves out of settled cash into sleeve_margin; the entry brokerage
 * is paid from settled cash on top (a cost, so NAV falls by it only).
 */
export function sleeveOpenTxn(trade: SleeveTrade, entryBrokerageMicro: Micro): LedgerTxn {
  realOnly(trade);
  return sleeveTxn(`sleeveopen:${trade.id}`, trade.openD, "sleeve_open", trade.id, [
    { account: "cash_settled", deltaMicro: -(trade.marginMicro + entryBrokerageMicro) },
    { account: "sleeve_margin", deltaMicro: trade.marginMicro },
    { account: "fees_paid", deltaMicro: entryBrokerageMicro },
  ]);
}

/** One day's financing charge: a liability to be paid at the close, an expense now. */
export function sleeveFinancingTxn(trade: SleeveTrade, d: string, amountMicro: Micro): LedgerTxn {
  realOnly(trade);
  if (amountMicro <= 0n) throw new RangeError("a financing charge must be positive");
  return sleeveTxn(`sleevefin:${trade.id}:${d}`, d, "financing", trade.id, [
    { account: "fin_accrued", deltaMicro: -amountMicro },
    { account: "equity", deltaMicro: amountMicro },
  ]);
}

/**
 * Close: the margin is released, the accrued financing is paid out of it, the realised (capped)
 * price P/L goes to equity, and the remainder less the exit brokerage lands in settled cash (which
 * is drawn instead when the margin is gone, D-071 ruling on TST101-037).
 */
export function sleeveCloseTxn(trade: SleeveTrade, result: SleeveCloseResult): LedgerTxn {
  realOnly(trade);
  return sleeveTxn(`sleeveclose:${trade.id}`, result.closed.closeD, "sleeve_close", trade.id, [
    { account: "sleeve_margin", deltaMicro: -trade.marginMicro },
    { account: "fin_accrued", deltaMicro: result.closed.financingMicro },
    { account: "equity", deltaMicro: -result.closed.pricePlMicro },
    { account: "cash_settled", deltaMicro: result.cashDeltaMicro },
    { account: "fees_paid", deltaMicro: result.exitBrokerageMicro },
  ]);
}

// ---- ARN-003: both fit, or the sleeve is skipped -----------------------------------------------------

export type SleeveEntryPlan =
  | {
      readonly kind: "stock_and_sleeve";
      readonly sizing: SizingResult;
      readonly marginMicro: Micro;
      readonly notionalMicro: Micro;
      readonly estEntryBrokerageMicro: Micro;
    }
  | {
      /** The stock entry goes ahead; the sleeve is skipped or only logged in shadow. */
      readonly kind: "stock_only";
      readonly sizing: SizingResult;
      readonly sleeve: "skipped" | "shadow";
      readonly reason: SleeveSkipReason | "unfunded" | "no_margin";
      readonly shadowMarginMicro: Micro;
    }
  | { readonly kind: "none"; readonly sizing: SizingResult };

export type SleevePlanInput = {
  readonly sizing: Omit<SizingInput, "sleeveMarginMicro">;
  readonly cfg: SleeveConfig;
  readonly locked: boolean;
  readonly hasOpenSleeve: boolean;
  /**
   * Settled cash in the ledger. The margin and its entry brokerage leave SETTLED cash at once (no
   * T+2 for a margined derivative), so when given they must fit in it, else the sleeve is skipped.
   */
  readonly settledCashMicro?: Micro;
  readonly eligibility: { readonly eligible: boolean; readonly reason: SleeveSkipReason | null };
};

/**
 * ARN-003 / ARN-024a: size the stock entry with the sleeve margin (and the sleeve's entry
 * brokerage) reserved. Both fit -> open both. They do not both fit -> the SLEEVE is skipped, never
 * the stock entry. A locked sleeve (ARN-048) or an ineligible code never reserves cash: a locked
 * sleeve logs a shadow trade instead.
 */
export function planSleeveEntry(input: SleevePlanInput): SleeveEntryPlan {
  const { cfg } = input;
  const nav = input.sizing.navMicro;
  const margin = sleeveMarginMicro(nav, cfg);
  const without = (): SizingResult => sizeEntry({ ...input.sizing, sleeveMarginMicro: 0n });
  const stockOnly = (
    sizing: SizingResult,
    sleeve: "skipped" | "shadow",
    reason: SleeveSkipReason | "unfunded" | "no_margin",
  ): SleeveEntryPlan => {
    if (!sizing.accepted) return { kind: "none", sizing };
    return { kind: "stock_only", sizing, sleeve, reason, shadowMarginMicro: margin };
  };
  if (!input.eligibility.eligible) {
    return stockOnly(without(), "skipped", input.eligibility.reason ?? "not_eligible");
  }
  if (input.hasOpenSleeve) return stockOnly(without(), "skipped", "open_sleeve");
  if (margin <= 0n) return stockOnly(without(), "skipped", "no_margin");
  if (input.locked) {
    return stockOnly(without(), "shadow", "locked");
  }
  const notional = sleeveNotionalMicro(margin, cfg);
  const estFee = feeFor(cfg.profile, notional, "buy", cfg.feeContext);
  const withSleeve = sizeEntry({ ...input.sizing, sleeveMarginMicro: margin + estFee });
  const settledFits =
    input.settledCashMicro === undefined || input.settledCashMicro >= margin + estFee;
  if (withSleeve.accepted && settledFits) {
    return {
      kind: "stock_and_sleeve",
      sizing: withSleeve,
      marginMicro: margin,
      notionalMicro: notional,
      estEntryBrokerageMicro: estFee,
    };
  }
  return stockOnly(without(), "skipped", "unfunded");
}

// ---- lock and recovery (ARN-046, ARN-047) ---------------------------------------------------------------

/** One `sleeve_state` row (append-only; seq starts at 1; no rows = unlocked). */
export type SleeveStateEntry = {
  readonly seq: number;
  readonly state: SleeveLockState;
  readonly d: string;
  readonly lossToRecoverMicro: Micro;
  readonly mode: RecoveryMode;
};

export type LockStatus = {
  readonly locked: boolean;
  readonly lockD: string | null;
  readonly lossToRecoverMicro: Micro;
  readonly mode: RecoveryMode | null;
};

export function lockStatus(history: readonly SleeveStateEntry[]): LockStatus {
  const last = history.length === 0 ? undefined : history[history.length - 1];
  if (last === undefined || last.state === "unlocked") {
    return { locked: false, lockD: null, lossToRecoverMicro: 0n, mode: null };
  }
  return {
    locked: true,
    lockD: last.d,
    lossToRecoverMicro: last.lossToRecoverMicro,
    mode: last.mode,
  };
}

/**
 * ARN-046: a REAL trade closing with a negative net result locks the sleeve and records
 * loss_to_recover = the total net loss (D-069 decision 5). Null when it does not lose, or the
 * sleeve was already locked (a locked sleeve opens no real trade; defensive), or for a shadow trade.
 */
export function lockAfterClose(
  history: readonly SleeveStateEntry[],
  trade: SleeveTrade,
  cfg: SleeveConfig,
): SleeveStateEntry | null {
  if (trade.shadow || trade.closed === null) return null;
  if (lockStatus(history).locked) return null;
  const net = netPlMicro(trade.closed);
  if (net >= 0n) return null;
  return {
    seq: history.length + 1,
    state: "locked",
    d: trade.closed.closeD,
    lossToRecoverMicro: -net,
    mode: cfg.recoveryMode,
  };
}

/** Everything an unlock test may need; each mode reads only its own fields. */
export type UnlockContext = {
  /** The close being judged. */
  readonly d: string;
  /** REC-1: NAV at this close and NAV at the close before the losing trade opened. */
  readonly navMicro?: Micro;
  readonly refNavMicro?: Micro;
  /** REC-2: unlevered realised net P/L since the lock (realisedUnleveredNetSince). */
  readonly realisedUnleveredNetMicro?: Micro;
  /** REC-3: shadow sleeve net P/L since the lock (shadowNetSince). */
  readonly shadowNetMicro?: Micro;
  /** REC-4: sessions after the lock date up to and including `d`. */
  readonly sessionsSinceLock?: number;
};

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new RangeError(`${what} is required for this recovery mode`);
  return value;
}

/** True when the lock's recovery mode is satisfied at this close (ARN-047). */
export function recoverySatisfied(
  status: LockStatus,
  ctx: UnlockContext,
  cfg: SleeveConfig,
): boolean {
  if (!status.locked || status.mode === null) return false;
  switch (status.mode) {
    case "REC-1":
      return required(ctx.navMicro, "NAV") >= required(ctx.refNavMicro, "reference NAV");
    case "REC-2":
      return (
        required(ctx.realisedUnleveredNetMicro, "realised unlevered net P/L") >=
        status.lossToRecoverMicro
      );
    case "REC-3":
      return required(ctx.shadowNetMicro, "shadow net P/L") >= status.lossToRecoverMicro;
    case "REC-4":
      return required(ctx.sessionsSinceLock, "sessions since lock") >= cfg.rec4Sessions;
  }
}

/** The unlock row if the recovery condition holds at this close; null otherwise. */
export function evaluateUnlock(
  history: readonly SleeveStateEntry[],
  ctx: UnlockContext,
  cfg: SleeveConfig,
): SleeveStateEntry | null {
  const status = lockStatus(history);
  if (!status.locked || status.lockD === null || status.mode === null) return null;
  if (ctx.d <= status.lockD) return null; // the lock day itself never unlocks
  if (!recoverySatisfied(status, ctx, cfg)) return null;
  return {
    seq: history.length + 1,
    state: "unlocked",
    d: ctx.d,
    lossToRecoverMicro: 0n,
    mode: status.mode,
  };
}

/** REC-4: sessions strictly after the lock date, up to and including `d`. */
export function sessionsSinceLock(
  lockD: string,
  d: string,
  calendar: readonly CalendarRow[],
): number {
  if (d <= lockD) return 0;
  return sessionsBetween(addDays(lockD, 1), d, calendar).length;
}

/**
 * REC-2: unlevered realised net P/L of the STOCK book on days after the lock date up to `upToD`,
 * cash basis from the ledger: realised sale P/L (value - average cost) less every stock brokerage
 * paid. Sleeve txns, dividends and corporate actions are not trading P/L and are excluded.
 */
export function realisedUnleveredNetSince(
  rows: readonly LedgerRow[],
  lockD: string,
  upToD: string,
): Micro {
  let total = 0n;
  for (const r of rows) {
    if (r.d <= lockD || r.d > upToD) continue;
    if (r.kind === "sell" && r.account === "equity") total -= r.deltaMicro;
    else if (r.kind === "brokerage" && r.account === "fees_paid") total -= r.deltaMicro;
  }
  return total;
}

/** REC-3: net P/L (capped price P/L - financing - brokerage) of shadow trades closed after the lock. */
export function shadowNetSince(
  trades: readonly SleeveTrade[],
  lockD: string,
  upToD: string,
): Micro {
  let total = 0n;
  for (const t of trades) {
    if (!t.shadow || t.closed === null) continue;
    if (t.closed.closeD <= lockD || t.closed.closeD > upToD) continue;
    total += netPlMicro(t.closed);
  }
  return total;
}

// ---- helpers for NAV and the nightly loop -----------------------------------------------------------

/** The real (non-shadow) trade that is open at the close of `d` (opened on or before, not closed before). */
export function openRealTradeAt(trades: readonly SleeveTrade[], d: string): SleeveTrade | null {
  const open = trades.filter(
    (t) => !t.shadow && t.openD <= d && (t.closed === null || t.closed.closeD > d),
  );
  if (open.length > 1) throw new RangeError(`more than one sleeve trade open on ${d}`);
  return open.length === 0 ? null : open[0];
}

/** Sleeve unrealised P/L for the NAV row of `d` (0 with no open real trade). */
export function sleeveUnrealAt(input: {
  readonly trades: readonly SleeveTrade[];
  readonly d: string;
  readonly closeFor: (code: string, d: string) => Micro | undefined;
  readonly adjustments?: readonly QtyAdjustment[];
  readonly cfg: SleeveConfig;
}): Micro {
  const trade = openRealTradeAt(input.trades, input.d);
  if (trade === null) return 0n;
  const close = input.closeFor(trade.code, input.d);
  if (close === undefined) throw new RangeError(`no close for ${trade.code} on ${input.d}`);
  return sleeveUnrealisedMicro({
    trade,
    closeMicro: close,
    factor: priceFactorSince(trade.code, trade.openD, input.d, input.adjustments ?? []),
    financingMicro: financingAccruedAt(trade, input.d, input.cfg),
  });
}

/**
 * Cost of closing an open sleeve now, for LIQUIDATION NAV (ARN-052, ARN-053): the exit brokerage
 * on notional (slippage on the closing fill is not estimated separately beyond the stock's).
 */
export function sleeveLiquidationCostMicro(trade: SleeveTrade | null, cfg: SleeveConfig): Micro {
  if (trade === null) return 0n;
  return feeFor(cfg.profile, trade.notionalMicro, "sell", cfg.feeContext);
}

/** Exact trigger move as a rational, for display and tests: -closeout x margin / notional. */
export function closeoutMove(trade: SleeveTrade, cfg: SleeveConfig): Rational {
  return divRat(
    mulRat(makeRational(-1n), mulRat(cfg.closeoutFraction, makeRational(trade.marginMicro))),
    makeRational(trade.notionalMicro),
  );
}

/** Break-even move (ARN-045): both brokerages over notional, as an exact rational (financing aside). */
export function breakEvenMove(trade: SleeveTrade, cfg: SleeveConfig): Rational {
  const fees =
    feeFor(cfg.profile, trade.notionalMicro, "buy", cfg.feeContext) +
    feeFor(cfg.profile, trade.notionalMicro, "sell", cfg.feeContext);
  return divRat(makeRational(fees), makeRational(trade.notionalMicro));
}
