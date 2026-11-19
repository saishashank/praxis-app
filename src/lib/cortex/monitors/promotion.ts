// CXA-010 monitor 1 (M23 task M1; D-1615): the promotion-flag hit rate and the event-entry result in smaller companies
// against large ones. Hit: a flagged smaller-company code whose 20-session market-adjusted return after the flag is below
// 0. The alarm: the one-sided 90 % block-bootstrap lower bound of (mean net of event entries in the two smaller tiers minus
// the mean net of the large tier) is below 0. The monitor demotes nothing; the Owner acts through the existing status path.
// Pure functions over plain rows, then one loader that reads stored rows (bars, flags, would-have outcomes). Reads only.
import type { Client } from "@libsql/client";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { circularBlockBootstrap, percentile } from "@/lib/stats/bootstrap";
import { scopedPrng } from "@/lib/stats/rng";
import { GATE_DEFAULTS } from "../statusRules.mjs";
import {
  addDays,
  quarterRange,
  quarterlyPeriod,
  r4,
  type MonitorDef,
  type MonitorResult,
} from "./store";

/** The post-flag horizon (D-1615: 20 sessions). */
export const FLAG_HORIZON_SESSIONS = 20; // threshold-ok: D-1615 horizon
/** Bootstrap replicates (the stats default). */
export const MONITOR_REPLICATES = 2000; // threshold-ok: research bootstrap replicates
/** One-sided level of the lower bound (90 %). */
export const MONITOR_ALPHA = 0.1; // threshold-ok: D-1615 one-sided 90 %
/** Below this many setups in either group the bound is not computed (the cell floor of the economic gate). */
export const MIN_SETUPS_PER_GROUP: number = GATE_DEFAULTS.cellMinBlocks;
/** The event-entry families (F2, F3, F5: the rules that need an event). */
export const EVENT_FAMILIES: readonly string[] = ["F2", "F3", "F5"];
/** The alarm sentence (D-1615), plain words. */
export const PROMOTION_ALARM_TEXT =
  "Event entries in smaller companies are losing against large companies: review moving them to shadow";

export type EntryRead = {
  /** Universe tier of the code on the decision day. */
  readonly tier: "U1" | "U2" | "U3";
  /** Net outcome of the would-have entry in parts per million of its entry value. */
  readonly netPpm: number;
  /** Fill session (YYYY-MM-DD), the bootstrap's block axis. */
  readonly session: string;
};

export type PromotionInput = {
  /** The 20-session market-adjusted return of each matured flag, as a fraction. */
  readonly flagReturns: readonly number[];
  readonly entries: readonly EntryRead[];
  /** Seed scope, e.g. "monitor1:<market>:<period>". */
  readonly scope: string;
  readonly replicates?: number;
};

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** True when the lower bound is below zero: the alarm of D-1615 (exactly 0 is not an alarm). */
export const diffAlarm = (lower90: number | null): boolean => lower90 !== null && lower90 < 0;

/** The lower bound (one-sided 90 %) of mean(smaller) - mean(large); null below the group floor. */
export function groupDiffLowerBound(
  entries: readonly EntryRead[],
  scope: string,
  replicates: number = MONITOR_REPLICATES,
): number | null {
  const small = entries.filter((e) => e.tier !== "U1");
  const large = entries.filter((e) => e.tier === "U1");
  if (small.length < MIN_SETUPS_PER_GROUP || large.length < MIN_SETUPS_PER_GROUP) return null;
  const days = [...new Set(entries.map((e) => e.session))].sort();
  const index = new Map(days.map((d, i) => [d, i]));
  const sessions = entries.map((e) => index.get(e.session)!);
  const isSmall = entries.map((e) => (e.tier !== "U1" ? 1 : 0));
  const isLarge = isSmall.map((x) => 1 - x);
  const series = [
    entries.map((e, i) => e.netPpm * isSmall[i]!),
    isSmall,
    entries.map((e, i) => e.netPpm * isLarge[i]!),
    isLarge,
  ];
  const block = Math.min(FLAG_HORIZON_SESSIONS, days.length);
  const r = circularBlockBootstrap(
    { sessions, sessionCount: days.length, block, replicates, series },
    scopedPrng(scope),
  );
  const [a, b, c, d] = r.replicateMeans;
  const diffs: number[] = [];
  for (let i = 0; i < replicates; i += 1) {
    // a replicate that drew no row of one group has no mean for it: left out
    if (b![i]! === 0 || d![i]! === 0) continue;
    const diff = a![i]! / b![i]! - c![i]! / d![i]!;
    diffs.push(Math.round(diff * 1e6) / 1e6); // threshold-ok: float noise below a millionth of a ppm
  }
  if (diffs.length === 0) return null;
  const lower = percentile(diffs, MONITOR_ALPHA);
  return Number.isFinite(lower) ? lower : null;
}

