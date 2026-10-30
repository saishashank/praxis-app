// VAL-114 daily rank quality: the shared computation, the nightly (batch 3) writer and the weekly
// backfill stage (M14, D-232; docs/M14_design.md 2.2). Descriptive only: nothing here changes a rule,
// a trial or a label. Live and replay call the same pure functions (`icRowsForDay`), so the IC of a day
// that both computed is identical (the parity test).
//
//   icRowsForDay    for one decision session D: the scores of every (family, rank variant) spec and their
//                   Spearman IC against the close(D+1) -> close(D+2) excess over the U1 median.
//   liveRankIc      batch 3 stage 6: D' = two sessions before the run date; rebuilds D' inputs read-only
//                   (`loadDayInputs`), inserts `rank_ic_daily` rows (source `live`) and returns the bootstrap
//                   summaries as `replay_stat` payloads.
//   rankIcStage     the weekly learning stage `rankIc`: backfills `rank_ic_daily` (source `replay`) from
//                   `SnapshotWorld.familyInputs(d)`; rows are insert-or-ignore on (market, family,
//                   rank_variant, d).
import type { Client } from "@libsql/client";
import { rankScoresWith, type RankVariant } from "@/lib/agents/families/rankScore";
import { createContext } from "@/lib/agents/families/context";
import type { FamilyInputs } from "@/lib/agents/families/types";
import { FAMILY_ORDER } from "@/lib/agents/families/constants";
import {
  adjustBars,
  loadDayInputs,
  splitActionsByCode,
  type SplitAction,
} from "@/lib/agents/candidates";
import type { ViewBar } from "@/lib/agents/decisionView";
import { microToFloat } from "@/lib/agents/indicators";
import type { AgentParams } from "@/lib/agents/params";
import type { Family } from "@/lib/agents/schema";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import { priceMicro } from "@/lib/arena/marketData";
import { previousTradingDay, type CalendarRow, type MarketHours } from "@/lib/data/calendar";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { dailyRankIc, RANK_IC_BLOCK_SESSIONS, summariseRankIc } from "@/lib/stats/rankIc";
import type { RankIcStat } from "@/lib/stats/robustnessTypes";
import type { StageOutput } from "./weeklyRun";
import type { WeeklyContext } from "./weeklyStages";

/** One (family, rank variant) the IC is computed for: the v1 keys, plus the KB-081 variants of F1/F4. */
export type RankSpec = { readonly family: Family; readonly variant: RankVariant };

export const RANK_SPECS: readonly RankSpec[] = [
  ...FAMILY_ORDER.map((family) => ({ family, variant: "v1" as const })),
  { family: "F1", variant: "composite3" },
  { family: "F1", variant: "vol_scaled" },
  { family: "F4", variant: "composite3" },
  { family: "F4", variant: "vol_scaled" },
];

export type DayIc = {
  readonly family: Family;
  readonly rankVariant: RankVariant;
  readonly n: number;
  readonly ic: number | null;
};

/** close(D+1) -> close(D+2) return on split-adjusted closes (null without both bars or a zero close). */
export function forwardReturn(
  bar1: ViewBar | null,
  bar2: ViewBar | null,
  splits: readonly SplitAction[],
): number | null {
  if (bar1 === null || bar2 === null) return null;
  const [a, b] = adjustBars([bar1, bar2], splits);
  if (a === undefined || b === undefined || a.close <= 0n) return null;
  return microToFloat(b.close) / microToFloat(a.close) - 1;
}

/** The ICs of every spec for the session of `inputs`, given each code's forward return. */
export function icRowsForDay(
  inputs: FamilyInputs,
  params: AgentParams,
  forward: ReadonlyMap<string, number>,
): DayIc[] {
  const ctx = createContext(inputs, params);
  const u1 = ctx.codes.filter((c) => c.tier === "U1").map((c) => c.code);
  const minCodes = params.stats.rankIcMinCodes;
  return RANK_SPECS.map(({ family, variant }) => {
    const r = dailyRankIc(rankScoresWith(ctx, family, variant), forward, u1, minCodes);
    return { family, rankVariant: variant, n: r.n, ic: r.ic };
  });
}

