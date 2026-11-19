// A small India night on a real migrated database (M20 IN1): the harness the guard test, the fixture night and the
// isolation test share. Hand-made Rs prices on the IN tick grid, IN enabled in `data_only` (replay mode), IN cohorts
// started from the IN seed (Rs from the FX close, cost profile IN-P1). Nothing touches the network; the IN market
// is enabled in THIS database only (`allowMarket`), never in production.
import type { Client } from "@libsql/client";
import {
  buildExecutionRegistry,
  planInitialStart,
  resolveCohortParams,
  type ParamOverrides,
} from "@/lib/arena/cohort";
import { seedExecutions, startCohorts } from "@/lib/arena/cohortWriter";
import type { FxRow } from "@/lib/arena/seed";
import { addDays, isWeekend, type CalendarRow } from "@/lib/data/calendar";
import { makeRational } from "@/lib/money/rational";
import { allowMarket } from "../../db/helpers";
import { freshReplayDb, NOW } from "../../arena/replayHarness";

export const IN = "IN";
export const IN_NOW = NOW;
/** The activation-day AUD/INR close the seed converts with (D-1107): A$600 x 55.123 = Rs 33,073.8 -> Rs 33,000. */
export const FX: FxRow = { rate: "55.123", date: "2030-01-04", source: "FXRINR" };
export const M = 1_000_000n;

export type InCode = { code: string; base: bigint; volume: bigint };
export const IN_CODES: readonly InCode[] = [
  { code: "INAA", base: 300n * M, volume: 400_000n },
  { code: "INBB", base: 180n * M, volume: 600_000n },
];

export type InNight = {
  readonly db: Client;
  readonly dates: string[];
  readonly calendar: CalendarRow[];
  readonly cohortIds: string[];
  /** bar of `code` on `d`: [open, high, low, close] micro */
  readonly bars: Map<string, [bigint, bigint, bigint, bigint]>;
};

/** Rs prices on the IN grid: Rs 0.05 above Rs 250, Rs 0.01 below. */
const tickOf = (p: bigint): bigint => (p >= 250n * M ? 50_000n : 10_000n);
const onGrid = (p: bigint): bigint => (p / tickOf(p)) * tickOf(p);

export type InNightOptions = {
  sessions?: number;
  startD?: string;
  /** Price rows for (code, session index) -> [o,h,l,c] micro; default a gentle drift. */
  barOf?: (code: InCode, i: number, prevClose: bigint) => [bigint, bigint, bigint, bigint];
  keep?: readonly string[];
  params?: ParamOverrides;
  /** price_band rows to plant: [code, session index, band_pct]. */
  bands?: readonly [string, number, number][];
};

export async function buildInNight(o: InNightOptions = {}): Promise<InNight> {
  const db = await freshReplayDb();
  await allowMarket(db, IN);
  await db.execute({ sql: "UPDATE market SET mode = 'data_only' WHERE code = ?", args: [IN] });
  const n = o.sessions ?? 12;
  const dates: string[] = [];
  for (let day = o.startD ?? "2030-01-07"; dates.length < n; day = addDays(day, 1)) {
    if (!isWeekend(day)) dates.push(day);
  }
  const calendar: CalendarRow[] = [];
  for (const d of dates) {
    await db.execute({
      sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES (?, ?, 'session', NULL, 1, 'synthetic')",
      args: [IN, d],
    });
  }
  const bars = new Map<string, [bigint, bigint, bigint, bigint]>();
  const prev = new Map(IN_CODES.map((c) => [c.code, c.base]));
  for (const [i, d] of dates.entries()) {
    for (const c of IN_CODES) {
      const p = prev.get(c.code)!;
      const bar = o.barOf
        ? o.barOf(c, i, p)
        : ((): [bigint, bigint, bigint, bigint] => {
            const open = onGrid(p + BigInt((i % 3) - 1) * 500_000n);
            const close = onGrid(open + BigInt(((i * 7) % 5) - 2) * 300_000n);
            const hi = (open > close ? open : close) + 400_000n;
            const lo = (open < close ? open : close) - 400_000n;
            return [open, onGrid(hi), onGrid(lo), close];
          })();
      bars.set(`${c.code}|${d}`, bar);
      prev.set(c.code, bar[3]);
      const real = (v: bigint): number => Number(v) / 1e6;
      await db.execute({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_nse_bhavcopy', ?, ?)`,
        args: [
          IN,
          c.code,
          d,
          real(bar[0]),
          real(bar[1]),
          real(bar[2]),
          real(bar[3]),
          c.volume,
          `${d}T10:30:00.000Z`,
          `${d}T11:00:00.000Z`,
        ],
      });
      await db.execute({
        sql: "INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted) VALUES (?, ?, ?, 'active', 'U1', NULL, NULL, 0)",
        args: [IN, d, c.code],
      });
    }
    for (const tier of ["U1", "U2", "U3"]) {
      await db.execute({
        sql: "INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass) VALUES (?, ?, ?, 10, 10, 100, 1)",
        args: [IN, d, tier],
      });
    }
    await db.execute({
      sql: "INSERT INTO completion_marker (market, d, kind, at, run_id, outcome) VALUES (?, ?, 'data', ?, ?, 'ok')",
      args: [IN, d, `${d}T11:30:00.000Z`, i + 1],
    });
  }
  for (const [code, idx, pct] of o.bands ?? []) {
    await db.execute({
      sql: "INSERT INTO price_band (market, code, d, band_pct, lower_micro, upper_micro, source) VALUES (?, ?, ?, ?, NULL, NULL, 'in_nse_bands')",
      args: [IN, code, dates[idx]!, pct],
    });
  }
  const registry = buildExecutionRegistry({ market: IN });
  await seedExecutions(db, registry);
  const keep = o.keep ?? ["E01"];
  const starts = planInitialStart({
    registry,
    startD: dates[1]!,
    paramsFor: () =>
      resolveCohortParams({
        market: IN,
        fxRow: FX,
        terminal: {
          targetMultiple: makeRational(100n),
          bustFraction: makeRational(1n, 100n),
          timeoutSessions: 1000,
          stallFloorMicro: 1n,
        },
        ...o.params,
      }),
    masterSeed: 20_261_011n,
    controlsPerFamily: 1,
  }).filter((s) => keep.includes(s.executionId));
  await startCohorts(db, starts);
  return { db, dates, calendar, cohortIds: starts.map((s) => s.id), bars };
}

export async function placeOrder(
  db: Client,
  o: {
    id: string;
    cohortId: string;
    decidedD: string;
    code: string;
    kind: "entry" | "exit_cs";
    qty: number;
    stop?: bigint;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'U1')`,
    args: [
      o.id,
      o.cohortId,
      o.decidedD,
      o.code,
      o.kind === "entry" ? "buy" : "sell",
      o.kind,
      o.qty,
      o.stop ?? null,
    ],
  });
}