/** Monitor 1 from plain rows. */
export function promotionMonitor(input: PromotionInput): MonitorResult {
  const hits = input.flagReturns.filter((x) => x < 0).length;
  const small = input.entries.filter((e) => e.tier !== "U1").map((e) => e.netPpm);
  const large = input.entries.filter((e) => e.tier === "U1").map((e) => e.netPpm);
  const lower = groupDiffLowerBound(input.entries, input.scope, input.replicates);
  const diff = small.length > 0 && large.length > 0 ? mean(small) - mean(large) : null;
  const alarm = diffAlarm(lower);
  return {
    value: {
      flags: {
        matured: input.flagReturns.length,
        hits,
        hit_rate: input.flagReturns.length === 0 ? null : r4(hits / input.flagReturns.length),
      },
      entries: {
        smaller_n: small.length,
        smaller_mean_ppm: small.length === 0 ? null : r4(mean(small)),
        large_n: large.length,
        large_mean_ppm: large.length === 0 ? null : r4(mean(large)),
        diff_ppm: diff === null ? null : r4(diff),
        lower90_ppm: lower === null ? null : r4(lower),
        floor_per_group: MIN_SETUPS_PER_GROUP,
      },
    },
    alarm,
    ownerItems: alarm ? [PROMOTION_ALARM_TEXT] : [],
  };
}

const LOOK_BACK_DAYS = 90; // threshold-ok: calendar days that hold 20 sessions before a quarter

/** Reads the matured flags and the event entries that closed in the quarter. Read only. */
export async function loadPromotionInput(
  db: Client,
  market: string,
  period: string,
): Promise<PromotionInput> {
  const { from, to } = quarterRange(period);
  const benchmark = staticProfile(market).benchmarkIndex;
  const back = addDays(from, -LOOK_BACK_DAYS);
  // rows-ok: sessions of one quarter plus the look-back for the horizon; about 130, capped at 400
  const cal = await db.execute({
    sql: `SELECT d FROM trading_calendar WHERE market = ? AND kind IN ('session','early_close')
          AND d >= ? AND d <= ? ORDER BY d LIMIT 400`,
    args: [market, back, to],
  });
  const sessions = cal.rows.map((r) => String(r.d));
  const at = new Map(sessions.map((d, i) => [d, i]));
  // rows-ok: promotion flags that began in the look-back window; capped at 500
  const fl = await db.execute({
    sql: `SELECT code, from_d FROM cortex_state WHERE market = ? AND kind = 'promotion' AND state = 'flagged'
          AND from_d >= ? AND from_d <= ? ORDER BY from_d, code LIMIT 500`,
    args: [market, back, to],
  });
  // rows-ok: index closes of one quarter plus the look-back; about 130, capped at 400
  const ix = await db.execute({
    sql: `SELECT d, c_micro FROM index_bar WHERE market = ? AND index_code = ? AND d >= ? AND d <= ?
          ORDER BY d LIMIT 400`,
    args: [market, benchmark, back, to],
  });
  const idx = new Map(ix.rows.map((r) => [String(r.d), Number(r.c_micro)]));
  const flagReturns: number[] = [];
  for (const f of fl.rows) {
    const i = at.get(String(f.from_d));
    if (i === undefined) continue;
    const readD = sessions[i + FLAG_HORIZON_SESSIONS];
    if (readD === undefined || readD < from || readD > to) continue;
    // rows-ok: two closes of one code (primary-key reads); at most two rows
    const bars = await db.execute({
      sql: "SELECT d, c FROM price_bar WHERE market = ? AND code = ? AND d IN (?, ?)",
      args: [market, String(f.code), String(f.from_d), readD],
    });
    const c = new Map(bars.rows.map((r) => [String(r.d), Number(r.c)]));
    const c0 = c.get(String(f.from_d));
    const c1 = c.get(readD);
    const i0 = idx.get(String(f.from_d));
    const i1 = idx.get(readD);
    if (!c0 || !c1 || !i0 || !i1) continue;
    flagReturns.push(c1 / c0 - 1 - (i1 / i0 - 1));
  }
  // event-entry would-have outcomes that closed in the quarter, live arm first so a pair counts once
  const ph = EVENT_FAMILIES.map(() => "?").join(", ");
  // rows-ok: filled event-entry outcomes closed in one quarter; capped at 5000
  const en = await db.execute({
    sql: `SELECT o.fill_d, o.net_micro, o.fill_micro, c.qty, c.d AS dd, c.code, c.family, u.tier
          FROM cortex_outcome o
          JOIN cortex_decision c ON c.market = o.market AND c.d = o.d AND c.book_id = o.book_id
            AND c.code = o.code AND c.arm = o.arm
          JOIN universe_snapshot u ON u.market = c.market AND u.d = c.d AND u.code = c.code
          WHERE o.market = ? AND o.fill_status = 'filled' AND o.exit_d >= ? AND o.exit_d <= ?
            AND c.family IN (${ph}) AND o.net_micro IS NOT NULL AND c.qty > 0
          ORDER BY o.exit_d, c.code, o.arm LIMIT 5000`,
    args: [market, from, to, ...EVENT_FAMILIES],
  });
  const seen = new Set<string>();
  const entries: EntryRead[] = [];
  for (const r of en.rows) {
    const key = `${String(r.dd)}|${String(r.code)}|${String(r.family)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = Number(r.fill_micro) * Number(r.qty);
    if (!(value > 0)) continue;
    const tier = String(r.tier);
    if (tier !== "U1" && tier !== "U2" && tier !== "U3") continue;
    entries.push({
      tier,
      netPpm: (Number(r.net_micro) / value) * 1e6, // threshold-ok: parts per million
      session: String(r.fill_d),
    });
  }
  return { flagReturns, entries, scope: `monitor1:${market}:${period}` };
}

export const promotionDef: MonitorDef = {
  monitor: 1,
  period: quarterlyPeriod,
  async compute(db, market, period) {
    return promotionMonitor(await loadPromotionInput(db, market, period));
  },
};
