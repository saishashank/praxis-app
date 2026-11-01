// Synthetic nights for the batch 2b tests (M4 T8). Test support only. Everything is synthetic: codes
// ZZ*, a calendar in 2030, deterministic price paths, no randomness. The database goes through the
// REAL migrations; batch 2a (`closeBooksDay`) and batch 2b (`signalsDay`) run end to end through
// the replay driver, so a night is exactly what production does, only against a local file.
import type { Client } from "@libsql/client";
import { buildAgentParams, type AgentParams } from "@/lib/agents/params";
import { signalsDay, type SignalsOptions, type SignalsResult } from "@/lib/agents/batch2b";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { type ParamOverrides, buildExecutionRegistry, planInitialStart } from "@/lib/arena/cohort";
import { resolveCohortParams } from "@/lib/arena/cohort";
import { seedExecutions, startCohorts } from "@/lib/arena/cohortWriter";
import { replaySessions } from "@/lib/arena/replay";
import type { CloseBooksResult } from "@/lib/arena/closeBooks";
import { isWeekend, addDays } from "@/lib/data/calendar";
import { makeRational } from "@/lib/money/rational";
import { freshReplayDb, MARKET, MASTER_SEED, NOW, setMode } from "../arena/replayHarness";

export { MARKET, NOW, setMode, freshReplayDb };

export const START = "2030-01-02"; // a Wednesday
export const SESSIONS = 330;

/** The first `n` weekdays from START. */
export function sessionDates(n: number = SESSIONS): string[] {
  const out: string[] = [];
  for (let d = START; out.length < n; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d);
  return out;
}

export const DATES = sessionDates();

/** Agent parameters with a short regime history (the registry default needs 1,281 sessions). */
export function testParams(over: Record<string, unknown> = {}): AgentParams {
  return buildAgentParams((k) => {
    if (k in over) return over[k];
    if (k === "regime_vol_lookback_sessions") return 40;
    if (k === "regime_params") {
      return { ...(CONFIG_KEYS[k].default as Record<string, number>), sma_sessions: 50 };
    }
    return CONFIG_KEYS[k].default;
  });
}

export type CodeDef = {
  readonly code: string;
  readonly tier?: "U1" | "U2";
  /** Close (micro) of session i. */
  readonly close: (i: number) => bigint;
  readonly volume?: (i: number) => bigint;
  /** A 2-for-1 split with this ex-date session index: raw prices halve from it on. */
  readonly splitAt?: number;
  /** Overrides the open of session i (default: the previous close); M15 P2 uses it for a gap-up. */
  readonly open?: (i: number, prevClose: bigint) => bigint;
};

const CENT = 10_000n;
const real = (v: bigint): number => Number(v) / 1e6;

/** Linear trend with a small deterministic zigzag; amplitude per code gives distinct volatility. */
export function trend(start: bigint, step: bigint, amp: bigint) {
  const pattern = [0n, 1n, -1n];
  return (i: number): bigint => start + BigInt(i) * step + amp * pattern[i % 3]!;
}

export type NightOptions = {
  readonly codes: readonly CodeDef[];
  /** Last session index that exists (the future does not exist); default all. */
  readonly through?: number;
  /** Bars, index bars and rows after this session index are written 1000x wrong (look-ahead poison). */
  readonly poisonAfter?: number;
  /** Quality gate fails on these session indexes (U1). */
  readonly gateFail?: readonly number[];
};

