// Positions, daily NAV and liquidation NAV (spec 05 ARN-051, ARN-052, ARN-026; M3 design 2.2 R6,
// 4.2 step 4; D-069 decisions 11 and 14). HIGH-RISK money module: bigint micro-AUD, exact
// rationals, no division. Everything here is a pure function of (ledger rows, fills, marks), so a
// day can be recomputed from scratch at any time and compared with the stored row (ARN-101).
//
//   NAV (ARN-051) = cash_settled + cash_recv - payables + sum(qty x raw close, or haircut value)
//                   + dividends receivable + sleeve margin + sleeve unrealised price P/L
//                   - accrued unpaid financing.   Franking is never added.
//   Liquidation NAV (ARN-052) = cash side unchanged + sum(positions sold at close - slippage
//                   - brokerage), i.e. the sell fill and P5 fee a CS exit would pay on that close.
//                   A suspended position (frozen or haircut) cannot be sold: it stays at its marked value.
// Positions are DERIVED from fills (decision 11); a split or consolidation re-bases the quantity
// by the recorded ratio on the ex-date, cash unchanged (decision 14); a fractional result is
// rounded down (rebaseQty; corpActions.ts, T7).
import { type Micro } from "@/lib/money/micro";
import { cmpRat, makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { feeFor, type CostProfile, type FeeContext } from "./costs";
import {
  balancesFromRows,
  type LedgerBalances,
  type LedgerFill,
  type LedgerRow,
  rebaseQty,
  type QtyAdjustment,
} from "./ledger";
import type { Flag01 } from "./schema";
import { DEFAULT_TICK_CROSS_FACTOR, SLIPPAGE_BUCKETS, slippageFill } from "./slippage";
import type { SlippageBucket } from "./slippage";

// ---- positions -------------------------------------------------------------------------------

export type { QtyAdjustment };

export type PositionState = {
  /** Strictly positive holdings by code. */
  readonly positions: ReadonlyMap<string, bigint>;
  /** Codes whose derived holding is negative (a short: always an invariant violation). */
  readonly shorts: readonly { readonly code: string; readonly qty: bigint }[];
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Holdings at the close of `asOfD`: fills dated on or before it, per date in order, the day's
 * quantity adjustments applied FIRST (they act on the holding of the prior close; fills on the
 * ex-date are already in post-event terms) and then the day's fills.
 */
export function derivePositions(
  fills: readonly LedgerFill[],
  adjustments: readonly QtyAdjustment[],
  asOfD: string,
): PositionState {
  const dates = new Set<string>();
  for (const f of fills) if (f.d <= asOfD) dates.add(f.d);
  for (const a of adjustments) if (a.exD <= asOfD) dates.add(a.exD);
  const held = new Map<string, bigint>();
  for (const d of [...dates].sort(compareText)) {
    const todaysAdjustments = adjustments
      .filter((a) => a.exD === d)
      .sort((a, b) => compareText(a.code, b.code));
    for (const a of todaysAdjustments) {
      const qty = held.get(a.code) ?? 0n;
      if (qty === 0n) continue;
      held.set(a.code, rebaseQty(qty, a.ratio));
    }
    for (const f of fills.filter((x) => x.d === d)) {
      const qty = held.get(f.code) ?? 0n;
      held.set(f.code, f.side === "buy" ? qty + f.qty : qty - f.qty);
    }
  }
  const positions = new Map<string, bigint>();
  const shorts: { code: string; qty: bigint }[] = [];
  for (const [code, qty] of [...held.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    if (qty > 0n) positions.set(code, qty);
    else if (qty < 0n) shorts.push({ code, qty });
  }
  return { positions, shorts };
}

// ---- marks and one day -----------------------------------------------------------------------

/** The closing evidence for one held code on one date (raw prices, never adjusted). */
export type Mark = {
  readonly closeMicro: Micro;
  /** 20-session ADV as traded value, micro-AUD (slippage bucket for the liquidation estimate). */
  readonly advMicro: Micro;
  /** Suspension haircut as an exact rational (ARN-026); null or absent = marked at close. */
  readonly haircut?: Rational | null;
  /** Suspended: frozen at the last price, no fill possible (ARN-026); the haircut may not apply yet. */
  readonly halted?: boolean;
};

export type NavCostOptions = {
  readonly profile: CostProfile;
  readonly feeContext?: FeeContext;
  readonly tickCrossFactor?: Rational;
  readonly buckets?: readonly SlippageBucket[];
};

export type NavPosRow = {
  readonly cohortId: string;
  readonly d: string;
  readonly code: string;
  readonly qty: bigint;
  readonly closeMicro: Micro;
  readonly valueMicro: Micro;
  readonly haircut: Flag01;
};

export type NavDayRow = {
  readonly cohortId: string;
  readonly d: string;
  readonly cashSettledMicro: Micro;
  readonly recvMicro: Micro;
  /** Payables as a positive amount (the ledger account is negative). */
  readonly payMicro: Micro;
  readonly positionsMicro: Micro;
  readonly divRecvMicro: Micro;
  readonly sleeveMarginMicro: Micro;
  readonly sleeveUnrealMicro: Micro;
  /** Accrued unpaid financing as a positive amount (the ledger account is negative). */
  readonly finAccruedMicro: Micro;
  readonly navMicro: Micro;
  readonly liqNavMicro: Micro;
  readonly openPositions: bigint;
  readonly invariantsOk: Flag01;
};

export type NavDay = { readonly row: NavDayRow; readonly positions: readonly NavPosRow[] };

/** ARN-051, term by term. The one place the NAV identity is written down. */
export function navIdentityMicro(
  row: Pick<
    NavDayRow,
    | "cashSettledMicro"
    | "recvMicro"
    | "payMicro"
    | "positionsMicro"
    | "divRecvMicro"
    | "sleeveMarginMicro"
    | "sleeveUnrealMicro"
    | "finAccruedMicro"
  >,
): Micro {
  return (
    row.cashSettledMicro +
    row.recvMicro -
    row.payMicro +
    row.positionsMicro +
    row.divRecvMicro +
    row.sleeveMarginMicro +
    row.sleeveUnrealMicro -
    row.finAccruedMicro
  );
}

/** Position value for NAV: qty x close, or round_half_away(qty x close x haircut) once (R6). */
export function positionValueMicro(qty: bigint, mark: Mark): Micro {
  const gross = qty * mark.closeMicro;
  if (mark.haircut === undefined || mark.haircut === null) return gross;
  if (mark.haircut.num < 0n || cmpRat(mark.haircut, makeRational(1n)) > 0) {
    throw new RangeError("haircut must be between 0 and 1");
  }
  return roundHalfAwayFromZero(mulRat(makeRational(gross), mark.haircut));
}

/**
 * Value the position would realise if sold at the close (ARN-052): quantity x sell fill (close
 * less slippage, on the tick grid) less brokerage on that value. A haircut position keeps its
 * haircut value (it cannot trade).
 */
export function liquidationValueMicro(qty: bigint, mark: Mark, options: NavCostOptions): Micro {
  if (mark.halted === true || (mark.haircut !== undefined && mark.haircut !== null)) {
    return positionValueMicro(qty, mark);
  }
  const sell = slippageFill(
    mark.closeMicro,
    "sell",
    mark.advMicro,
    options.tickCrossFactor ?? DEFAULT_TICK_CROSS_FACTOR,
    options.buckets ?? SLIPPAGE_BUCKETS,
  );
  const value = qty * sell.fillMicro;
  return value - feeFor(options.profile, value, "sell", options.feeContext);
}

export type NavDayInput = NavCostOptions & {
  readonly cohortId: string;
  readonly d: string;
  readonly balances: LedgerBalances;
  readonly positions: ReadonlyMap<string, bigint>;
  readonly markFor: (code: string) => Mark | undefined;
  /** Sleeve unrealised price P/L at the close (sleeve engine, T8); default 0. */
  readonly sleeveUnrealMicro?: Micro;
};

/** One cohort-day: the nav_daily row and its nav_daily_pos rows (codes ascending). */
export function computeNavDay(input: NavDayInput): NavDay {
  const b = input.balances;
  const positions: NavPosRow[] = [];
  let positionsMicro = 0n;
  let liquidationAdjustment = 0n;
  for (const [code, qty] of [...input.positions.entries()].sort((a, b) =>
    compareText(a[0], b[0]),
  )) {
    if (qty <= 0n) throw new RangeError(`position ${code} must be positive`);
    const mark = input.markFor(code);
    if (mark === undefined) throw new RangeError(`no close for ${code} on ${input.d}`);
    if (mark.closeMicro <= 0n) throw new RangeError(`close for ${code} must be positive`);
    const value = positionValueMicro(qty, mark);
    const liquidation = liquidationValueMicro(qty, mark, input);
    positionsMicro += value;
    liquidationAdjustment += value - liquidation; // the cost of selling, never negative
    positions.push({
      cohortId: input.cohortId,
      d: input.d,
      code,
      qty,
      closeMicro: mark.closeMicro,
      valueMicro: value,
      haircut: mark.haircut === undefined || mark.haircut === null ? 0 : 1,
    });
  }
  const parts = {
    cashSettledMicro: b.cash_settled,
    recvMicro: b.cash_recv,
    payMicro: -b.cash_pay,
    positionsMicro,
    divRecvMicro: b.div_recv,
    sleeveMarginMicro: b.sleeve_margin,
    sleeveUnrealMicro: input.sleeveUnrealMicro ?? 0n,
    finAccruedMicro: -b.fin_accrued,
  };
  const navMicro = navIdentityMicro(parts);
  return {
    row: {
      cohortId: input.cohortId,
      d: input.d,
      ...parts,
      navMicro,
      liqNavMicro: navMicro - liquidationAdjustment,
      openPositions: BigInt(positions.length),
      invariantsOk: 1,
    },
    positions,
  };
}

/** The same day with the invariant verdict recorded (the row is append-only, so set it once). */
export function withInvariantsOk(day: NavDay, ok: boolean): NavDay {
  return { row: { ...day.row, invariantsOk: ok ? 1 : 0 }, positions: day.positions };
}

// ---- recompute from the books ----------------------------------------------------------------

/** Everything needed to rebuild any day of one cohort from scratch. */
export type CohortBooks = NavCostOptions & {
  readonly cohortId: string;
  readonly rows: readonly LedgerRow[];
  readonly fills: readonly LedgerFill[];
  readonly adjustments?: readonly QtyAdjustment[];
  readonly markFor: (d: string, code: string) => Mark | undefined;
  readonly sleeveUnrealFor?: (d: string) => Micro;
};

/** Rebuild one day. A short position cannot be valued and raises. */
export function buildNavDay(books: CohortBooks, d: string): NavDay {
  const state = derivePositions(books.fills, books.adjustments ?? [], d);
  if (state.shorts.length > 0) throw new RangeError(`short position on ${d}`);
  return computeNavDay({
    cohortId: books.cohortId,
    d,
    balances: balancesFromRows(books.rows, d),
    positions: state.positions,
    markFor: (code) => books.markFor(d, code),
    sleeveUnrealMicro: books.sleeveUnrealFor?.(d) ?? 0n,
    profile: books.profile,
    feeContext: books.feeContext,
    tickCrossFactor: books.tickCrossFactor,
    buckets: books.buckets,
  });
}

export function buildNavSeries(books: CohortBooks, dates: readonly string[]): NavDay[] {
  return dates.map((d) => buildNavDay(books, d));
}

// ---- canonical serialisation (byte-identical replay, ARN-102 / NFR-022) -----------------------

/** One canonical text line per row, bigint as decimal text, fields in a fixed order. */
export function serializeNavDays(days: readonly NavDay[]): string {
  const lines: string[] = [];
  for (const { row, positions } of days) {
    lines.push(
      [
        "nav",
        row.cohortId,
        row.d,
        row.cashSettledMicro,
        row.recvMicro,
        row.payMicro,
        row.positionsMicro,
        row.divRecvMicro,
        row.sleeveMarginMicro,
        row.sleeveUnrealMicro,
        row.finAccruedMicro,
        row.navMicro,
        row.liqNavMicro,
        row.openPositions,
        row.invariantsOk,
      ].join("|"),
    );
    for (const p of positions) {
      lines.push(
        ["pos", p.cohortId, p.d, p.code, p.qty, p.closeMicro, p.valueMicro, p.haircut].join("|"),
      );
    }
  }
  return lines.join("\n");
}
