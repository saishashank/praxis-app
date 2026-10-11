// Synthetic dataset, cohorts and a test strategy for the daily-orchestrator replay tests (M3 T10;
// AT-12, AT-13, TST-102, TST-109). Test support only. Everything is synthetic: codes ZZA..ZZE, a
// seeded random walk, a calendar in 2030..2032 that the real calendar seed (2026-2027) does not
// touch. It goes through the REAL migrations into a local libSQL file in WAL mode (a durable write
// costs about 10 ms on this disk otherwise).
//
// The strategy is the stand-in for batch 2b (family signals are M4): after the books of `d` are
// closed it writes, per healthy cohort, simple deterministic orders for the next open. It uses the
// real sizing (sizeEntry) and the real ledger readers, so cohorts behave like cohorts.
import { createClient, type Client } from "@libsql/client";
import { COST_PROFILES } from "@/lib/arena/costs";
import {
  buildExecutionRegistry,
  createPrng,
  planInitialStart,
  resolveCohortParams,
  type ParamOverrides,
} from "@/lib/arena/cohort";
import { loadCohort, seedExecutions, startCohorts } from "@/lib/arena/cohortWriter";
import { loadSleeveConfig, type CloseBooksResult } from "@/lib/arena/closeBooks";
import { loadQtyAdjustments } from "@/lib/arena/corpActionWriter";
import { availableCash, balancesFromRows, pendingSettlements } from "@/lib/arena/ledger";
import { loadLedgerFills, loadLedgerRows, toBig } from "@/lib/arena/ledgerWriter";
import { derivePositions } from "@/lib/arena/nav";
import { rejectReasonText, sizeEntry } from "@/lib/arena/sizing";
import { sleeveMarginMicro } from "@/lib/arena/sleeve";
import { feeFor } from "@/lib/arena/costs";
import { addDays, isWeekend, type CalendarRow } from "@/lib/data/calendar";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { makeRational } from "@/lib/money/rational";
import { MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { rng } from "./ledgerHarness";
import { checkCohortBooks, type Violation } from "@/lib/arena/invariants";
import { createMarketData } from "@/lib/arena/marketData";
import { loadNavDays } from "@/lib/arena/ledgerWriter";
import type { CohortBooks, Mark } from "@/lib/arena/nav";
import { openRealTradeAt, sleeveLiquidationCostMicro, sleeveUnrealAt } from "@/lib/arena/sleeve";
import { loadSleeveStates, loadSleeveTrades } from "@/lib/arena/sleeveWriter";
import { parseCohortParams } from "@/lib/arena/cohort";

export const MARKET = "AU";
export const CODES = ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"] as const;
export type SynthCode = (typeof CODES)[number];
export const MASTER_SEED = 20_261_011n;
export const NOW = () => "2031-01-01T00:00:00.000Z";

type CodeSpec = {
  tier: "U1" | "U2";
  /** Starting price, micro-AUD. */
  base: bigint;
  /** Shares per session. */
  volume: bigint;
  /** Daily gap and intraday swing in basis points (+/-). */
  gap: number;
  swing: number;
};

const SPEC: Record<SynthCode, CodeSpec> = {
  ZZA: { tier: "U1", base: 12_000_000n, volume: 6_000_000n, gap: 90, swing: 180 },
  ZZB: { tier: "U1", base: 8_000_000n, volume: 4_000_000n, gap: 120, swing: 240 },
  ZZC: { tier: "U1", base: 30_000_000n, volume: 3_000_000n, gap: 100, swing: 200 },
  ZZD: { tier: "U2", base: 6_000_000n, volume: 150_000n, gap: 260, swing: 420 },
  ZZE: { tier: "U2", base: 4_000_000n, volume: 120_000n, gap: 320, swing: 520 },
};

const HOLIDAYS = ["01-01", "01-26", "04-25", "12-25", "12-26"];
const TEN_K = 10_000n;
const roundTick = (v: bigint): bigint => (v / TEN_K) * TEN_K;
const FLOOR = 2_000_000n;

export type Dataset = {
  readonly dates: string[];
  readonly closes: Map<string, bigint>;
  readonly halted: Set<string>;
  readonly spec: typeof SPEC;
  readonly calendar: CalendarRow[];
};

const urls = new WeakMap<Client, string>();
/** The file: URL of a harness database (the CLI tests open their own connection to it). */
export const dbUrlOf = (db: Client): string => urls.get(db) as string;

export async function freshReplayDb(): Promise<Client> {
  const url = tempDbUrl();
  const db = track(createClient({ url, intMode: "bigint" }));
  urls.set(db, url);
  await db.execute("PRAGMA journal_mode=WAL");
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  return db;
}

async function insertAll(db: Client, sql: string, rows: unknown[][], chunk = 400): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await db.batch(
      rows.slice(i, i + chunk).map((args) => ({ sql, args: args as never })),
      "write",
    );
  }
}