/** Rows that every night needs: calendar is weekday-only (no rows), bars, universe, quality, index. */
export async function buildNight(db: Client, o: NightOptions): Promise<void> {
  const through = o.through ?? DATES.length - 1;
  const poison = o.poisonAfter ?? Number.POSITIVE_INFINITY;
  const stmts: { sql: string; args: unknown[] }[] = [];
  const push = (sql: string, args: unknown[]): void => {
    stmts.push({ sql, args });
  };
  const prev = new Map<string, bigint>();
  for (let i = 0; i <= through; i++) {
    const d = DATES[i]!;
    const k = i > poison ? 1000n : 1n;
    for (const c of o.codes) {
      const split = c.splitAt !== undefined && i >= c.splitAt;
      const close = split ? c.close(i) / 2n : c.close(i);
      const first = prev.get(c.code);
      const base = c.splitAt === i && first !== undefined ? first / 2n : (first ?? close);
      const open = c.open === undefined ? base : c.open(i, base);
      prev.set(c.code, close);
      const hi = (open > close ? open : close) + CENT;
      const lo = (open < close ? open : close) - CENT;
      push(
        `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synthetic', ?, ?)`,
        [
          MARKET,
          c.code,
          d,
          real(open * k),
          real(hi * k),
          real(lo * k),
          real(close * k),
          Number((c.volume ?? (() => 2_000_000n))(i)),
          `${d}T06:30:00.000Z`,
          `${d}T07:00:00.000Z`,
        ],
      );
      push(
        `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
         VALUES (?, ?, ?, 'active', ?, NULL, NULL, 0)`,
        [MARKET, d, c.code, c.tier ?? "U1"],
      );
    }
    // the benchmark: rising, with a quieter and quieter zigzag so the regime reads RISK-ON
    const level = 5_000_000_000n + BigInt(i) * 2_000_000n;
    const amp = BigInt(Math.max(1, SESSIONS - i)) * 20_000n;
    const idx = level + amp * [0n, 1n, -1n][i % 3]!;
    push(
      `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
       VALUES (?, 'AXJO', ?, ?, ?, ?, ?, 'synthetic', ?, ?)`,
      [
        MARKET,
        d,
        Number(idx * k),
        Number(idx * k),
        Number(idx * k),
        Number(idx * k),
        `${d}T06:30:00.000Z`,
        `${d}T07:00:00.000Z`,
      ],
    );
    const fail = o.gateFail?.includes(i) === true;
    for (const tier of ["U1", "U2", "U3"]) {
      push(
        `INSERT INTO quality_score (market, d, tier, valid, expected, score, gate_pass) VALUES (?, ?, ?, 10, 10, 100, ?)`,
        [MARKET, d, tier, tier === "U1" && fail ? 0 : 1],
      );
    }
    push(
      `INSERT INTO completion_marker (market, d, kind, at, run_id, outcome) VALUES (?, ?, 'data', ?, ?, 'ok')`,
      [MARKET, d, `${d}T07:30:00.000Z`, i + 1],
    );
  }
  for (let i = 0; i < stmts.length; i += 400) {
    await db.batch(stmts.slice(i, i + 400) as never, "write");
  }
}

/** A confirmed corporate action (insert + the confirming status event). */
export async function addAction(
  db: Client,
  code: string,
  type: string,
  exIndex: number,
  payload: Record<string, unknown>,
): Promise<void> {
  const exD = DATES[exIndex]!;
  const res = await db.execute({
    // D-793: a synthetic action is known from the first session of the run (a NULL known_at on a row
    // born after the legacy bound is no longer "always known").
    sql: `INSERT INTO corporate_action (market, code, type, ex_date, record_date, payload_json, evidence_json, known_at)
          VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)`,
    args: [MARKET, code, type, exD, JSON.stringify(payload), `${DATES[0]!}T00:00:00.000Z`],
  });
  await db.execute({
    sql: `INSERT INTO corporate_action_event (action_id, at, status, by, note)
          VALUES (?, ?, 'auto_confirmed', 'synthetic', NULL)`,
    args: [res.lastInsertRowid as never, `${exD}T00:00:00.000Z`],
  });
}

export const NO_TERMINAL: ParamOverrides = {
  terminal: {
    targetMultiple: makeRational(100n),
    bustFraction: makeRational(1n, 100n),
    timeoutSessions: 1000,
    stallFloorMicro: 1n,
  },
};

/** Seed the registry and start the chosen executions (control index 1 for C2/C3) at `startIndex`. */
export async function startCohortsAt(
  db: Client,
  startIndex: number,
  keep: readonly string[],
  extra: ParamOverrides = {},
): Promise<string[]> {
  const registry = buildExecutionRegistry();
  await seedExecutions(db, registry);
  const starts = planInitialStart({
    registry,
    startD: DATES[startIndex]!,
    paramsFor: () => resolveCohortParams({ ...NO_TERMINAL, ...extra, costProfile: "P5" }),
    masterSeed: MASTER_SEED,
    controlsPerFamily: 1,
  }).filter((s) => keep.includes(s.executionId));
  await startCohorts(db, starts);
  return starts.map((s) => s.id);
}

export type NightRun = {
  readonly closes: CloseBooksResult[];
  readonly signals: Map<string, SignalsResult>;
};

/** 2a then 2b for each session in [fromIndex, toIndex], as the nightly pair would run. */
export async function runNights(
  db: Client,
  params: AgentParams,
  fromIndex: number,
  toIndex: number,
  hook?: (d: string, closed: CloseBooksResult, decided: SignalsResult) => Promise<void>,
  extra: Partial<SignalsOptions> = {},
): Promise<NightRun> {
  const signals = new Map<string, SignalsResult>();
  const closes = await replaySessions(db, {
    market: MARKET,
    from: DATES[fromIndex]!,
    to: DATES[toIndex]!,
    now: NOW,
    masterSeed: MASTER_SEED,
    afterClose: async (d, closed) => {
      const decided = await signalsDay(db, {
        withLeverage: true, // D-191: the full engine, sleeve included

        market: MARKET,
        d,
        replay: true,
        now: NOW,
        masterSeed: MASTER_SEED,
        params,
        ...extra,
      });
      signals.set(d, decided);
      if (hook !== undefined) await hook(d, closed, decided);
    },
  });
  return { closes, signals };
}

export async function dump(db: Client, sql: string): Promise<string> {
  const rs = await db.execute(sql);
  return JSON.stringify(
    rs.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]))),
  );
}
