// Usage meters (PLT-050, PLT-051), computed only from our own run records (PRD-007: no paid or
// admin-scope APIs). Verbatim spec text this module implements (spec/ chapter files):
//
// PLT-050: "The system MUST meter usage against each free allowance: Vercel (invocations, active
//   CPU), GitHub Actions minutes, database storage/reads/writes, Cloudflare requests, each LLM
//   provider's requests/tokens, Resend emails. A **Usage page** MUST show current/limit/percentage.
//   Where no read-only usage credential is held, the figure is **self-counted** by the system from
//   its own run records and labelled "estimate" (the Owner can compare it with the provider
//   dashboard during the monthly $0 check)."
// PLT-051: "Thresholds are measured **per quota period** (monthly quotas: Actions, Turso, Vercel,
//   Resend monthly; daily quotas: LLM, Resend daily, Worker requests). For **monthly** quotas: 70%
//   -> notice in the daily email; 90% -> alert email and reduce non-essential work; 95% -> **degrade
//   mode**. A **daily** quota reaching its limit only switches that provider to
//   fallback/rules-only until its reset (no global degrade mode) [...]. The self-imposed Actions
//   soft ceiling (PLT-014) only **warns**; it never triggers degrade mode."
// PLT-014: "The system still meters usage (self-counted from run records, labelled estimate) and
//   keeps a self-imposed **soft ceiling of 3,000 minutes/month** (alert at 70%/90%) so jobs stay
//   fast and within fair use."
// PLT-014a: "The build agent publishes a per-job table (billed minutes per run x runs per month,
//   per market, plus staging and CI) on the Usage page and in docs/." (information table: later)
// UX-100: "Free-tier meters (PLT-050): Vercel, Actions minutes, Turso storage/reads/writes,
//   Cloudflare requests and CPU, each LLM provider, Resend emails, history-file store - current,
//   limit, %, trend, per market (MKT-104); degrade-mode state."
// DAT-141: "Ceilings: storage <= 3 GB; writes <= 6M/month (staging <= 15% of that); reads <=
//   300M/month. [...] each job records rows read/written [...]"
// LLM-050: "When a role's daily budget is exhausted, the router MUST fall to the next provider,
//   then to rules-only; [...] Role budgets are ch. 15 keys `llm_budget_r1_daily` ...
//   `llm_daily_budget_total`."
// OPS-034: "Quota >= 90%. Open Usage -> identify the consumer (market/job). Actions: degrade mode
//   reduces non-essential work automatically (PLT-051) [...]"
// ROL-102a: Usage is Owner-only.
// Ch.15: "turso ceilings (storage 3 GB, writes 6M/month, reads 300M/month, staging <= 15%)" (l.142);
//   "actions_minutes_soft_ceiling | 3,000/month" (l.154); "quota thresholds | 70/90/95% per
//   period" (l.155); "llm_daily_budget_total | 150,000 tokens" (l.187).
//
// M18 (OPS-104, D-958): the Turso meters read the PLATFORM figure from the newest `usage_sample` row
// of the month (written once a day by scripts/usage/turso-sample.mjs through the turso-usage workflow;
// the app never holds a platform token) and show it against the FREE plan x turso_free_ceiling_pct
// (the 20 % line, PRD-045). The summed run_record figure stays as the cross-check line. With no usable
// sample the meter is the labelled estimate it always was (PLT-050). Turso meters have their own levels:
// the notice share (turso_notice_pct) is reached at 15 % of the plan and the ceiling at 20 %.
//
// Decisions: the spec does not name the month boundary, so the quota month is the calendar month
// in UTC (stored timestamps are UTC, PLT-023; Turso bills by UTC month) and the daily LLM period
// is the UTC day. Staging is derived like the self-check does: TEST_IDENTITY_SECRET present.
import { OWNER_TZ } from "@/lib/market/profileCore.mjs";
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";

export type MeterLevel = "ok" | "notice" | "alert" | "degrade" | "no data";
export type MeterPeriod = "monthly" | "daily" | "none";

export type Meter = {
  id: string;
  label: string;
  used: number | null;
  limit: number | null;
  unit: string;
  period: MeterPeriod;
  periodLabel: string; // e.g. "2026-10 (UTC)"
  ratio: number | null;
  level: MeterLevel;
  note: string; // where the figure comes from
  /** Turso meters only (M18): where the used figure comes from. */
  source?: "platform" | "estimate";
  /** Turso meters only: the whole free-plan allowance in the meter's unit (the page draws the 20 % line against it). */
  planLimit?: number;
};

export type Thresholds = { notice: number; alert: number; degrade: number };
export type UsageEnvironment = "staging" | "production";

