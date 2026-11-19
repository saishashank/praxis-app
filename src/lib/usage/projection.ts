// Quota projection of a market that is not switched on yet (MKT-113, MKT-105, D-1099, D-1190; M20 S1). HIGH-RISK
// (money and quota): a wrong figure lets the Owner switch on a market that pushes Turso past its 20 % share of the
// free plan (PRD-045), so the arithmetic is integer only (BigInt, rounded UP, never down) and every edge is tested.
//
//   projected_m = ceil( auMeasured_m x (cap / auCodes) x (sessionsMarket / sessionsAu) ) + fixed_m
//
// for each metric m in {turso_reads, turso_writes, actions_minutes, worker_requests, host_requests}:
//   auMeasured  the trailing-30-day figure of the AU market (the Usage meters' own sources: run records, the Worker
//               clock rollup), `readAuMeasured`;
//   cap         `profile.universeMax` (`mkt.<CODE>.universe_max`, D-1098), the codes the market keeps;
//   auCodes     the AU universe size on the latest snapshot day;
//   sessions    the market's trading days in the next calendar month, from its calendar RULES (a market that is off has
//               no calendar rows), `sessionsInNextMonth`;
//   fixed_m     the market's own overhead, `fixedOf`: its Worker slots (market-bound) per session and the fixed reads
//               and writes of batch 1.
//
// `fits`: the Turso figures of AU plus every projected market stay within `turso_free_ceiling_pct` (20 %) of the free
// plan, and every other metric within 90 % of its budget (MKT-105). A figure exactly on the line fits (<=). Nothing
// here is written anywhere; the Usage page and the switch-on checklist read it.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { CALENDAR_RULE_MODULES } from "@/lib/data/calendarRules.mjs";
import { builtMarkets, loadProfile } from "@/lib/market/profile";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import {
  estimateUntrackedTraffic,
  latestTursoSample,
  monthBounds,
  TURSO_FREE_PLAN,
} from "./meters";

export const PROJECTION_METRICS = [
  "turso_reads",
  "turso_writes",
  "actions_minutes",
  "worker_requests",
  "host_requests",
] as const;
export type ProjectionMetric = (typeof PROJECTION_METRICS)[number];
export type Figures = Readonly<Record<ProjectionMetric, number>>;

export const METRIC_LABELS: Readonly<Record<ProjectionMetric, string>> = Object.freeze({
  turso_reads: "Turso rows read",
  turso_writes: "Turso rows written",
  actions_minutes: "Actions minutes",
  worker_requests: "Worker requests",
  host_requests: "Host requests",
});

/** The non-Turso metrics must stay within this share of their budget (MKT-105). */
export const OTHER_METRIC_SHARE_PCT = 90; // threshold-ok: MKT-105 "every other metric <= 90 %"
/**
 * Monthly budgets of the metrics the Turso meters do not cover. Estimates of the free-plan allowance, re-checked in
 * the monthly $0 check (PLT-050): Cloudflare Workers free 100,000 requests a day (30-day month), Vercel Hobby
 * 1,000,000 function invocations a month.
 */
export const WORKER_REQUESTS_BUDGET_MONTH = 3_000_000; // threshold-ok: 100,000 a day x 30
export const HOST_REQUESTS_BUDGET_MONTH = 1_000_000; // threshold-ok: Vercel Hobby invocations

/** Fixed overhead per trading session of a market (estimates from the code paths, labelled so). */
export const FIXED_BATCH1_READS_PER_SESSION = 500; // threshold-ok: config, calendar and universe pointer reads
export const FIXED_BATCH1_WRITES_PER_SESSION = 50; // threshold-ok: run records, markers, quality rows
export const WORKER_REQUESTS_PER_SLOT = 6; // threshold-ok: = WORKER_READS_PER_TICK, one dispatch per slot
export const HOST_REQUESTS_PER_SLOT = 1; // threshold-ok: one signed call per slot

