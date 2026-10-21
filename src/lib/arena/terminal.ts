// Terminal states of a cohort (spec 05 section 5.1, ARN-026, ARN-052, ARN-053; M3 design 4.2 step 6
// and 4.5; D-069; T9 proposals D-076). HIGH-RISK: pure functions over bigint micro-AUD and exact
// rationals, no floats, no clock reads. cohortWriter.ts is the DB side.
//
//   Every test uses LIQUIDATION NAV (NAV less the estimated cost of selling everything, ARN-052);
//   plain NAV is carried for the record only.
//     Target   liquidation NAV >= target_multiple x seed (A$1,200)
//     Bust     liquidation NAV <= bust_fraction x seed   (A$300)
//     Stalled  no open position on any day of the test, and either
//                (a) liquidation NAV < stall_floor on `stall_sessions` consecutive sessions, or
//                (b) over the last `stall_parcel_rejections` sessions with known signals there was
//                    at least one family signal and EVERY signal was rejected only for parcel /
//                    whole-share reasons
//     Timeout  `timeout_sessions` sessions (the start session is session 1)
//   Precedence on one close: target, bust, stalled (a before b), timeout. A terminal state is
//   decided once, at a close (the writer refuses a second one).
//
// Stall (b) and the order of the nightly batch: ARN-060 closes the books (terminal check) BEFORE
// the day's signals exist, so on the close of D the signals of D are not known yet. A day whose
// `signals` is null is therefore left out of window (b); the window is the last M days with
// known signals. A stall (a) day needs only the NAV, so it is always known.
//
// TTD / ttd_days: sessions (inclusive of the start session) and calendar days from the cohort
// start to the terminal close. outcome_micro = liquidation NAV at that close, fixed for good; the
// realised value after the actual next-open liquidation is stored separately ('liquidated' event).
import { nextTradingDay, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { type Micro } from "@/lib/money/micro";
import { cmpRat, makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { positionValueMicro, type Mark } from "./nav";
import type { TerminalKind } from "./schema";
import { daysBetween } from "./sleeve";

// ---- parameters ----------------------------------------------------------------------------------------

/** PRD-003 / section 5.1: the target is 2x the seed. */
export const DEFAULT_TARGET_MULTIPLE: Rational = makeRational(2n);
/** Section 5.1: bust at 50 % of the seed (ch.15 `bust_fraction`, Owner-editable). */
export const DEFAULT_BUST_FRACTION: Rational = makeRational(1n, 2n);
/** Section 5.1 / ch.15 `stall_sessions` (3 to 10, Owner). TST-101 is stated at this default. */
export const DEFAULT_STALL_SESSIONS = 5;
/** Section 5.1 / ch.15 `stall_parcel_rejections` (10 to 40, Owner). */
export const DEFAULT_STALL_PARCEL_REJECTIONS = 20;
/** Section 5.1 / ch.15 `timeout_sessions`. */
export const DEFAULT_TIMEOUT_SESSIONS = 252;

export type TerminalParams = {
  readonly seedMicro: Micro;
  readonly targetMultiple: Rational;
  readonly bustFraction: Rational;
  /** Computed floor (stallFloorMicro), injected so a replay uses the stored value. */
  readonly stallFloorMicro: Micro;
  readonly stallSessions: number;
  readonly stallParcelRejections: number;
  readonly timeoutSessions: number;
};

export function assertTerminalParams(p: TerminalParams): void {
  if (p.seedMicro <= 0n) throw new RangeError("seed must be positive");
  if (cmpRat(p.targetMultiple, makeRational(1n)) <= 0) {
    throw new RangeError("target multiple must be above 1");
  }
  if (
    cmpRat(p.bustFraction, makeRational(0n)) <= 0 ||
    cmpRat(p.bustFraction, makeRational(1n)) >= 0
  ) {
    throw new RangeError("bust fraction must be between 0 and 1");
  }
  if (p.stallFloorMicro <= 0n) throw new RangeError("stall floor must be positive");
  for (const [name, n] of [
    ["stall_sessions", p.stallSessions],
    ["stall_parcel_rejections", p.stallParcelRejections],
    ["timeout_sessions", p.timeoutSessions],
  ] as const) {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${name} must be a whole number`);
  }
}

export function terminalThresholds(p: TerminalParams): {
  readonly targetMicro: Micro;
  readonly bustMicro: Micro;
} {
  return {
    targetMicro: roundHalfAwayFromZero(mulRat(makeRational(p.seedMicro), p.targetMultiple)),
    bustMicro: roundHalfAwayFromZero(mulRat(makeRational(p.seedMicro), p.bustFraction)),
  };
}

// ---- one close ------------------------------------------------------------------------------------------

/** What the terminal tests need of one session close of one cohort. */
export type CloseDay = {
  readonly d: string;
  /** Kept for the record only; no test reads it. */
  readonly navMicro: Micro;
  readonly liqNavMicro: Micro;
  /** Open stock positions at the close (a suspended holding counts). */
  readonly openPositions: bigint;
  /** Family signals (entry orders) decided at this close; null while not yet known. */
  readonly signals: number | null;
  /** How many of them were rejected ONLY for parcel / whole-share reasons. */
  readonly parcelOnlyRejections: number;
};

const PARCEL_REASONS: readonly string[] = ["parcel", "whole_share"];

/**
 * True when a stored `reject_reason` text names only parcel / whole-share reasons (section 5.1
 * stall (b)): comma-separated, every part one of the two. Null, empty or any other reason is false.
 */
export function isParcelOnlyReasonText(reasonText: string | null): boolean {
  if (reasonText === null || reasonText.length === 0) return false;
  return reasonText.split(",").every((r) => PARCEL_REASONS.includes(r));
}

function assertAscending(history: readonly CloseDay[]): void {
  for (let i = 1; i < history.length; i++) {
    if (history[i].d <= history[i - 1].d) throw new RangeError("close history must ascend by date");
  }
}

/** Trailing run of closes with no open position and liquidation NAV below the floor (stall (a)). */
export function stallFloorStreak(history: readonly CloseDay[], floorMicro: Micro): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const day = history[i];
    if (day.openPositions !== 0n || day.liqNavMicro >= floorMicro) break;
    n += 1;
  }
  return n;
}

export type ParcelStallWindow = {
  /** Days in the window (the last M days with known signals). */
  readonly days: number;
  readonly signals: number;
  readonly parcelOnly: number;
  readonly noOpenPositions: boolean;
  readonly stalled: boolean;
};

/**
 * Stall (b): the last `sessions` days with known signals hold at least one signal, every signal
 * was rejected only for parcel / whole-share reasons, and no day had an open position.
 */
export function parcelStallWindow(
  history: readonly CloseDay[],
  sessions: number,
): ParcelStallWindow {
  const known = history.filter((h) => h.signals !== null);
  const window = known.slice(known.length > sessions ? known.length - sessions : 0);
  let signals = 0;
  let parcelOnly = 0;
  let noOpen = true;
  for (const day of window) {
    signals += day.signals ?? 0;
    parcelOnly += day.parcelOnlyRejections;
    if (day.openPositions !== 0n) noOpen = false;
  }
  return {
    days: window.length,
    signals,
    parcelOnly,
    noOpenPositions: noOpen,
    stalled: window.length === sessions && noOpen && signals >= 1 && parcelOnly === signals,
  };
}

// ---- the verdict -----------------------------------------------------------------------------------------

export type TerminalRule = "target" | "bust" | "stall_floor" | "stall_parcel" | "timeout";

export type TerminalVerdict = {
  readonly kind: TerminalKind;
  readonly rule: TerminalRule;
  /** The terminal close. */
  readonly d: string;
  readonly ttdSessions: bigint;
  readonly ttdDays: bigint;
  /** Liquidation NAV at the terminal close (fixed, ARN-053). */
  readonly outcomeMicro: Micro;
  readonly navMicro: Micro;
  readonly targetMicro: Micro;
  readonly bustMicro: Micro;
};

export type TerminalInput = {
  readonly params: TerminalParams;
  readonly startD: string;
  readonly calendar: readonly CalendarRow[];
  /** Closes of the cohort from its start up to and including the close being judged. */
  readonly history: readonly CloseDay[];
};

/**
 * Judge the LAST close of `history` (ARN-052). Null while the cohort is unresolved. The caller must
 * not call it for a cohort that already has a terminal state.
 */
export function evaluateTerminal(input: TerminalInput): TerminalVerdict | null {
  const { params, history } = input;
  assertTerminalParams(params);
  if (history.length === 0) return null;
  assertAscending(history);
  const last = history[history.length - 1];
  if (last.d < input.startD) throw new RangeError("a close before the cohort start");
  const { targetMicro, bustMicro } = terminalThresholds(params);
  const sessions = sessionsBetween(input.startD, last.d, input.calendar).length;

  let kind: TerminalKind | null = null;
  let rule: TerminalRule | null = null;
  const liq = last.liqNavMicro; // ARN-052: the only NAV any test reads
  if (liq >= targetMicro) {
    kind = "target";
    rule = "target";
  } else if (liq <= bustMicro) {
    kind = "bust";
    rule = "bust";
  } else if (stallFloorStreak(history, params.stallFloorMicro) >= params.stallSessions) {
    kind = "stalled";
    rule = "stall_floor";
  } else if (parcelStallWindow(history, params.stallParcelRejections).stalled) {
    kind = "stalled";
    rule = "stall_parcel";
  } else if (sessions >= params.timeoutSessions) {
    kind = "timeout";
    rule = "timeout";
  }
  if (kind === null || rule === null) return null;
  return {
    kind,
    rule,
    d: last.d,
    ttdSessions: BigInt(sessions),
    ttdDays: daysBetween(input.startD, last.d),
    outcomeMicro: liq,
    navMicro: last.navMicro,
    targetMicro,
    bustMicro,
  };
}

// ---- liquidation at the next open (ARN-053) -------------------------------------------------------------

export type OpenTradeRef = { readonly tradeId: string; readonly code: string };

export type LiquidationOrderPlan = {
  readonly orderId: string;
  readonly cohortId: string;
  /** The terminal close. */
  readonly decidedD: string;
  /** The next session: the order fills at its open under the normal fill rules. */
  readonly fillD: string;
  readonly code: string;
  readonly qty: bigint;
  readonly tradeId: string;
  /** trade.exit_type to set when the fill lands. */
  readonly exitType: "terminal";
};

export type LiquidationPlan = {
  readonly cohortId: string;
  readonly terminalD: string;
  readonly fillD: string;
  /** `arena_order` rows of kind exit_cs, one per held code (ascending code). Exits are never gated. */
  readonly orders: readonly LiquidationOrderPlan[];
  /** An open real sleeve trade closes at the same open with a `cs` exit (D-075); null if none. */
  readonly sleeveTradeId: string | null;
  readonly sleeveExit: "cs";
};

export function liquidationOrderId(cohortId: string, d: string, code: string): string {
  return `LQ:${cohortId}:${d}:${code}`;
}

/**
 * The orders that liquidate a cohort whose terminal close is `d`: every held code sold at the next
 * session's open (kind exit_cs, normal fill rules, ARN-053), the open sleeve closed by a cs exit.
 * Quality never blocks these (exits always process, DAT-210). One open trade per held code.
 */
export function planLiquidation(input: {
  readonly cohortId: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly positions: ReadonlyMap<string, bigint>;
  readonly openTrades: readonly OpenTradeRef[];
  readonly openSleeveTradeId?: string | null;
}): LiquidationPlan {
  const fillD = nextTradingDay(input.d, input.calendar);
  const orders: LiquidationOrderPlan[] = [];
  const codes = [...input.positions.keys()].sort();
  for (const code of codes) {
    const qty = input.positions.get(code) ?? 0n;
    if (qty <= 0n) throw new RangeError(`position ${code} must be positive`);
    const trades = input.openTrades.filter((t) => t.code === code);
    if (trades.length !== 1) {
      throw new RangeError(`${code}: expected exactly one open trade, found ${trades.length}`);
    }
    orders.push({
      orderId: liquidationOrderId(input.cohortId, input.d, code),
      cohortId: input.cohortId,
      decidedD: input.d,
      fillD,
      code,
      qty,
      tradeId: trades[0].tradeId,
      exitType: "terminal",
    });
  }
  for (const t of input.openTrades) {
    if (!input.positions.has(t.code)) {
      throw new RangeError(`open trade ${t.tradeId} has no position in ${t.code}`);
    }
  }
  return {
    cohortId: input.cohortId,
    terminalD: input.d,
    fillD,
    orders,
    sleeveTradeId: input.openSleeveTradeId ?? null,
    sleeveExit: "cs",
  };
}

// ---- legacy ledger (ARN-026) ------------------------------------------------------------------------------

export type LegacyItem = {
  readonly tradeId: string;
  readonly code: string;
  readonly qty: bigint;
  /** Frozen last traded raw close. */
  readonly closeMicro: Micro;
  /** True once the suspension haircut applies (ARN-026: after the configured sessions). */
  readonly haircut: boolean;
  /** Value carried in the legacy ledger: qty x close, or the haircut value (one rounding). */
  readonly valueMicro: Micro;
};

/**
 * Positions of an ended cohort that cannot be sold because the code is halted or suspended move
 * to the legacy ledger (trade.legacy = 1) instead of being liquidated (ARN-026, ARN-053). `markFor`
 * gives the suspension mark (suspensionMark, corpActions.ts). Ascending code.
 */
export function planLegacy(input: {
  readonly positions: ReadonlyMap<string, bigint>;
  readonly openTrades: readonly OpenTradeRef[];
  readonly halted: ReadonlySet<string>;
  readonly markFor: (code: string) => Mark;
}): LegacyItem[] {
  const items: LegacyItem[] = [];
  for (const code of [...input.positions.keys()].sort()) {
    if (!input.halted.has(code)) continue;
    const qty = input.positions.get(code) ?? 0n;
    const trades = input.openTrades.filter((t) => t.code === code);
    if (qty <= 0n || trades.length !== 1) {
      throw new RangeError(`${code}: expected one open trade and a positive holding`);
    }
    const mark = input.markFor(code);
    items.push({
      tradeId: trades[0].tradeId,
      code,
      qty,
      closeMicro: mark.closeMicro,
      haircut: mark.haircut !== undefined && mark.haircut !== null,
      valueMicro: positionValueMicro(qty, mark),
    });
  }
  return items;
}

/** The first session on which a successor cohort may start: the open after the liquidation open. */
export function restartSession(terminalD: string, calendar: readonly CalendarRow[]): string {
  return nextTradingDay(nextTradingDay(terminalD, calendar), calendar);
}