const lineageOf = (market: string, family: string): string => `${market}:${family}`;

/** `replay_stat` scope of a rank_ic summary: `<market>:<family>:<rank_variant>` (WP8 loader contract). */
export function rankIcScope(market: string, family: string, variant: string): string {
  return `${lineageOf(market, family)}:${variant}`;
}

/** Bootstrap summary of an IC series (oldest first), seeded by `rank_ic:<lineage>[:variant]`. */
export function rankIcStat(
  market: string,
  family: string,
  variant: string,
  ics: readonly number[],
  params: AgentParams,
): RankIcStat {
  const lineage = lineageOf(market, family);
  const s = summariseRankIc(ics, {
    scope: variant === "v1" ? `rank_ic:${lineage}` : `rank_ic:${lineage}:${variant}`,
    block: RANK_IC_BLOCK_SESSIONS[params.stats.rankIcBootstrapBlocks],
    replicates: params.stats.rankIcBootstrapReplicates,
  });
  return {
    family,
    rank_variant: variant,
    n_days: s.nDays,
    median_ic: s.medianIc,
    mean_ic: s.meanIc,
    lower90: s.lower90,
    upper90: s.upper90,
  };
}

async function insertDay(
  db: Client,
  market: string,
  d: string,
  rows: readonly DayIc[],
  source: "live" | "replay",
  computedAt: string,
): Promise<number> {
  return insertRows(
    db,
    rows.map((r) => ({ ...r, d })),
    market,
    source,
    computedAt,
  );
}

/** Rows per write batch: one round trip per chunk instead of one per row (replay backfills years). */
const INSERT_CHUNK = 500;