/**
 * The Turso FREE plan (turso.tech/pricing, checked 2026-11-11, docs/M18_exit_evidence.md section 4):
 * 500 million rows read and 10 million rows written a month, 5 GB of storage. M18 may use
 * turso_free_ceiling_pct (20) of each, PRD-045.
 */
export const TURSO_FREE_PLAN = Object.freeze({
  rowsRead: 500_000_000,
  rowsWritten: 10_000_000,
  storageBytes: 5_000_000_000,
});
/** A sample older than this is not used: the meter falls back to the labelled estimate. */
export const TURSO_SAMPLE_MAX_AGE_MS = 72 * 3_600_000; // threshold-ok: three missed daily samples
const BYTES_PER_GB = 1_000_000_000; // threshold-ok: unit conversion (decimal GB, as Turso quotes it)

const SEVERITY: Record<MeterLevel, number> = {
  "no data": -1,
  ok: 0,
  notice: 1,
  alert: 2,
  degrade: 3,
};
const EPS = 1e-9;

export function usageEnvironment(env: Record<string, string | undefined>): UsageEnvironment {
  return env.TEST_IDENTITY_SECRET ? "staging" : "production";
}

// Highest level reached at `ratio`, never above `cap` (the Actions soft ceiling and daily quotas
// never trigger the global degrade mode: PLT-051).
export function levelFor(ratio: number, t: Thresholds, cap: MeterLevel = "degrade"): MeterLevel {
  let level: MeterLevel = "ok";
  if (ratio + EPS >= t.degrade) level = "degrade";
  else if (ratio + EPS >= t.alert) level = "alert";
  else if (ratio + EPS >= t.notice) level = "notice";
  return SEVERITY[level] > SEVERITY[cap] ? cap : level;
}

export function monthBounds(now: Date): { start: string; end: string; label: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1)).toISOString(),
    end: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
    label: `${y}-${String(m + 1).padStart(2, "0")} (UTC)`,
  };
}

export function dayBounds(now: Date): { start: string; end: string; label: string } {
  const s = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: new Date(s).toISOString(),
    end: new Date(s + 86_400_000).toISOString(),
    label: `${new Date(s).toISOString().slice(0, 10)} (UTC)`,
  };
}

/**
 * Turso levels (D-958): notice and alert at the notice share of the ceiling, degrade at the ceiling.
 * `degrade` is the PLT-051 degrade mode: non-essential jobs pause. When it is reached the order of work
 * to drop is standby markets first (data_only before full), the full market last; the jobs that read the
 * degrade state today are src/lib/arena/cli.ts, src/lib/cortex/stage.ts and
 * src/lib/data/quotes/fetch.ts (OPS-104 c: an ordering note only, no market is named here).
 */
export function tursoThresholds(noticePct: number, ceilingPct: number): Thresholds {
  const notice = noticePct / ceilingPct;
  return { notice, alert: notice, degrade: 1 };
}

export type TursoSample = {
  sampledAt: string;
  rowsRead: number;
  rowsWritten: number;
  storageBytes: number | null;
  planName: string | null;
};

/** The newest usable platform sample of the month, or null (none yet, unavailable, or too old). */
export async function latestTursoSample(
  db: Pick<Client, "execute">,
  now: Date,
  month: { start: string; end: string },
): Promise<TursoSample | null> {
  const r = await db.execute({
    // rows-ok: one row, read through the primary key
    sql: `SELECT sampled_at, rows_read_month, rows_written_month, storage_bytes, plan_name
          FROM usage_sample WHERE source = 'platform' AND sampled_at >= ? AND sampled_at < ?
          ORDER BY sampled_at DESC LIMIT 1`,
    args: [month.start, month.end],
  });
  const x = r.rows[0];
  if (!x) return null;
  const at = String(x.sampled_at);
  if (now.getTime() - Date.parse(at) > TURSO_SAMPLE_MAX_AGE_MS) return null;
  if (x.rows_read_month === null || x.rows_written_month === null) return null;
  return {
    sampledAt: at,
    rowsRead: Number(x.rows_read_month),
    rowsWritten: Number(x.rows_written_month),
    storageBytes: x.storage_bytes === null ? null : Number(x.storage_bytes),
    planName: x.plan_name === null ? null : String(x.plan_name),
  };
}

const melbourneHm = (iso: string) =>
  new Intl.DateTimeFormat("en-AU", {
    timeZone: OWNER_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

function make(
  m: Omit<Meter, "ratio" | "level">,
  t: Thresholds,
  opts: { cap?: MeterLevel; noData?: boolean } = {},
): Meter {
  if (opts.noData || m.used === null || m.limit === null || m.limit <= 0) {
    return { ...m, ratio: null, level: "no data" };
  }
  const ratio = m.used / m.limit;
  return { ...m, ratio, level: levelFor(ratio, t, opts.cap) };
}

const num = (v: unknown) => Number(v ?? 0);
const nf = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 });

