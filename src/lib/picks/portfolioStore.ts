// D-913 database step of the "Follow the picks" portfolio: read the published picks of the profile with
// their tracked buys, the bars and the strategy signals of those stocks in a few batched queries
// (bounded by the stocks and the window, never OFFSET, D-903), run `simulatePortfolio` and replace the
// stored rows of the profile in one batch. A re-run gives the same rows. Runs after the picks step;
// a failure is reported and never stops the picks.
import type { Client, InStatement } from "@libsql/client";
import { getCostProfile } from "@/lib/arena/costs";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import { priceMicro } from "@/lib/arena/marketData";
import { MIN_MARKETABLE_PARCEL_MICRO } from "@/lib/arena/sizing";
import { addDays } from "@/lib/data/calendar";
import { getConfig } from "@/lib/config/store";
import type { ConfigKey } from "@/lib/config/keys";
import { divFloor } from "@/lib/money/rational";
import { simulatePortfolio, type DatedBar, type PortfolioPick } from "./portfolio";
import { pickActions } from "./track";

/** The profile the portfolio follows (the Picks page's default profile). */
export const PORTFOLIO_PROFILE = "balanced";
const MICRO = 1_000_000n; // threshold-ok: micro-AUD per dollar
const CHUNK = 200; // threshold-ok: codes per batched query
const LOOKBACK_DAYS = 60; // threshold-ok: calendar days of bars before the first pick (the weak average)
export const WEAK_AVERAGE_SESSIONS = 20; // threshold-ok: D-913 weak rule, the 20-session average
export const WEAK_QUIET_SESSIONS = 5; // threshold-ok: D-913 weak rule, sessions without a signal
const ADV_SESSIONS = 20; // threshold-ok: sessions of the traded-value average (slippage)

export type PortfolioRun = { trades: number; open: number; days: number; skipped: number };

const text = (v: unknown): string => String(v);