export type DatasetOptions = {
  startD: string;
  sessions: number;
  seed: number;
  /** Session indexes of the synthetic events (ignored when beyond the range). */
  haltFrom?: number;
  haltTo?: number;
  splitAt?: number;
  dividendAt?: number;
  gateFailEvery?: number;
  /** Bars dated after this session index are written with this price multiplier (look-ahead poison). */
  poisonAfter?: number;
  /** Do not write bars/snapshots/markers after this session index (the future does not exist). */
  stopAfter?: number;
};

export async function buildDataset(db: Client, o: DatasetOptions): Promise<Dataset> {
  const r = rng(o.seed);
  const cal: CalendarRow[] = [];
  const dates: string[] = [];
  const calRows: unknown[][] = [];
  for (let day = o.startD; dates.length < o.sessions + 6; day = addDays(day, 1)) {
    if (isWeekend(day)) continue;
    const md = day.slice(5);
    if (HOLIDAYS.includes(md)) {
      cal.push({ d: day, kind: "holiday", close_time: null, confirmed: 1 });
      calRows.push([MARKET, day, "holiday", null, 1, "synthetic"]);
      continue;
    }
    if (md === "12-24") {
      cal.push({ d: day, kind: "early_close", close_time: "14:10", confirmed: 1 });
      calRows.push([MARKET, day, "early_close", "14:10", 1, "synthetic"]);
    }
    dates.push(day);
  }
  const sessions = dates.slice(0, o.sessions);
  await insertAll(
    db,
    `INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES (?, ?, ?, ?, ?, ?)`,
    calRows,
  );

  const closes = new Map<string, bigint>();
  const halted = new Set<string>();
  const bars: unknown[][] = [];
  const snaps: unknown[][] = [];
  const scores: unknown[][] = [];
  const markers: unknown[][] = [];
  const prev = new Map<SynthCode, bigint>(CODES.map((c) => [c, SPEC[c].base]));
  const poison = o.poisonAfter ?? Number.POSITIVE_INFINITY;
  const stop = o.stopAfter ?? Number.POSITIVE_INFINITY;
  sessions.forEach((d, i) => {
    if (i > stop) return;
    for (const code of CODES) {
      const spec = SPEC[code];
      let p = prev.get(code) as bigint;
      if (code === "ZZC" && o.splitAt === i) p = roundTick(p / 2n); // 2-for-1: raw prices halve
      const isHalted =
        code === "ZZE" && o.haltFrom !== undefined && i >= o.haltFrom && i < (o.haltTo ?? 0);
      snaps.push([MARKET, d, code, "active", spec.tier, null, null, isHalted ? 1 : 0]);
      if (isHalted) {
        halted.add(`${d}|${code}`);
        prev.set(code, p);
        continue;
      }
      const gap = (p * BigInt(r.int(-spec.gap, spec.gap))) / 10_000n;
      let open = roundTick(p + gap);
      if (open < FLOOR) open = FLOOR;
      let close = roundTick(open + (open * BigInt(r.int(-spec.swing, spec.swing))) / 10_000n);
      if (close < FLOOR) close = FLOOR;
      const high = (open > close ? open : close) + BigInt(r.int(0, 6)) * TEN_K;
      let low = (open < close ? open : close) - BigInt(r.int(0, 6)) * TEN_K;
      if (low < FLOOR) low = FLOOR;
      prev.set(code, close);
      closes.set(`${d}|${code}`, close);
      const k = i > poison ? 1000n : 1n; // look-ahead poison: wildly wrong future prices
      const real = (v: bigint): number => Number(v * k) / 1e6;
      bars.push([
        MARKET,
        code,
        d,
        real(open),
        real(high),
        real(low),
        real(close),
        spec.volume + BigInt(r.int(0, 1000)),
        "synthetic",
        `${d}T06:30:00.000Z`,
        `${d}T07:00:00.000Z`,
      ]);
    }
    const fail = o.gateFailEvery !== undefined && i > 0 && i % o.gateFailEvery === 0;
    for (const tier of ["U1", "U2", "U3"]) {
      scores.push([MARKET, d, tier, 10, 10, 100, tier === "U1" && fail ? 0 : 1]);
    }
    markers.push([MARKET, d, "data", `${d}T07:30:00.000Z`, i + 1, "ok"]);
  });
  await insertAll(
    db,
    `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bars,
  );
  await insertAll(
    db,
    `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    snaps,
  );
  await insertAll(
    db,
    `INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    scores,
  );
  await insertAll(
    db,
    `INSERT INTO completion_marker (market, d, kind, at, run_id, outcome) VALUES (?, ?, ?, ?, ?, ?)`,
    markers,
  );
  const action = async (
    code: string,
    type: string,
    exIndex: number,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (exIndex >= sessions.length) return;
    const exD = sessions[exIndex];
    const res = await db.execute({
      sql: `INSERT INTO corporate_action (market, code, type, ex_date, record_date, payload_json, evidence_json)
            VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      args: [MARKET, code, type, exD, JSON.stringify(payload)],
    });
    await db.execute({
      sql: `INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (?, ?, 'auto_confirmed', 'synthetic', NULL)`,
      args: [res.lastInsertRowid as never, `${exD}T00:00:00.000Z`],
    });
  };
  if (o.dividendAt !== undefined) {
    const idx = o.dividendAt;
    await action("ZZB", "cash_dividend", idx, {
      dps: "0.12",
      pay_date: addDays(sessions[Math.min(idx, sessions.length - 1)], 10),
    });
    await action("ZZA", "cash_dividend", idx + 380, {
      dps: "0.20",
      pay_date: addDays(sessions[Math.min(idx + 380, sessions.length - 1)], 9),
    });
  }
  if (o.splitAt !== undefined) await action("ZZC", "split", o.splitAt, { new: 2, old: 1 });
  return { dates: sessions, closes, halted, spec: SPEC, calendar: cal };
}