async function insertRows(
  db: Client,
  rows: readonly (DayIc & { d: string })[],
  market: string,
  source: "live" | "replay",
  computedAt: string,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const res = await db.batch(
      rows.slice(i, i + INSERT_CHUNK).map((r) => ({
        sql: `INSERT INTO rank_ic_daily (market, family, rank_variant, d, n, ic, source, computed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [market, r.family, r.rankVariant, r.d, r.n, r.ic, source, computedAt],
      })),
      "write",
    );
    for (const x of res) written += x.rowsAffected;
  }
  return written;
}

/** Every stored IC of a spec, oldest first (days below the minimum code count have none). */
async function storedSeries(
  db: Client,
  market: string,
  family: string,
  variant: string,
): Promise<number[]> {
  const rs = await db.execute({
    sql: `SELECT ic FROM rank_ic_daily WHERE market = ? AND family = ? AND rank_variant = ?
          AND ic IS NOT NULL ORDER BY d`,
    args: [market, family, variant],
  });
  return rs.rows.map((r) => Number(r.ic));
}

export type LiveRankIcResult = {
  readonly rows: number;
  /** `{ scope, value }` of the bootstrap summaries to write as `replay_stat` metric `rank_ic`. */
  readonly stats: readonly { readonly scope: string; readonly value: RankIcStat }[];
};

/**
 * Batch 3 stage 6. For D' = two sessions before `d` it rebuilds D' inputs (read only), computes the
 * IC of every spec against the D'+1 -> D'+2 return and inserts the `rank_ic_daily` rows (source
 * `live`). Returns the bootstrap summary of each spec over all stored days.
 */
export async function liveRankIc(
  db: Client,
  o: {
    readonly market: string;
    readonly d: string;
    readonly calendar: readonly CalendarRow[];
    readonly hours: MarketHours;
    readonly params: AgentParams;
    readonly replay: boolean;
    readonly now: string;
  },
): Promise<LiveRankIcResult> {
  const d1 = previousTradingDay(o.d, [...o.calendar]);
  const d0 = previousTradingDay(d1, [...o.calendar]);
  let rows = 0;
  const day = await loadDayInputs(db, {
    market: o.market,
    d: d0,
    calendar: o.calendar,
    hours: o.hours,
    params: o.params,
    replay: o.replay,
    heldCodes: [],
    actions: await loadConfirmedActions(db, o.market, d0),
  });
  if (day.inputs.codes.length > 0) {
    const bars = await db.execute({
      sql: `SELECT code, d, o, h, l, c, volume FROM price_bar WHERE market = ? AND d IN (?, ?)`,
      args: [o.market, d1, o.d],
    });
    const byDay = new Map<string, Map<string, ViewBar>>();
    for (const r of bars.rows) {
      const m = byDay.get(String(r.d)) ?? new Map<string, ViewBar>();
      m.set(String(r.code), {
        d: String(r.d),
        open: priceMicro(r.o),
        high: priceMicro(r.h),
        low: priceMicro(r.l),
        close: priceMicro(r.c),
        volume: BigInt(r.volume as number | bigint),
      });
      byDay.set(String(r.d), m);
    }
    const splits = splitActionsByCode(await loadConfirmedActions(db, o.market, o.d)).byCode;
    const forward = new Map<string, number>();
    for (const c of day.inputs.codes) {
      const f = forwardReturn(
        byDay.get(d1)?.get(c.code) ?? null,
        byDay.get(o.d)?.get(c.code) ?? null,
        splits.get(c.code) ?? [],
      );
      if (f !== null) forward.set(c.code, f);
    }
    rows = await insertDay(
      db,
      o.market,
      d0,
      icRowsForDay(day.inputs, o.params, forward),
      "live",
      o.now,
    );
  }
  const stats: { scope: string; value: RankIcStat }[] = [];
  for (const { family, variant } of RANK_SPECS) {
    const series = await storedSeries(db, o.market, family, variant);
    if (series.length === 0) continue;
    stats.push({
      scope: rankIcScope(o.market, family, variant),
      value: rankIcStat(o.market, family, variant, series, o.params),
    });
  }
  return { rows, stats };
}

/**
 * Weekly stage `rankIc`: backfill of the daily rank quality from the replay world. Every session with
 * two later sessions gets its rows (insert-or-ignore, source `replay`); the summaries are computed from
 * the replay series in memory, so they do not depend on what the live batch wrote.
 */
export async function rankIcStage(c: WeeklyContext): Promise<StageOutput> {
  const { world, db, market, params } = c;
  const sessions = world.sessions;
  const series = new Map<string, number[]>();
  const computedAt = `${c.d}T00:00:00Z`;
  // A code's split list does not depend on the session: build it once per run.
  const splitsOf = new Map<string, ReturnType<typeof forwardSplits>>();
  const forwardSplits = (code: string) =>
    splitActionsByCode(world.corpActions(code) as readonly CorpActionRecord[]).byCode.get(code) ??
    [];
  const pending: (DayIc & { d: string })[] = [];
  for (let i = 0; i + 2 < sessions.length; i += 1) {
    const d = sessions[i]!;
    const inputs = world.familyInputs(d);
    if (inputs.codes.length === 0) continue;
    const forward = new Map<string, number>();
    for (const code of inputs.codes.map((x) => x.code)) {
      let splits = splitsOf.get(code);
      if (splits === undefined) {
        splits = forwardSplits(code);
        splitsOf.set(code, splits);
      }
      const f = forwardReturn(
        world.bar(code, sessions[i + 1]!),
        world.bar(code, sessions[i + 2]!),
        splits,
      );
      if (f !== null) forward.set(code, f);
    }
    const rows = icRowsForDay(inputs, params, forward);
    for (const r of rows) pending.push({ ...r, d });
    for (const r of rows) {
      if (r.ic === null) continue;
      const key = `${r.family}|${r.rankVariant}`;
      const list = series.get(key);
      if (list === undefined) series.set(key, [r.ic]);
      else list.push(r.ic);
    }
  }
  await insertRows(db, pending, market, "replay", computedAt);
  const stats = RANK_SPECS.flatMap(({ family, variant }) => {
    const ics = series.get(`${family}|${variant}`);
    if (ics === undefined) return [];
    return [
      {
        scope: rankIcScope(market, family, variant),
        metric: "rank_ic",
        value: rankIcStat(market, family, variant, ics, params),
      },
    ];
  });
  return { stats };
}
