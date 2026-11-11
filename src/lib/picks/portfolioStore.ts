// D-950 database step of "My portfolio": for the three risk profiles, read their published picks with
// the tracked buys and the finished results, the bars, the strategy signals and the strategies'
// closing signals of those stocks in a few batched queries (codes in chunks of 200, bounded by the
// window, never OFFSET, D-903), run `simulatePortfolio` per profile and replace the stored rows of the
// market in one batch. A re-run gives the same rows. Runs after the picks step; a failure is reported
// and never stops the picks.
import type { Client, InStatement } from "@libsql/client";
import { getCostProfile } from "@/lib/arena/costs";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import { priceMicro } from "@/lib/arena/marketData";
import { addDays } from "@/lib/data/calendar";
import { divFloor } from "@/lib/money/rational";
import { familyNames } from "@/lib/review/names";
import { strategyOf } from "./allocation";
import {
  simulatePortfolio,
  type DatedBar,
  type FinishedPick,
  type PortfolioPick,
  type PortfolioResult,
} from "./portfolio";
import {
  loadPortfolioSettings,
  MY_PROFILES,
  pctPpm,
  profileParams,
  type MyProfileName,
} from "./portfolioConfig";
import { strategyNames } from "./portfolioWords";
import { pickActions } from "./track";

const MICRO = 1_000_000n; // threshold-ok: micro-AUD per dollar
const CHUNK = 200; // threshold-ok: codes per batched query
const LOOKBACK_DAYS = 60; // threshold-ok: calendar days of bars before the first pick (the averages)
export const WEAK_AVERAGE_SESSIONS = 20; // threshold-ok: D-913 weak rule, the 20-session average
export const WEAK_QUIET_SESSIONS = 5; // threshold-ok: D-913 weak rule, sessions without a signal
export const SHORTLIST_AVERAGE_SESSIONS = 20; // threshold-ok: D-920 rule SL.v1, close at or above its 20-session average
const ADV_SESSIONS = 20; // threshold-ok: sessions of the traded-value average (slippage)
const DEFAULT_TIME_FRAME = 20; // threshold-ok: D-920 evidence holding limit, for a pick without a time frame

export type PortfolioRun = Record<
  MyProfileName,
  { trades: number; open: number; days: number; splits: number; skipped: number }
>;

const text = (v: unknown): string => String(v);

type PickRow = PortfolioPick & { profile: MyProfileName };