/** Terminal thresholds tuned so every terminal kind occurs inside three synthetic years. */
export function terminalOverrides(): ParamOverrides {
  return {
    terminal: {
      targetMultiple: makeRational(106n, 100n),
      bustFraction: makeRational(4n, 5n),
      timeoutSessions: 130,
      stallSessions: 5,
      stallFloorMicro: 500_000_000n,
    },
  };
}

const CONSERVATIVE = new Set(["E02", "E04"]);

export function paramOverridesFor(executionId: string): ParamOverrides {
  return {
    ...terminalOverrides(),
    settlementMode: CONSERVATIVE.has(executionId) ? "conservative" : "matched",
  };
}

/** Thresholds nothing reaches: a cohort that only holds what the test gives it. */
export const NO_TERMINAL: ParamOverrides = {
  terminal: {
    targetMultiple: makeRational(100n),
    bustFraction: makeRational(1n, 100n),
    timeoutSessions: 1000,
    stallFloorMicro: 1n,
  },
};

export const KEEP_EXECUTIONS = ["E01", "E02"];

export async function startReplayCohorts(
  db: Client,
  startD: string,
  keep: readonly string[] = KEEP_EXECUTIONS,
  extra: ParamOverrides = {},
): Promise<string[]> {
  const registry = buildExecutionRegistry();
  await seedExecutions(db, registry);
  const starts = planInitialStart({
    registry,
    startD,
    paramsFor: (e) => {
      const base = paramOverridesFor(e.id);
      return resolveCohortParams({
        ...base,
        ...extra,
        terminal: { ...base.terminal, ...extra.terminal },
        costProfile: "P5",
      });
    },
    masterSeed: MASTER_SEED,
    controlsPerFamily: 1,
  }).filter((s) => keep.includes(s.executionId));
  await startCohorts(db, starts);
  return starts.map((s) => s.id);
}

export type FullSetup = { db: Client; ds: Dataset; cohortIds: string[] };

export async function setupReplay(
  o: DatasetOptions & {
    keep?: readonly string[];
    startIndex?: number;
    /** Overrides for the cohorts started now (restarts use paramOverridesFor). */
    params?: ParamOverrides;
  },
): Promise<FullSetup> {
  const db = await freshReplayDb();
  const ds = await buildDataset(db, o);
  const cohortIds = await startReplayCohorts(db, ds.dates[o.startIndex ?? 1], o.keep, o.params);
  return { db, ds, cohortIds };
}

