// Cost-profile re-cost and uniform price-shock rows for one live cohort-night (M7 T4; docs/M7_design.md
// 6 decision 52 (D-132 draft), UX-022, UXN-152, ARN-034). HIGH-RISK money module: bigint micro-AUD,
// exact rationals, no floats. Pure over stored evidence (fills, NAV row, position rows); the
// request never computes any of it - batch 3 writes the result into `replay_stat` and the pages read.
//
// Re-cost under profile X (X = P0..P5b): every fill up to D keeps its price and quantity, its
// brokerage is re-priced with the M3 `feeFor` on the stored fill value, and the NAV moves by the
// total fee difference (fees are the only thing a profile changes). The liquidation NAV also
// re-prices the sale cost of each open position under X. Re-costing under the cohort's own profile
// gives the stored NAV and liquidation NAV exactly (the identity the tests check).
// Stress: profile P3 (key `stress_cost_profile`) and slippage widened by `stress_slippage_extra_pct`
// percent. Each fill is re-priced from its stored reference price with the M3 slippage function on
// the widened buckets; the price moves by the adverse difference between the widened and the
// default slippage (so an in-range stop fill keeps its extra tick), cash moves by qty times that
// difference, and the fee is re-priced on the new value. Sleeve (leveraged) fills are not
// re-costed: their cost and financing are part of the stored sleeve figures.
// Price shock: every open position's stored value moves by +/- 10, 20, 30 percent; the P&L is the sum
// of the per-position amounts, each rounded once half away from zero.
import type { Client } from "@libsql/client";
import { previousTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { type Micro } from "@/lib/money/micro";
import { makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { parseCohortParams } from "./cohort";
import { COST_PROFILE_CODES, feeFor, getCostProfile, type CostProfile } from "./costs";
import { createMarketData } from "./marketData";
import { liquidationValueMicro } from "./nav";
import { SLIPPAGE_BUCKETS, slippageFill, type SlippageBucket } from "./slippage";

/** The profiles re-costed every night, then the stress column. */
export const RECOST_KEYS = [...COST_PROFILE_CODES, "stress"] as const;
export type RecostKey = (typeof RECOST_KEYS)[number];

/** Uniform shocks in whole percent (UXN-152): the vol-spike scenario has no definition and is not built. */
export const SHOCK_PCTS: readonly number[] = [-30, -20, -10, 10, 20, 30]; // threshold-ok: UXN-152 shock ladder

const PERCENT = 100n; // threshold-ok: percent denominator

export type RecostFill = {
  readonly id: string;
  readonly d: string;
  readonly code: string;
  readonly side: "buy" | "sell";
  readonly qty: bigint;
  readonly valueMicro: Micro;
  readonly brokerageMicro: Micro;
  /** Reference price of the fill (stored); the stress re-price starts from it. */
  readonly refPriceMicro: Micro;
  readonly fillPriceMicro: Micro;
  /** 20-session ADV of the session before the fill (the slippage bucket the fill used). */
  readonly advMicro: Micro;
};

export type RecostPosition = {
  readonly code: string;
  readonly qty: bigint;
  readonly closeMicro: Micro;
  /** 20-session ADV on D. */
  readonly advMicro: Micro;
  /** Held at a haircut or suspended: it cannot be sold, so the profile does not change its value. */
  readonly frozen: boolean;
};

export type RecostInput = {
  readonly cohortProfile: CostProfile;
  readonly tickCrossFactor: Rational;
  readonly storedNavMicro: Micro;
  readonly storedLiqNavMicro: Micro;
  readonly fills: readonly RecostFill[];
  readonly positions: readonly RecostPosition[];
  readonly stressProfile: CostProfile;
  readonly stressBuckets: readonly SlippageBucket[];
};

export type RecostResult = {
  readonly key: RecostKey;
  readonly navMicro: Micro;
  readonly liqNavMicro: Micro;
  /** Total brokerage of every fill to D under this key. */
  readonly feesMicro: Micro;
};

/** Slippage buckets with every bps multiplied by (100 + extraPct) / 100 (exact; as replay/returns.ts). */
export function widenBuckets(
  buckets: readonly SlippageBucket[],
  extraPct: bigint,
): SlippageBucket[] {
  const factor = makeRational(PERCENT + extraPct, PERCENT);
  return buckets.map((b) => ({ fromAdvMicro: b.fromAdvMicro, bps: mulRat(b.bps, factor) }));
}

/** P2 pays nothing for the first buy of a security in a day: the first buy fill of (code, d) in (d, id) order. */
function firstBuyIds(fills: readonly RecostFill[]): Set<string> {
  const seen = new Set<string>();
  const first = new Set<string>();
  for (const f of fills) {
    if (f.side !== "buy") continue;
    const k = `${f.code}|${f.d}`;
    if (seen.has(k)) continue;
    seen.add(k);
    first.add(f.id);
  }
  return first;
}

function ordered(fills: readonly RecostFill[]): RecostFill[] {
  return [...fills].sort((a, b) =>
    a.d !== b.d ? (a.d < b.d ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/** Stress price of one fill: the stored price moved by the adverse extra slippage of the widened buckets. */
function stressPriceMicro(
  f: RecostFill,
  tickCrossFactor: Rational,
  stressBuckets: readonly SlippageBucket[],
): Micro {
  const base = slippageFill(f.refPriceMicro, f.side, f.advMicro, tickCrossFactor, SLIPPAGE_BUCKETS);
  const wide = slippageFill(f.refPriceMicro, f.side, f.advMicro, tickCrossFactor, stressBuckets);
  const extra =
    f.side === "buy" ? wide.fillMicro - base.fillMicro : base.fillMicro - wide.fillMicro;
  const price = f.side === "buy" ? f.fillPriceMicro + extra : f.fillPriceMicro - extra;
  return price < 1n ? 1n : price;
}

function feeAt(
  profile: CostProfile,
  valueMicro: Micro,
  side: "buy" | "sell",
  first: boolean,
): Micro {
  if (valueMicro <= 0n) return 0n;
  return feeFor(profile, valueMicro, side, { firstBuyOfSecurityToday: first });
}

/** Re-cost one cohort-night under every key. Pure; the order of fills in the input does not matter. */
export function recostCohortDay(input: RecostInput): RecostResult[] {
  const fills = ordered(input.fills);
  const first = firstBuyIds(fills);
  const liqAdjustment = input.storedNavMicro - input.storedLiqNavMicro; // stored cost of selling (and sleeve)
  const out: RecostResult[] = [];
  for (const key of RECOST_KEYS) {
    const stress = key === "stress";
    const profile = stress ? input.stressProfile : getCostProfile(key);
    const buckets = stress ? input.stressBuckets : SLIPPAGE_BUCKETS;
    let feeDelta = 0n;
    let cashDelta = 0n;
    let fees = 0n;
    for (const f of fills) {
      let value = f.valueMicro;
      if (stress) {
        value = f.qty * stressPriceMicro(f, input.tickCrossFactor, buckets);
        const move = value - f.valueMicro; // a buy pays more, a sell receives less
        cashDelta += f.side === "buy" ? -move : move;
      }
      const fee = feeAt(profile, value, f.side, first.has(f.id));
      fees += fee;
      feeDelta += f.brokerageMicro - fee;
    }
    const navMicro = input.storedNavMicro + feeDelta + cashDelta;
    let saleCostDelta = 0n;
    for (const p of input.positions) {
      if (p.frozen) continue;
      const mark = { closeMicro: p.closeMicro, advMicro: p.advMicro };
      const stored = liquidationValueMicro(p.qty, mark, {
        profile: input.cohortProfile,
        tickCrossFactor: input.tickCrossFactor,
      });
      const here = liquidationValueMicro(p.qty, mark, {
        profile,
        tickCrossFactor: input.tickCrossFactor,
        buckets,
      });
      saleCostDelta += stored - here;
    }
    out.push({
      key,
      navMicro,
      liqNavMicro: navMicro - liqAdjustment - saleCostDelta,
      feesMicro: fees,
    });
  }
  return out;
}

export type ShockResult = {
  readonly pct: number;
  /** Sum of the per-position amounts, each rounded once half away from zero. */
  readonly pnlMicro: Micro;
  readonly valueMicro: Micro;
  readonly navAfterMicro: Micro;
};

/** P&L of the open positions under uniform shocks; `valueMicro` is the stored position value (NAV basis). */
export function shockCohortDay(
  positionValuesMicro: readonly Micro[],
  navMicro: Micro,
  pcts: readonly number[] = SHOCK_PCTS,
): ShockResult[] {
  const value = positionValuesMicro.reduce((a, b) => a + b, 0n);
  return pcts.map((pct) => {
    const factor = makeRational(BigInt(pct), PERCENT);
    let pnl = 0n;
    for (const v of positionValuesMicro)
      pnl += roundHalfAwayFromZero(mulRat(makeRational(v), factor));
    return { pct, pnlMicro: pnl, valueMicro: value, navAfterMicro: navMicro + pnl };
  });
}

// ---- database side ---------------------------------------------------------------------------------------------------

export type RecostRow = {
  readonly scope: string;
  readonly metric: string;
  readonly value: Record<string, string | number>;
};

export const costScope = (cohortId: string): string => `cost:${cohortId}`;
export const shockScope = (cohortId: string): string => `shock:${cohortId}`;
export const costMetric = (key: RecostKey): string => `recost:${key}`;
export const shockMetric = (pct: number): string => `shock:${pct > 0 ? "+" : ""}${pct}`;

const text = (v: unknown): string => String(v);
const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new TypeError("expected an integer column value");
};

export type RecostParams = {
  readonly stressProfile: string;
  readonly stressSlippageExtraPct: number;
};

/**
 * The `replay_stat` rows (scopes `cost:<cohort>` and `shock:<cohort>`) of one cohort on D, or an
 * empty list when the cohort has no NAV row on D. Money values are decimal strings of micro-AUD.
 */
export async function recostRowsFor(
  db: Client,
  o: {
    readonly market: string;
    readonly cohortId: string;
    readonly d: string;
    readonly calendar: readonly CalendarRow[];
    readonly params: RecostParams;
  },
): Promise<RecostRow[]> {
  const nav = await db.execute({
    sql: "SELECT nav_micro, liq_nav_micro FROM nav_daily WHERE cohort_id = ? AND d = ?",
    args: [o.cohortId, o.d],
  });
  if (nav.rows.length === 0) return [];
  const storedNav = big(nav.rows[0]!.nav_micro);
  const storedLiq = big(nav.rows[0]!.liq_nav_micro);
  const cohort = await db.execute({
    sql: "SELECT params_json FROM cohort WHERE id = ?",
    args: [o.cohortId],
  });
  const cp = parseCohortParams(text(cohort.rows[0]!.params_json));
  const data = createMarketData(db, o.market, o.d);

  const fillRs = await db.execute({
    sql: `SELECT id, d, code, side, qty, value_micro, brokerage_micro, ref_price_micro, fill_price_micro
          FROM fill WHERE cohort_id = ? AND d <= ?
            AND order_id NOT IN (SELECT id FROM arena_order WHERE kind IN ('sleeve_open', 'sleeve_close'))
          ORDER BY d, id`,
    args: [o.cohortId, o.d],
  });
  const fills: RecostFill[] = [];
  for (const r of fillRs.rows) {
    const d = text(r.d);
    let prior = d;
    try {
      prior = previousTradingDay(d, o.calendar);
    } catch {
      prior = d; // calendar does not reach back: the fill session's own ADV (still <= D)
    }
    fills.push({
      id: text(r.id),
      d,
      code: text(r.code),
      side: text(r.side) === "buy" ? "buy" : "sell",
      qty: big(r.qty),
      valueMicro: big(r.value_micro),
      brokerageMicro: big(r.brokerage_micro),
      refPriceMicro: big(r.ref_price_micro),
      fillPriceMicro: big(r.fill_price_micro),
      advMicro: await data.adv(text(r.code), prior),
    });
  }
  const posRs = await db.execute({
    sql: `SELECT code, qty, close_micro, value_micro, haircut FROM nav_daily_pos
          WHERE cohort_id = ? AND d = ? ORDER BY code`,
    args: [o.cohortId, o.d],
  });
  const positions: RecostPosition[] = [];
  const values: Micro[] = [];
  for (const r of posRs.rows) {
    const code = text(r.code);
    values.push(big(r.value_micro));
    positions.push({
      code,
      qty: big(r.qty),
      closeMicro: big(r.close_micro),
      advMicro: await data.adv(code, o.d),
      frozen: big(r.haircut) === 1n || (await data.halted(code, o.d)),
    });
  }
  const stressBuckets = widenBuckets(SLIPPAGE_BUCKETS, BigInt(o.params.stressSlippageExtraPct));
  const results = recostCohortDay({
    cohortProfile: getCostProfile(cp.costProfile),
    tickCrossFactor: cp.tickCrossFactor,
    storedNavMicro: storedNav,
    storedLiqNavMicro: storedLiq,
    fills,
    positions,
    stressProfile: getCostProfile(o.params.stressProfile),
    stressBuckets,
  });
  const rows: RecostRow[] = results.map((r) => ({
    scope: costScope(o.cohortId),
    metric: costMetric(r.key),
    value: {
      nav_micro: r.navMicro.toString(),
      liq_nav_micro: r.liqNavMicro.toString(),
      fees_micro: r.feesMicro.toString(),
      stored_nav_micro: storedNav.toString(),
      fills: fills.length,
    },
  }));
  for (const s of shockCohortDay(values, storedNav)) {
    rows.push({
      scope: shockScope(o.cohortId),
      metric: shockMetric(s.pct),
      value: {
        pct: s.pct,
        pnl_micro: s.pnlMicro.toString(),
        value_micro: s.valueMicro.toString(),
        nav_after_micro: s.navAfterMicro.toString(),
        positions: positions.length,
      },
    });
  }
  return rows;
}