export async function runPickPortfolio(
  db: Client,
  o: { market: string; d: string },
): Promise<PortfolioRun> {
  const settings = await loadPortfolioSettings(db);
  const names = strategyNames(await familyNames(db));
  const marks = MY_PROFILES.map(() => "?").join(", ");
  const rows = await db.execute({
    sql: `SELECT p.profile, p.d, p.rank, p.code, p.family, p.rule_version, p.tier, p.reference_micro,
                 p.stop_micro, p.aim_micro, p.time_frame_sessions,
                 o.entry_d, o.entry_micro, o.state, o.exit_d, o.net_ppm
          FROM pick p LEFT JOIN pick_outcome o ON o.market = p.market AND o.d = p.d
            AND o.profile = p.profile AND o.rank = p.rank AND o.kind = 'pick'
          WHERE p.market = ? AND p.profile IN (${marks}) AND p.d <= ?
          ORDER BY p.profile, p.d, p.rank`,
    args: [o.market, ...MY_PROFILES, o.d],
  });
  const picks: PickRow[] = [];
  const finished = new Map<MyProfileName, FinishedPick[]>();
  for (const r of rows.rows) {
    const strategy = strategyOf(text(r.family), text(r.rule_version));
    if (strategy === null) continue; // a candidate-measure pick is never in the portfolio
    const profile = text(r.profile) as MyProfileName;
    picks.push({
      profile,
      pubD: text(r.d),
      rank: Number(r.rank), // money-float-ok: SQL integer column
      code: text(r.code),
      strategy,
      tier: text(r.tier),
      referenceMicro: BigInt(text(r.reference_micro)),
      entryD: r.entry_d === null ? null : text(r.entry_d),
      entryMicro: r.entry_micro === null ? null : BigInt(text(r.entry_micro)),
      stopMicro: BigInt(text(r.stop_micro)),
      aimMicro: BigInt(text(r.aim_micro)),
      // a pick without a time frame is held to the 20-session evidence limit (as the shortlist)
      timeFrameSessions:
        r.time_frame_sessions === null ? DEFAULT_TIME_FRAME : Number(r.time_frame_sessions), // money-float-ok: SQL integer column
    });
    if (text(r.state) === "closed" && r.exit_d !== null && text(r.exit_d) <= o.d) {
      const list = finished.get(profile) ?? [];
      list.push({ strategy, exitD: text(r.exit_d), netPpm: Number(r.net_ppm) }); // money-float-ok: SQL integer ppm
      finished.set(profile, list);
    }
  }
  const stmts: InStatement[] = [
    { sql: "DELETE FROM pick_portfolio_trade WHERE market = ?", args: [o.market] },
    { sql: "DELETE FROM pick_portfolio_day WHERE market = ?", args: [o.market] },
    { sql: "DELETE FROM pick_portfolio_hold WHERE market = ?", args: [o.market] },
    { sql: "DELETE FROM pick_portfolio_split WHERE market = ?", args: [o.market] },
  ];
  const empty = { trades: 0, open: 0, days: 0, splits: 0, skipped: 0 };
  const out = Object.fromEntries(MY_PROFILES.map((p) => [p, { ...empty }])) as PortfolioRun;
  if (picks.length === 0) {
    await db.batch(stmts, "write");
    return out;
  }
  const firstD = picks.reduce((a, k) => (k.pubD < a ? k.pubD : a), picks[0]!.pubD);
  const from = addDays(firstD, -LOOKBACK_DAYS);
  const codes = [...new Set(picks.map((k) => k.code))].sort();
  const bars = new Map<string, DatedBar[]>();
  const traded = new Map<string, bigint[]>();
  const signalDays = new Map<string, Set<string>>();
  const closeSignals = new Map<string, Set<string>>();
  for (let i = 0; i < codes.length; i += CHUNK) {
    const part = codes.slice(i, i + CHUNK);
    const qs = part.map(() => "?").join(", ");
    const b = await db.execute({
      sql: `SELECT code, d, o, h, l, c, volume FROM price_bar
            WHERE market = ? AND code IN (${qs}) AND d >= ? AND d <= ? ORDER BY code, d`,
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
      if (!traded.has(code)) traded.set(code, []);
      bars.get(code)!.push(bar);
      traded.get(code)!.push(bar.closeMicro * BigInt(text(x.volume)));
    }
    const s = await db.execute({
      sql: `SELECT DISTINCT code, d FROM signal
            WHERE market = ? AND code IN (${qs}) AND d >= ? AND d <= ?`,
      args: [o.market, ...part, from, o.d],
    });
    for (const x of s.rows) {
      const code = text(x.code);
      const set = signalDays.get(code) ?? new Set<string>();
      set.add(text(x.d));
      signalDays.set(code, set);
    }
    // a strategy's closing signal: its own close-signal sale order of the stock (ARN-021), decided at
    // that session's close; read through the cohort index (cohort, decided day), never a full scan
    const c = await db.execute({
      sql: `SELECT DISTINCT e.family, a.code, a.decided_d FROM execution e
            JOIN cohort k ON k.execution_id = e.id
            JOIN arena_order a ON a.cohort_id = k.id AND a.decided_d >= ? AND a.decided_d <= ?
            WHERE e.market = ? AND e.kind = 'E' AND a.kind = 'exit_cs' AND a.code IN (${qs})`,
      args: [from, o.d, o.market, ...part],
    });
    for (const x of c.rows) {
      if (x.family === null) continue;
      const key = `${text(x.family)}|${text(x.code)}`;
      const set = closeSignals.get(key) ?? new Set<string>();
      set.add(text(x.decided_d));
      closeSignals.set(key, set);
    }
  }
  const advMicro = new Map<string, bigint>();
  for (const [code, v] of traded) {
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
  const costProfile = getCostProfile(settings.costProfile);
  for (const profile of MY_PROFILES) {
    const own = picks.filter((k) => k.profile === profile);
    const result = simulatePortfolio(
      {
        picks: own,
        finished: finished.get(profile) ?? [],
        bars,
        signalDays,
        closeSignals,
        actions,
        advMicro,
        asOfD: o.d,
      },
      {
        seedMicro: BigInt(settings.seedAud) * MICRO,
        minParcelMicro: BigInt(settings.minParcelAud) * MICRO,
        strategyCapPpm: pctPpm(settings.strategyMaxPct),
        costMaxPpm: pctPpm(settings.costMaxPct),
        weakAverageSessions: WEAK_AVERAGE_SESSIONS,
        weakQuietSessions: WEAK_QUIET_SESSIONS,
        shortlistAverageSessions: SHORTLIST_AVERAGE_SESSIONS,
        costProfile,
        profile: profileParams(settings, profile),
        names,
      },
    );
    stmts.push(...rowsOf(o.market, profile, result));
    out[profile] = {
      trades: result.trades.length,
      open: result.holdings.length,
      days: result.days.length,
      splits: result.splits.length,
      skipped: result.skipped.length,
    };
  }
  await db.batch(stmts, "write");
  return out;
}

function rowsOf(market: string, profile: string, r: PortfolioResult): InStatement[] {
  const out: InStatement[] = [];
  for (const t of r.trades)
    out.push({
      sql: `INSERT INTO pick_portfolio_trade (market, profile, seq, d, side, code, strategy, pub_d, rank,
              pos, qty, price_micro, fee_micro, net_micro, reason, closes, words)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        market,
        profile,
        t.seq,
        t.d,
        t.side,
        t.code,
        t.strategy,
        t.pubD,
        t.rank,
        t.pos,
        t.qty,
        t.priceMicro,
        t.feeMicro,
        t.netMicro,
        t.reason,
        t.closes ? 1 : 0,
        t.words,
      ],
    });
  for (const h of r.holdings)
    out.push({
      sql: `INSERT INTO pick_portfolio_hold (market, profile, code, pos, strategy, pub_d, entry_d,
              entry_micro, qty, cost_micro) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        market,
        profile,
        h.code,
        h.pos,
        h.strategy,
        h.pubD,
        h.entryD,
        h.entryMicro,
        h.qty,
        h.costMicro,
      ],
    });
  for (const d of r.days)
    out.push({
      sql: `INSERT INTO pick_portfolio_day (market, profile, d, cash_micro, holdings_micro, value_micro,
              holdings, fall_ppm) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        market,
        profile,
        d.d,
        d.cashMicro,
        d.holdingsMicro,
        d.valueMicro,
        d.holdings,
        d.fallPpm,
      ],
    });
  for (const s of r.splits)
    out.push({
      sql: `INSERT INTO pick_portfolio_split (market, profile, d, shares_json, cash_ppm, words)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        market,
        profile,
        s.d,
        JSON.stringify(s.shares.map((x) => ({ strategy: x.strategy, target_ppm: x.targetPpm }))),
        s.cashPpm,
        s.words,
      ],
    });
  return out;
}