const DAYS_WINDOW = 30; // threshold-ok: the trailing window of the Usage meters
const DAY_MS = 86_400_000; // threshold-ok: unit conversion

export type Limits = Readonly<Record<ProjectionMetric, { budget: number; pct: number }>>;

/** The limit of each metric: Turso at the ceiling share of the free plan, the others at 90 % of their budget. */
export function limitsOf(cfg: { tursoCeilingPct: number; actionsSoftCeiling: number }): Limits {
  return Object.freeze({
    turso_reads: { budget: TURSO_FREE_PLAN.rowsRead, pct: cfg.tursoCeilingPct },
    turso_writes: { budget: TURSO_FREE_PLAN.rowsWritten, pct: cfg.tursoCeilingPct },
    actions_minutes: { budget: cfg.actionsSoftCeiling, pct: OTHER_METRIC_SHARE_PCT },
    worker_requests: { budget: WORKER_REQUESTS_BUDGET_MONTH, pct: OTHER_METRIC_SHARE_PCT },
    host_requests: { budget: HOST_REQUESTS_BUDGET_MONTH, pct: OTHER_METRIC_SHARE_PCT },
  });
}

const zero = (): Record<ProjectionMetric, number> => ({
  turso_reads: 0,
  turso_writes: 0,
  actions_minutes: 0,
  worker_requests: 0,
  host_requests: 0,
});

export type ProjectInput = {
  readonly auMeasured: Figures;
  /** AU universe size on the sample day (the divisor of the scale). */
  readonly auCodes: number;
  /** The market's cap (`universe_max`). */
  readonly cap: number;
  readonly sessionsMarket: number;
  readonly sessionsAu: number;
  readonly fixed: Figures;
};

const big = (n: number): bigint => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError("a projection input must be a whole number >= 0");
  return BigInt(n);
};

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The projected monthly figures of one market (rounded up to whole units, then the fixed part added). */
export function projectMarket(i: ProjectInput): Figures {
  if (!Number.isSafeInteger(i.auCodes) || i.auCodes < 1)
    throw new RangeError("auCodes must be at least 1");
  if (!Number.isSafeInteger(i.sessionsAu) || i.sessionsAu < 1)
    throw new RangeError("sessionsAu must be at least 1");
  const out = zero();
  for (const m of PROJECTION_METRICS) {
    const scaled = ceilDiv(
      big(i.auMeasured[m]) * big(i.cap) * big(i.sessionsMarket),
      BigInt(i.auCodes) * BigInt(i.sessionsAu),
    );
    out[m] = Number(scaled + big(i.fixed[m]));
  }
  return out;
}

/** The fixed overhead of a market over one calendar month: `sessions` sessions of `slotAnchors` slots each. */
export function fixedOf(sessions: number, slotAnchors: number): Figures {
  return Object.freeze({
    turso_reads: sessions * FIXED_BATCH1_READS_PER_SESSION,
    turso_writes: sessions * FIXED_BATCH1_WRITES_PER_SESSION,
    actions_minutes: 0,
    worker_requests: sessions * slotAnchors * WORKER_REQUESTS_PER_SLOT,
    host_requests: sessions * slotAnchors * HOST_REQUESTS_PER_SLOT,
  });
}

export type MetricVerdict = {
  metric: ProjectionMetric;
  label: string;
  total: number;
  /** The whole-unit limit (budget x pct / 100, rounded down). */
  limit: number;
  /** total as a share of the limit's budget, whole percent rounded to one decimal. */
  sharePct: number;
  ok: boolean;
};
export type FitsResult = { fits: boolean; verdicts: MetricVerdict[] };

