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
// Decisions: the spec does not name the month boundary, so the quota month is the calendar month
// in UTC (stored timestamps are UTC, PLT-023; Turso bills by UTC month) and the daily LLM period
// is the UTC day. Staging is derived like the self-check does: TEST_IDENTITY_SECRET present.
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
};

export type Thresholds = { notice: number; alert: number; degrade: number };
export type UsageEnvironment = "staging" | "production";

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

export async function getMeters(
  db: Client,
  now: Date,
  environment: UsageEnvironment,
): Promise<Meter[]> {
  const [thresholds, writesCeil, readsCeil, share, actionsCeil, llmBudget, storageCeil] =
    await Promise.all([
      getConfig(db, "quota_thresholds") as Promise<Thresholds>,
      getConfig(db, "turso_writes_ceiling_month") as Promise<number>,
      getConfig(db, "turso_reads_ceiling_month") as Promise<number>,
      getConfig(db, "turso_staging_share") as Promise<number>,
      getConfig(db, "actions_minutes_soft_ceiling") as Promise<number>,
      getConfig(db, "llm_daily_budget_total") as Promise<number>,
      getConfig(db, "storage_ceiling_gb") as Promise<number>,
    ]);
  const month = monthBounds(now);
  const day = dayBounds(now);
  const factor = environment === "staging" ? share : 1;
  const scope = environment === "staging" ? "staging share of the " : "";

  const [tursoRes, emailRes, actionsRes, llmRes] = await Promise.all([
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
  ]);

  const turso = tursoRes.rows[0];
  const actions = actionsRes.rows[0];
  const recorded = "Recorded by jobs (app traffic not included). Estimate.";

  return [
    make(
      {
        id: "turso-rows-written",
        label: "Turso rows written",
        used: num(turso.w),
        limit: Math.round(writesCeil * factor),
        unit: "rows",
        period: "monthly",
        periodLabel: month.label,
        note: `${recorded} Limit is the ${scope}writes ceiling (DAT-141).`,
      },
      thresholds,
    ),
    make(
      {
        id: "turso-rows-read",
        label: "Turso rows read",
        used: num(turso.r),
        limit: Math.round(readsCeil * factor),
        unit: "rows",
        period: "monthly",
        periodLabel: month.label,
        note: `${recorded} Limit is the ${scope}reads ceiling (DAT-141).`,
      },
      thresholds,
    ),
    make(
      {
        id: "turso-storage",
        label: "Turso storage",
        used: null,
        limit: storageCeil,
        unit: "GB",
        period: "none",
        periodLabel: "current",
        note: "Not measured yet (needs the Turso platform API - later).",
      },
      thresholds,
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