// V1-S11 (D-720): traffic that no job reports about itself is estimated, never silently left out.
// Every signed machine call claims a nonce (one INSERT, plus a prune DELETE) and the Worker reads
// config/state on each one-minute tick. Constants are estimates from the code paths, labelled so.
export const NONCE_WRITES_PER_SIGNED_CALL = 2;
export const WORKER_READS_PER_TICK = 6;
const NOT_SIGNED_JOBS =
  "job LIKE 'email-%' OR job LIKE 'actions-%' OR job LIKE 'heartbeat-%' OR job = 'watchdog' OR job = 'worker-clock'";

export type TrafficEstimate = { signedCalls: number; nonceWrites: number; workerTickReads: number };

export async function estimateUntrackedTraffic(
  db: Client,
  now: Date,
  month: { start: string; end: string },
): Promise<TrafficEstimate> {
  const res = await db.execute({
    sql: `SELECT SUM(NOT (${NOT_SIGNED_JOBS})) AS signed, SUM(job = 'worker-clock') AS clock
          FROM run_record WHERE started_at >= ? AND started_at < ?`,
    args: [month.start, month.end],
  });
  const signedCalls = num(res.rows[0]?.signed);
  const ticks =
    num(res.rows[0]?.clock) > 0
      ? Math.max(0, Math.floor((now.getTime() - Date.parse(month.start)) / 60_000))
      : 0;
  return {
    signedCalls,
    nonceWrites: signedCalls * NONCE_WRITES_PER_SIGNED_CALL,
    workerTickReads: ticks * WORKER_READS_PER_TICK,
  };
}