/** AU plus every projected market against the limits; a total exactly on the limit fits. */
export function fits(p: { au: Figures; markets: readonly Figures[]; limits: Limits }): FitsResult {
  const verdicts: MetricVerdict[] = [];
  for (const m of PROJECTION_METRICS) {
    let total = p.au[m];
    for (const x of p.markets) total += x[m];
    const { budget, pct } = p.limits[m];
    // total x 100 <= budget x pct, all whole numbers (no float on the line)
    const ok = BigInt(total) * 100n <= BigInt(budget) * BigInt(pct);
    verdicts.push({
      metric: m,
      label: METRIC_LABELS[m],
      total,
      limit: Number((BigInt(budget) * BigInt(pct)) / 100n),
      sharePct: budget === 0 ? 0 : Math.round((total * 1000) / budget) / 10,
      ok,
    });
  }
  return { fits: verdicts.every((v) => v.ok), verdicts };
}

// ---- readers ----------------------------------------------------------------------------------------------------

/** Trading days (session or early close) of `market` in the calendar month after the one holding `now`, from its rules. */
export function sessionsInNextMonth(market: string, now: Date): number {
  const rules = Object.hasOwn(CALENDAR_RULE_MODULES, market)
    ? CALENDAR_RULE_MODULES[market as keyof typeof CALENDAR_RULE_MODULES]
    : null;
  if (rules === null) return 0;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 0-based next month
  const year = m > 11 ? y + 1 : y;
  const month = (m % 12) + 1;
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  let n = 0;
  for (const row of rules.yearRows(year) as readonly (readonly [string, string, string | null])[]) {
    if (row[0].startsWith(prefix) && (row[1] === "session" || row[1] === "early_close")) n += 1;
  }
  return n;
}

const num = (v: unknown): number => Number(v ?? 0);

/** The AU figures of the trailing 30 days and the AU universe size (the scale's divisor). */
export async function readAuMeasured(
  db: Pick<Client, "execute">,
  now: Date,
): Promise<{ figures: Figures; baseline?: Figures; auCodes: number; from: string; to: string }> {
  const to = now.toISOString();
  const from = new Date(now.getTime() - DAYS_WINDOW * DAY_MS).toISOString();
  // rows-ok: 30 days of run records through idx_run_record_started (a few thousand rows), Owner page only
  const rec = await db.execute({
    sql: `SELECT SUM(CASE WHEN market = ? THEN rows_read ELSE 0 END) AS r,
                 SUM(CASE WHEN market = ? THEN rows_written ELSE 0 END) AS w,
                 SUM(CASE WHEN job LIKE 'actions-%' THEN duration_ms ELSE 0 END) AS ms,
                 SUM(rows_read) AS allr, SUM(rows_written) AS allw
          FROM run_record WHERE started_at >= ? AND started_at < ?`,
    args: [HOME_MARKET, HOME_MARKET, from, to],
  });
  const traffic = await estimateUntrackedTraffic(db as Client, now, { start: from, end: to });
  const ticks = Math.round(traffic.workerTickReads / 6); // threshold-ok: WORKER_READS_PER_TICK
  // rows-ok: the newest snapshot day of AU, then one key-prefix count of that day (the universe size)
  const day = await db.execute({
    sql: "SELECT MAX(d) AS d FROM universe_snapshot WHERE market = ?",
    args: [HOME_MARKET],
  });
  let auCodes = 0;
  if (day.rows[0]?.d !== null && day.rows[0]?.d !== undefined) {
    // rows-ok: one day of the AU universe (a couple of thousand rows) by the (market, d) key prefix
    const c = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM universe_snapshot WHERE market = ? AND d = ?",
      args: [HOME_MARKET, String(day.rows[0].d)],
    });
    auCodes = num(c.rows[0]?.n);
  }
  const r = rec.rows[0];
  // D-1195 (S1 fix): the figure the limits are judged against is what the whole system uses now, not the AU-tagged
  // slice: the platform sample of the month when there is one, else every job's run records plus the untracked Worker
  // tick reads and nonce writes, exactly as the Turso meters count (meters.ts). The AU slice stays the scaling source.
  const sample = await latestTursoSample(db, now, monthBounds(now));
  const figures = {
    turso_reads: num(r?.r),
    turso_writes: num(r?.w),
    actions_minutes: Math.ceil(num(r?.ms) / 60_000), // threshold-ok: ms per minute
    worker_requests: ticks,
    host_requests: traffic.signedCalls,
  };
  const baseline: Figures = {
    ...figures,
    turso_reads: sample !== null ? sample.rowsRead : num(r?.allr) + traffic.workerTickReads,
    turso_writes: sample !== null ? sample.rowsWritten : num(r?.allw) + traffic.nonceWrites,
  };
  return { figures, baseline, auCodes, from, to };
}