/** Put the market into a mode (the migration seeds AU as data_only). */
export async function setMode(db: Client, mode: "off" | "data_only" | "full"): Promise<void> {
  await db.execute({ sql: "UPDATE market SET mode = ? WHERE code = ?", args: [mode, MARKET] });
}

// ---- the test strategy (stand-in for batch 2b) ---------------------------------------------------------------

export function makeStrategy(db: Client, ds: Dataset) {
  const index = new Map(ds.dates.map((d, i) => [d, i]));
  const known = new Map<string, NonNullable<Awaited<ReturnType<typeof loadCohort>>>>();
  const ended = new Set<string>();
  return async (d: string, result: CloseBooksResult): Promise<void> => {
    if (result.status !== "success" && result.status !== "degraded") return;
    const calendar = ds.calendar;
    for (const id of result.terminal) ended.add(id);
    for (const cohortId of result.closed) {
      if (ended.has(cohortId)) continue;
      let cohort = known.get(cohortId);
      if (cohort === undefined) {
        const loaded = await loadCohort(db, cohortId);
        if (loaded === null) continue;
        cohort = loaded;
        known.set(cohortId, loaded);
      }
      if (cohort.terminalKind !== null) continue;
      const prng = createPrng(cohort.rngSeed + BigInt(index.get(d) ?? 0) * 7_919n);
      const exitRoll = prng.below(9n) === 0n;
      const entryRoll = prng.below(5n) === 0n;
      const codeRoll = Number(prng.below(BigInt(CODES.length)));
      if (!exitRoll && !entryRoll) continue;
      const state = await db.execute({
        sql: `SELECT (SELECT COUNT(*) FROM arena_order WHERE cohort_id = ? AND status = 'pending') AS pending,
                     (SELECT open_positions FROM nav_daily WHERE cohort_id = ? AND d = ?) AS open_positions`,
        args: [cohortId, cohortId, d],
      });
      if (toBig(state.rows[0].pending) > 0n) continue;
      const holding = toBig(state.rows[0].open_positions) > 0n;
      if (holding) {
        if (!exitRoll) continue;
        const [fills, adjustments] = await Promise.all([
          loadLedgerFills(db, cohortId),
          loadQtyAdjustments(db, cohortId),
        ]);
        const [code, qty] = [...derivePositions(fills, adjustments, d).positions.entries()][0];
        await db.execute({
          sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty)
                VALUES (?, ?, ?, ?, 'sell', 'exit_cs', ?)`,
          args: [`X:${cohortId}:${d}:${code}`, cohortId, d, code, qty],
        });
        continue;
      }
      if (!entryRoll) continue;
      const fills = await loadLedgerFills(db, cohortId);
      const code = CODES[codeRoll];
      const close = ds.closes.get(`${d}|${code}`);
      if (close === undefined) continue; // halted / no bar today
      const spec = ds.spec[code];
      const nav = await db.execute({
        sql: "SELECT nav_micro FROM nav_daily WHERE cohort_id = ? AND d = ?",
        args: [cohortId, d],
      });
      const rows = await loadLedgerRows(db, cohortId);
      const settled = new Set(
        rows.filter((x) => x.kind === "settle" && x.refType === "fill").map((x) => String(x.refId)),
      );
      const params = JSON.parse(cohort.paramsJson) as {
        params: { settlement_mode: string; cost_profile: string };
      };
      const cash = availableCash({
        mode: params.params.settlement_mode === "conservative" ? "conservative" : "matched",
        balances: balancesFromRows(rows, d),
        pending: pendingSettlements(fills, settled, calendar),
        sessionD: d,
      });
      const cfg = await loadSleeveConfig(db, cohortId);
      const navMicro = toBig(nav.rows[0].nav_micro);
      let reserve = 0n;
      if (cfg !== null) {
        const margin = sleeveMarginMicro(navMicro, cfg);
        if (margin > 0n) reserve = margin + feeFor(cfg.profile, margin * cfg.leverage, "buy");
      }
      const sizing = sizeEntry({
        settledCashMicro: cash,
        navMicro,
        sleeveMarginMicro: reserve,
        refPriceMicro: close,
        advValueMicro: close * spec.volume,
        adv20Shares: spec.volume,
        tier: spec.tier,
        profile: COST_PROFILES.P5,
      });
      const id = `O:${cohortId}:${d}:${code}`;
      if (sizing.accepted) {
        await db.execute({
          sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
                VALUES (?, ?, ?, ?, 'buy', 'entry', ?, ?, ?)`,
          args: [id, cohortId, d, code, sizing.qty, roundTick((close * 8n) / 100n), spec.tier],
        });
      } else {
        await db.execute({
          sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status, reject_reason, tier)
                VALUES (?, ?, ?, ?, 'buy', 'entry', ?, 'rejected', ?, ?)`,
          args: [id, cohortId, d, code, sizing.qty, rejectReasonText(sizing.reasons), spec.tier],
        });
      }
    }
  };
}

// ---- canonical dump of the replay-relevant tables (AT-13) --------------------------------------------------------

export const REPLAY_TABLES: ReadonlyArray<[string, string]> = [
  ["fill", "SELECT * FROM fill ORDER BY id"],
  [
    "cash_ledger",
    "SELECT cohort_id, d, txn_id, account, delta_micro, kind, ref_type, ref_id FROM cash_ledger ORDER BY cohort_id, d, txn_id, account",
  ],
  ["nav_daily", "SELECT * FROM nav_daily ORDER BY cohort_id, d"],
  ["nav_daily_pos", "SELECT * FROM nav_daily_pos ORDER BY cohort_id, d, code"],
  ["cohort", "SELECT * FROM cohort ORDER BY id"],
  ["cohort_event", "SELECT * FROM cohort_event ORDER BY cohort_id, seq"],
];

/** One canonical text per table: every column of every row, bigint as decimal text. */
export async function dumpTables(db: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, sql] of REPLAY_TABLES) {
    const rs = await db.execute(sql);
    out[name] = rs.rows
      .map((row) => JSON.stringify(Object.values(row).map((v) => String(v))))
      .join("\n");
  }
  return out;
}

// ---- independent re-verification of a stored cohort (ARN-101 over the whole history) ---------------------------------

/**
 * Rebuild every stored day of a cohort from its ledger, fills and the stored closes, and run all
 * invariants over the whole history, comparing with the stored nav_daily rows exactly.
 */
export async function verifyCohort(
  db: Client,
  ds: Dataset,
  cohortId: string,
): Promise<Violation[]> {
  const cohort = await loadCohort(db, cohortId);
  if (cohort === null) throw new Error("no cohort");
  const params = parseCohortParams(cohort.paramsJson);
  const stored = await loadNavDays(db, cohortId);
  const [rows, fills, adjustments] = await Promise.all([
    loadLedgerRows(db, cohortId),
    loadLedgerFills(db, cohortId),
    loadQtyAdjustments(db, cohortId),
  ]);
  const cfg = await loadSleeveConfig(db, cohortId);
  const trades = await loadSleeveTrades(db, cohortId);
  const states = await loadSleeveStates(db, cohortId);
  const marks = new Map<string, Mark>();
  for (const day of stored) {
    const data = createMarketData(db, MARKET, day.row.d);
    for (const p of day.positions) {
      const adv = await data.adv(p.code, day.row.d);
      marks.set(`${day.row.d}|${p.code}`, {
        closeMicro: p.closeMicro,
        advMicro: adv,
        ...(p.haircut === 1 ? { haircut: makeRational(1n, 2n), halted: true } : {}),
      });
    }
  }
  const closeOf = (code: string, d: string): bigint | undefined => {
    const exact = ds.closes.get(`${d}|${code}`);
    if (exact !== undefined) return exact;
    // halted day: the last stored close of the code
    return [...marks.entries()]
      .filter(([k]) => k.endsWith(`|${code}`) && k.slice(0, 10) <= d)
      .pop()?.[1].closeMicro;
  };
  const books: CohortBooks = {
    cohortId,
    rows,
    fills,
    adjustments,
    markFor: (d, code) => marks.get(`${d}|${code}`),
    sleeveUnrealFor:
      cfg === null
        ? undefined
        : (d) =>
            sleeveUnrealAt({ trades, d, closeFor: (code) => closeOf(code, d), adjustments, cfg }),
    sleeveLiquidationCostFor:
      cfg === null ? undefined : (d) => sleeveLiquidationCostMicro(openRealTradeAt(trades, d), cfg),
    profile: COST_PROFILES[params.costProfile],
    tickCrossFactor: params.tickCrossFactor,
  };
  return checkCohortBooks(books, {
    mode: params.settlementMode,
    calendar: ds.calendar,
    dates: stored.map((s) => s.row.d),
    stored,
    seedMicro: cohort.seedMicro,
    sleeve: cfg === null ? undefined : { trades, states, cfg },
  });
}