async function intConfig(db: Client, key: ConfigKey, fallback: number): Promise<number> {
  try {
    const v = await getConfig(db, key);
    return typeof v === "number" && Number.isInteger(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function runPickPortfolio(
  db: Client,
  o: { market: string; d: string; profile?: string; costProfile?: string },
): Promise<PortfolioRun> {
  const profile = o.profile ?? PORTFOLIO_PROFILE;
  const seedAud = await intConfig(db, "picks_portfolio_seed_aud", 5000); // threshold-ok: D-913 config default, only if the read fails
  const slots = await intConfig(db, "picks_portfolio_slots", 5); // threshold-ok: D-913 config default, only if the read fails
  const rows = await db.execute({
    sql: `SELECT p.d, p.rank, p.code, p.stop_micro, p.aim_micro, p.time_frame_sessions,
                 o.entry_d, o.entry_micro
          FROM pick p LEFT JOIN pick_outcome o ON o.market = p.market AND o.d = p.d
            AND o.profile = p.profile AND o.rank = p.rank AND o.kind = 'pick'
          WHERE p.market = ? AND p.profile = ? AND p.d <= ?
          ORDER BY p.d, p.rank`,
    args: [o.market, profile, o.d],
  });
  const picks: PortfolioPick[] = rows.rows.map((r) => ({
    pubD: text(r.d),
    rank: Number(r.rank), // money-float-ok: SQL integer column
    code: text(r.code),
    entryD: r.entry_d === null ? null : text(r.entry_d),
    entryMicro: r.entry_micro === null ? null : BigInt(text(r.entry_micro)),
    stopMicro: BigInt(text(r.stop_micro)),
    aimMicro: BigInt(text(r.aim_micro)),
    timeFrameSessions: Number(r.time_frame_sessions), // money-float-ok: SQL integer column
  }));
  const del: InStatement[] = [
    {
      sql: "DELETE FROM pick_portfolio_trade WHERE market = ? AND profile = ?",
      args: [o.market, profile],
    },
    {
      sql: "DELETE FROM pick_portfolio_day WHERE market = ? AND profile = ?",
      args: [o.market, profile],
    },
  ];
  if (picks.length === 0) {
    await db.batch(del, "write");
    return { trades: 0, open: 0, days: 0, skipped: 0 };
  }
  const firstD = picks[0]!.pubD;
  const from = addDays(firstD, -LOOKBACK_DAYS);
  const codes = [...new Set(picks.map((k) => k.code))].sort();
  const bars = new Map<string, DatedBar[]>();
  const value = new Map<string, bigint[]>();
  const signalDays = new Map<string, Set<string>>();
  for (let i = 0; i < codes.length; i += CHUNK) {
    const part = codes.slice(i, i + CHUNK);
    const marks = part.map(() => "?").join(", ");
    const b = await db.execute({
      sql: `SELECT code, d, o, h, l, c, volume FROM price_bar
            WHERE market = ? AND code IN (${marks}) AND d >= ? AND d <= ? ORDER BY code, d`,
      args: [o.market, ...part, from, o.d],
    });
    for (const x of b.rows) {
      const bar: DatedBar = {
        d: text(x.d),
        openMicro: priceMicro(x.o),
        highMicro: priceMicro(x.h),
        lowMicro: priceMicro(x.l),
        closeMicro: priceMicro(x.c),
      };
      const ok =
        bar.openMicro > 0n &&
        bar.lowMicro > 0n &&
        bar.lowMicro <= bar.openMicro &&
        bar.lowMicro <= bar.closeMicro &&
        bar.highMicro >= bar.openMicro &&
        bar.highMicro >= bar.closeMicro;
      if (!ok) continue; // a malformed bar is unusable evidence (as the pick tracking)
      const code = text(x.code);
      if (!bars.has(code)) bars.set(code, []);
      if (!value.has(code)) value.set(code, []);
      bars.get(code)!.push(bar);
      value.get(code)!.push(bar.closeMicro * BigInt(text(x.volume)));
    }
    const s = await db.execute({
      sql: `SELECT DISTINCT code, d FROM signal
            WHERE market = ? AND code IN (${marks}) AND d >= ? AND d <= ?`,
      args: [o.market, ...part, from, o.d],
    });
    for (const x of s.rows) {
      const code = text(x.code);
      const set = signalDays.get(code) ?? new Set<string>();
      set.add(text(x.d));
      signalDays.set(code, set);
    }
  }
  const advMicro = new Map<string, bigint>();
  for (const [code, v] of value) {
    const last = v.slice(-ADV_SESSIONS);
    advMicro.set(
      code,
      divFloor(
        last.reduce((a, b) => a + b, 0n),
        BigInt(last.length),
      ),
    );
  }
  const confirmed = await loadConfirmedActions(db, o.market, o.d);
  const actions = new Map(codes.map((c) => [c, pickActions(confirmed, c, firstD)]));
  const result = simulatePortfolio(
    { picks, bars, signalDays, actions, advMicro, asOfD: o.d },
    {
      seedMicro: BigInt(seedAud) * MICRO,
      slots,
      minParcelMicro: MIN_MARKETABLE_PARCEL_MICRO,
      weakAverageSessions: WEAK_AVERAGE_SESSIONS,
      weakQuietSessions: WEAK_QUIET_SESSIONS,
      costProfile: getCostProfile(o.costProfile ?? "P5"),
    },
  );
  const stmts: InStatement[] = [...del];
  for (const t of result.trades)
    stmts.push({
      sql: `INSERT INTO pick_portfolio_trade (market, profile, pub_d, rank, code, entry_d, entry_micro,
              qty, cost_micro, exit_d, exit_micro, exit_reason, net_micro)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        o.market,
        profile,
        t.pubD,
        t.rank,
        t.code,
        t.entryD,
        t.entryMicro,
        t.qty,
        t.costMicro,
        t.exitD,
        t.exitMicro,
        t.exitReason,
        t.netMicro,
      ],
    });
  for (const d of result.days)
    stmts.push({
      sql: `INSERT INTO pick_portfolio_day (market, profile, d, cash_micro, holdings_micro, value_micro, holdings)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [o.market, profile, d.d, d.cashMicro, d.holdingsMicro, d.valueMicro, d.holdings],
    });
  await db.batch(stmts, "write");
  return {
    trades: result.trades.length,
    open: result.trades.filter((t) => t.exitD === null).length,
    days: result.days.length,
    skipped: result.skipped.length,
  };
}