export type MarketProjection = {
  market: string;
  enabled: boolean;
  cap: number | null;
  sessions: number;
  projected: Figures | null;
  /** Why there is no projection (no cap in the profile, no AU universe yet). */
  note: string | null;
};

export type ProjectionReport = {
  au: Figures;
  auCodes: number;
  limits: Limits;
  window: { from: string; to: string };
  /** Every built market except AU, enabled or not. */
  markets: MarketProjection[];
  /** For each market: does AU plus every enabled market plus this one fit? */
  fitsWith: Record<string, FitsResult | null>;
};

/** The projection of every built market (the Usage card and the switch-on checklist read this). */
export async function loadProjectionReport(
  db: Client,
  now: Date,
  deps: { measured?: Awaited<ReturnType<typeof readAuMeasured>> } = {},
): Promise<ProjectionReport> {
  const [tursoCeilingPct, actionsSoftCeiling] = await Promise.all([
    getConfig(db, "turso_free_ceiling_pct") as Promise<number>,
    getConfig(db, "actions_minutes_soft_ceiling") as Promise<number>,
  ]);
  const limits = limitsOf({ tursoCeilingPct, actionsSoftCeiling });
  const measured = deps.measured ?? (await readAuMeasured(db, now));
  const baseline = measured.baseline ?? measured.figures;
  const sessionsAu = sessionsInNextMonth(HOME_MARKET, now);
  const markets: MarketProjection[] = [];
  for (const code of builtMarkets()) {
    if (code === HOME_MARKET) continue;
    // rows-ok: primary-key probe of one market row
    const en = await db.execute({ sql: "SELECT enabled FROM market WHERE code = ?", args: [code] });
    const enabled = en.rows.length === 1 && num(en.rows[0]!.enabled) === 1;
    const profile = await loadProfile(db, code);
    const sessions = sessionsInNextMonth(code, now);
    const cap = profile.universeMax;
    let projected: Figures | null = null;
    let note: string | null = null;
    if (cap === null) note = "No universe cap in the profile (mkt.<CODE>.universe_max).";
    else if (measured.auCodes < 1) note = "No AU universe snapshot yet, so there is no scale.";
    else if (sessionsAu < 1) note = "No AU sessions next month in the calendar rules.";
    else {
      const anchors = profile.slots === null ? 0 : Object.keys(profile.slots).length;
      projected = projectMarket({
        auMeasured: measured.figures,
        auCodes: measured.auCodes,
        cap,
        sessionsMarket: sessions,
        sessionsAu,
        fixed: fixedOf(sessions, anchors),
      });
    }
    markets.push({ market: code, enabled, cap, sessions, projected, note });
  }
  const fitsWith: Record<string, FitsResult | null> = {};
  for (const m of markets) {
    if (m.projected === null) {
      fitsWith[m.market] = null;
      continue;
    }
    const others = markets
      .filter((x) => x.market !== m.market && x.enabled && x.projected !== null)
      .map((x) => x.projected!);
    fitsWith[m.market] = fits({ au: baseline, markets: [...others, m.projected], limits });
  }
  return {
    au: baseline,
    auCodes: measured.auCodes,
    limits,
    window: { from: measured.from, to: measured.to },
    markets,
    fitsWith,
  };
}
