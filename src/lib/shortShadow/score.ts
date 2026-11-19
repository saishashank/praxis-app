// VAL-121 scoring (M21 R1; D-1228, D-1296; section H of docs/M21_design.md): pre-registered and fixed before any computation
// (BLD-051). A would-have short, never a trade: sell at the D+1 open less the CS slippage (`csExitSlippedPrice`), a stop at
// the entry price x 1.10 (an intraday high at or above it covers at the stop, or at the open on a gap above it), otherwise
// cover at the open after 10 sessions; the cover pays the same slippage the other way. Fees per the market's cost profile
// on both sides; borrow = round_half_away(entry value x borrow bps a year x calendar days / 3,650,000); net in micro and in
// ppm of the entry value. All integer micro. The step writes the outcome table only (through `store.ts`).
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import {
  costProfileOfMarket,
  costProfilesOfMarket,
  feeFor,
  type CostProfile,
} from "@/lib/arena/costs";
import { csExitSlippedPrice, type FillEnv } from "@/lib/arena/fills";
import { marketMoney } from "@/lib/arena/marketMoney";
import { priceMicro } from "@/lib/arena/marketData";
import { getConfig } from "@/lib/config/store";
import { addDays, nextTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { listingFloor } from "@/lib/data/listing";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { shortRulesOf } from "@/lib/market/seed/shortRules.mjs";
import { makeRational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import {
  insertShortOutcome,
  type ShortExitReason,
  type ShortOrigin,
  type ShortOutcomeRow,
} from "./store";

export const STOP_PPM = 1_100_000n; // threshold-ok: VAL-121 stop at entry x 1.10 (1,100,000 ppm of the entry price)
export const HOLD_SESSIONS = 10; // threshold-ok: VAL-121 pre-registered hold in sessions
const PARCEL_FLOORS = 2n; // threshold-ok: the parcel is twice the market's parcel floor (the A$1,000 stream parcel at home)
const PPM = 1_000_000n; // threshold-ok: parts per million
const BORROW_DENOM = 3_650_000n; // threshold-ok: 10,000 bps x 365 days
const PENDING_LIMIT = 5000; // threshold-ok: rows scored per pass, as SCORE_BATCH of the Cortex scoring

export type ShortBar = {
  readonly d: string;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volume: bigint;
};

export type ShortScoreInput = {
  /** The decision session D. */
  readonly d: string;
  /** Bars after D, ascending. */
  readonly bars: readonly ShortBar[];
  readonly calendar: readonly CalendarRow[];
  /** The session the pass runs for: an order with no entry bar is `unfilled` only once its entry session has come. */
  readonly asOf: string;
  readonly advMicro: bigint;
  readonly profile: CostProfile;
  readonly tickTable?: FillEnv["tickTable"];
  readonly buckets?: FillEnv["buckets"];
  readonly parcelMicro: bigint;
  readonly borrowBpsPa: number;
};

export type ShortScore =
  | { readonly status: "unfilled" }
  | {
      readonly status: "closed";
      readonly entryD: string;
      readonly entryMicro: bigint;
      readonly exitD: string;
      readonly exitMicro: bigint;
      readonly exitReason: ShortExitReason;
      readonly qty: bigint;
      readonly feesMicro: bigint;
      readonly borrowMicro: bigint;
      readonly netMicro: bigint;
      readonly netPpm: number;
    };

/** Calendar days between two ISO dates (the borrow runs on every calendar day, weekends included). */
export function calendarDaysBetween(a: string, b: string): number {
  const t = (x: string): number => Date.parse(`${x}T00:00:00Z`);
  return Math.round((t(b) - t(a)) / 86_400_000); // threshold-ok: ms a day
}

/** The borrow fee for a hold, in micro: round half away from zero of value x bps x days / 3,650,000. */
export function borrowMicro(valueMicro: bigint, bpsPa: number, days: number): bigint {
  return roundHalfAwayFromZero(
    makeRational(valueMicro * BigInt(bpsPa) * BigInt(days), BORROW_DENOM),
  );
}

const sessionAfter = (from: string, n: number, calendar: readonly CalendarRow[]): string => {
  let d = from;
  for (let i = 0; i < n; i += 1) d = nextTradingDay(d, calendar);
  return d;
};

/**
 * One would-have short, or `null` while its hold is still open. Pure: no database, no clock.
 */
export function scoreShortSetup(x: ShortScoreInput): ShortScore | null {
  const fillD = nextTradingDay(x.d, x.calendar);
  const first = x.bars[0];
  if (first === undefined || first.d !== fillD) {
    // an order fills only on the next trading day: no bar there (a gap, or only a later bar) means no trade
    if (x.bars.length > 0 || x.asOf >= fillD) return { status: "unfilled" };
    return null;
  }
  const env = (b: ShortBar): FillEnv => ({
    bar: { openMicro: b.open, highMicro: b.high, lowMicro: b.low, closeMicro: b.close },
    advMicro: x.advMicro,
    profile: x.profile,
    tickTable: x.tickTable,
    buckets: x.buckets,
  });
  const entry = csExitSlippedPrice(env(first), first.open);
  if (entry <= 0n) return { status: "unfilled" };
  const qty = x.parcelMicro / entry > 0n ? x.parcelMicro / entry : 1n;
  const stop = (entry * STOP_PPM + PPM / 2n) / PPM;
  const exitD = sessionAfter(first.d, HOLD_SESSIONS, x.calendar);

  let exit: { bar: ShortBar; ref: bigint; reason: ShortExitReason } | null = null;
  for (let i = 0; i < x.bars.length; i += 1) {
    const b = x.bars[i]!;
    if (b.d >= exitD) {
      exit = { bar: b, ref: b.open, reason: "time" };
      break;
    }
    if (i > 0 && b.open >= stop) {
      exit = { bar: b, ref: b.open, reason: "gap" };
      break;
    }
    if (b.high >= stop) {
      exit = { bar: b, ref: stop, reason: "stop" };
      break;
    }
  }
  if (exit === null) return null;

  // the cover is a buy: the same slippage the sell pays, the other way (D-1296)
  const slip = exit.ref - csExitSlippedPrice(env(exit.bar), exit.ref);
  const cover = exit.ref + (slip > 0n ? slip : 0n);
  const entryValue = qty * entry;
  const coverValue = qty * cover;
  const fees =
    feeFor(x.profile, entryValue, "sell", { quantity: qty }) +
    feeFor(x.profile, coverValue, "buy", { quantity: qty });
  const borrow = borrowMicro(entryValue, x.borrowBpsPa, calendarDaysBetween(first.d, exit.bar.d));
  const net = entryValue - coverValue - fees - borrow;
  const netPpm = roundHalfAwayFromZero(makeRational(net * PPM, entryValue));
  return {
    status: "closed",
    entryD: first.d,
    entryMicro: entry,
    exitD: exit.bar.d,
    exitMicro: cover,
    exitReason: exit.reason,
    qty,
    feesMicro: fees,
    borrowMicro: borrow,
    netMicro: net,
    netPpm: Number(netPpm), // money-float-ok: ppm of the entry value, a small integer
  };
}

export function shortCostProfile(market: string, configured: string): CostProfile {
  const table = costProfilesOfMarket(market);
  return Object.prototype.hasOwnProperty.call(table, configured)
    ? table[configured]!
    : costProfileOfMarket(staticProfile(market));
}

const toBig = (v: unknown): bigint => BigInt(typeof v === "bigint" ? v : Number(v));

/**
 * Scores every stored shadow short whose hold has closed (insert-or-ignore, so a second pass writes nothing new). A code
 * outside the shortable tiers is recorded `not_shortable` at once. Writes `short_shadow_outcome` only.
 */
export async function scoreShort(
  db: Client,
  o: {
    market: string;
    d: string;
    params: AgentParams;
    now: () => string;
    calendar?: readonly CalendarRow[];
  },
): Promise<{ scored: number; open: number }> {
  const rules = shortRulesOf(o.market);
  const scoredAt = o.now();
  // rows-ok: the stored shadow shorts with no outcome yet, bounded by LIMIT; the anti-join reads the outcome primary key
  const pending = await db.execute({
    sql: `SELECT s.d, s.code, s.origin, s.shortable FROM short_shadow_decision s
          WHERE s.market = ? AND s.d <= ?
            AND NOT EXISTS (SELECT 1 FROM short_shadow_outcome u
                            WHERE u.market = s.market AND u.d = s.d AND u.code = s.code AND u.origin = s.origin)
          ORDER BY s.d, s.code, s.origin LIMIT ?`,
    args: [o.market, o.d, PENDING_LIMIT],
  });
  if (pending.rows.length === 0) return { scored: 0, open: 0 };
  const calendar =
    o.calendar ??
    // rows-ok: the market's calendar, one row a day (the scoring pass of the Cortex reads the same)
    (
      await db.execute({
        sql: "SELECT d, kind, close_time, confirmed FROM trading_calendar WHERE market = ? ORDER BY d",
        args: [o.market],
      })
    ).rows.map((r): CalendarRow => ({
      d: String(r.d),
      kind: String(r.kind) as CalendarRow["kind"],
      close_time: r.close_time === null ? null : String(r.close_time),
      confirmed: Number(r.confirmed) === 1 ? 1 : 0,
    }));
  const money = marketMoney(o.market);
  const configured = String(await getConfig(db, "cost_profile_default"));
  const profile = shortCostProfile(o.market, configured);
  let scored = 0;
  let open = 0;
  for (const r of pending.rows) {
    const d = String(r.d);
    const code = String(r.code);
    const origin = String(r.origin) as ShortOrigin;
    const base = { market: o.market, d, code, origin, scoredAt };
    const empty = {
      entryD: null,
      entryMicro: null,
      exitD: null,
      exitMicro: null,
      exitReason: null,
      feesMicro: null,
      borrowMicro: null,
      netMicro: null,
      netPpm: null,
    } as const;
    if (Number(r.shortable) !== 1) {
      await insertShortOutcome(db, { ...base, ...empty, status: "not_shortable" });
      scored += 1;
      continue;
    }
    // rows-ok: the bars after D to the hold's end (at most 16 sessions) of one code, in the price_bar primary key order
    const after = await db.execute({
      sql: `SELECT d, o, h, l, c, volume FROM price_bar WHERE market = ? AND code = ? AND d > ? AND d <= ?
              AND ${listingFloor("price_bar")} ORDER BY d LIMIT ?`,
      args: [o.market, code, d, addDays(d, 40), 2 * HOLD_SESSIONS], // threshold-ok: calendar window of the hold
    });
    // rows-ok: the ADV window of one code up to D, newest first, LIMIT = the ADV window
    const hist = await db.execute({
      sql: `SELECT d, c, volume FROM price_bar WHERE market = ? AND code = ? AND d <= ?
              AND ${listingFloor("price_bar")} ORDER BY d DESC LIMIT ?`,
      args: [o.market, code, d, o.params.windows.adv],
    });
    let value = 0n;
    for (const h of hist.rows) value += priceMicro(h.c) * toBig(h.volume);
    const advMicro = hist.rows.length === 0 ? 0n : value / BigInt(hist.rows.length);
    const bars: ShortBar[] = after.rows.map((b) => ({
      d: String(b.d),
      open: priceMicro(b.o),
      high: priceMicro(b.h),
      low: priceMicro(b.l),
      close: priceMicro(b.c),
      volume: toBig(b.volume),
    }));
    const res = scoreShortSetup({
      d,
      bars,
      calendar,
      asOf: o.d,
      advMicro,
      profile,
      tickTable: money.tickTable,
      buckets: money.buckets,
      parcelMicro: money.parcelMicro * PARCEL_FLOORS,
      borrowBpsPa: rules.borrowBpsPa,
    });
    if (res === null) {
      open += 1;
      continue;
    }
    const row: ShortOutcomeRow =
      res.status === "unfilled"
        ? { ...base, ...empty, status: "unfilled" }
        : {
            ...base,
            status: "closed",
            entryD: res.entryD,
            entryMicro: res.entryMicro,
            exitD: res.exitD,
            exitMicro: res.exitMicro,
            exitReason: res.exitReason,
            feesMicro: res.feesMicro,
            borrowMicro: res.borrowMicro,
            netMicro: res.netMicro,
            netPpm: res.netPpm,
          };
    await insertShortOutcome(db, row);
    scored += 1;
  }
  return { scored, open };
}