export async function getMeters(
  db: Client,
  now: Date,
  environment: UsageEnvironment,
): Promise<Meter[]> {
  const [
    thresholds,
    writesCeil,
    readsCeil,
    share,
    actionsCeil,
    llmBudget,
    storageCeil,
    ceilingPct,
    noticePct,
  ] = await Promise.all([
    getConfig(db, "quota_thresholds") as Promise<Thresholds>,
    getConfig(db, "turso_writes_ceiling_month") as Promise<number>,
    getConfig(db, "turso_reads_ceiling_month") as Promise<number>,
    getConfig(db, "turso_staging_share") as Promise<number>,
    getConfig(db, "actions_minutes_soft_ceiling") as Promise<number>,
    getConfig(db, "llm_daily_budget_total") as Promise<number>,
    getConfig(db, "storage_ceiling_gb") as Promise<number>,
    getConfig(db, "turso_free_ceiling_pct") as Promise<number>,
    getConfig(db, "turso_notice_pct") as Promise<number>,
  ]);
  const tursoLevels = tursoThresholds(noticePct, ceilingPct);
  const month = monthBounds(now);
  const day = dayBounds(now);
  const factor = environment === "staging" ? share : 1;
  const scope = environment === "staging" ? "staging share of the " : "";

  const [tursoRes, emailRes, actionsRes, llmRes, traffic, sample] = await Promise.all([
    db.execute({
      sql: `SELECT SUM(rows_read) AS r, SUM(rows_written) AS w FROM run_record
            WHERE started_at >= ? AND started_at < ?`,
      args: [month.start, month.end],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM run_record
            WHERE job LIKE 'email-%' AND started_at >= ? AND started_at < ?`,
      args: [month.start, month.end],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS n, SUM(duration_ms) AS ms FROM run_record
            WHERE job LIKE 'actions-%' AND started_at >= ? AND started_at < ?`,
      args: [month.start, month.end],
    }),
    db.execute({
      sql: `SELECT SUM(llm_tokens) AS t FROM run_record WHERE started_at >= ? AND started_at < ?`,
      args: [day.start, day.end],
    }),
    estimateUntrackedTraffic(db, now, month),
    latestTursoSample(db, now, month),
  ]);

  const turso = tursoRes.rows[0];
  const actions = actionsRes.rows[0];
  const recorded = (extra: string) =>
    `Recorded by jobs plus an estimate of ${extra} (app page traffic not included). Estimate.`;

  // Our own count (run records plus the untracked-traffic estimate), the figure the estimate meter
  // shows and the cross-check beside a platform figure.
  const ourWrites = num(turso.w) + traffic.nonceWrites;
  const ourReads = num(turso.r) + traffic.workerTickReads;
  const crossCheck = (ours: number, platform: number) => {
    if (platform <= 0) return `Our count: ${nf.format(ours)}.`;
    const delta = ((ours - platform) / platform) * 100;
    return `Our count: ${nf.format(ours)}, ${delta >= 0 ? "+" : "-"}${nf.format(Math.abs(delta))} % against the platform.`;
  };
  const tursoRow = (
    id: string,
    label: string,
    ours: number,
    platform: number | null,
    freeTotal: number,
    ceiling: number,
    ceilingNote: string,
    extra: string,
  ): Meter =>
    sample && platform !== null
      ? make(
          {
            id,
            label,
            used: platform,
            limit: Math.round((freeTotal * ceilingPct) / 100),
            unit: "rows",
            period: "monthly",
            periodLabel: month.label,
            source: "platform",
            planLimit: freeTotal,
            note: `Platform figure, sampled ${melbourneHm(sample.sampledAt)} Melbourne; limit is ${ceilingPct} % of the Turso free plan (PRD-045). ${crossCheck(ours, platform)}`,
          },
          tursoLevels,
        )
      : make(
          {
            id,
            label,
            used: ours,
            limit: Math.round(ceiling * factor),
            unit: "rows",
            period: "monthly",
            periodLabel: month.label,
            source: "estimate",
            planLimit: freeTotal,
            note: `${recorded(extra)} Limit is the ${scope}${ceilingNote} (DAT-141). No platform sample this month yet.`,
          },
          tursoLevels,
        );

  return [
    tursoRow(
      "turso-rows-written",
      "Turso rows written",
      ourWrites,
      sample ? sample.rowsWritten : null,
      TURSO_FREE_PLAN.rowsWritten,
      writesCeil,
      "writes ceiling",
      `signed-call nonce writes (~${traffic.nonceWrites})`,
    ),
    tursoRow(
      "turso-rows-read",
      "Turso rows read",
      ourReads,
      sample ? sample.rowsRead : null,
      TURSO_FREE_PLAN.rowsRead,
      readsCeil,
      "reads ceiling",
      `Worker tick reads (~${traffic.workerTickReads})`,
    ),
    sample && sample.storageBytes !== null
      ? make(
          {
            id: "turso-storage",
            label: "Turso storage",
            used: sample.storageBytes / BYTES_PER_GB,
            limit: (TURSO_FREE_PLAN.storageBytes * ceilingPct) / 100 / BYTES_PER_GB,
            unit: "GB",
            period: "none",
            periodLabel: "current",
            source: "platform",
            planLimit: TURSO_FREE_PLAN.storageBytes / BYTES_PER_GB,
            note: `Platform figure, sampled ${melbourneHm(sample.sampledAt)} Melbourne; limit is ${ceilingPct} % of the Turso free plan (PRD-045).`,
          },
          tursoLevels,
        )
      : make(
          {
            id: "turso-storage",
            label: "Turso storage",
            used: null,
            limit: storageCeil,
            unit: "GB",
            period: "none",
            periodLabel: "current",
            source: "estimate",
            planLimit: TURSO_FREE_PLAN.storageBytes / BYTES_PER_GB,
            note: "Not measured yet (no platform sample: the Turso platform token is not set).",
          },
          tursoLevels,
          { noData: true },
        ),
    make(
      {
        id: "llm-tokens",
        label: "LLM tokens (all providers)",
        used: num(llmRes.rows[0].t),
        limit: llmBudget,
        unit: "tokens",
        period: "daily",
        periodLabel: day.label,
        note: "Recorded by jobs, all providers together (per-provider split later). At the daily limit the router falls back to rules-only (LLM-050).",
      },
      thresholds,
      { cap: "alert" },
    ),
    make(
      {
        id: "actions-minutes",
        label: "GitHub Actions minutes",
        used: num(actions.n) === 0 ? null : Math.ceil(num(actions.ms) / 60_000),
        limit: actionsCeil,
        unit: "minutes",
        period: "monthly",
        periodLabel: month.label,
        note: "Self-counted from jobs named actions-* (estimate). The soft ceiling only warns (PLT-014).",
      },
      thresholds,
      { cap: "alert" },
    ),
    make(
      {
        id: "emails-sent",
        label: "Emails sent",
        used: num(emailRes.rows[0].n),
        limit: null,
        unit: "emails",
        period: "monthly",
        periodLabel: month.label,
        note: "Counted from jobs named email-* (estimate). No email limit is set in configuration yet.",
      },
      thresholds,
    ),
  ];
}

export type WorstMeter = { level: MeterLevel; meter?: Meter };

// The most severe level across meters; ties keep the first. "no data" only if every meter is.
export function worstMeter(meters: Meter[]): WorstMeter {
  let worst: Meter | undefined;
  for (const m of meters) {
    if (!worst || SEVERITY[m.level] > SEVERITY[worst.level]) worst = m;
  }
  return worst ? { level: worst.level, meter: worst } : { level: "no data" };
}
