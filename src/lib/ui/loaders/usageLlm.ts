// LLM usage for the Usage page (LLM-051, UX-100; M7 T19b; D-148 draft). Owner only (usage numbers are
// Owner-only, decision 23): the caller is the Owner-guarded page and `owner` is checked again here.
// Reads `llm_call` (counts, tokens and outcomes only; no prompts or text are stored there):
//   - per role and provider over the last 30 days: calls, tokens in and out, cache hits, fallbacks to a
//     later provider or to rules, and calls that ended without a model answer (failures);
//   - per day and provider over the last 14 days: the same counts, newest day first.
// Rates are whole-number percent computed in integer arithmetic (rounded half up); a rate over zero
// calls is null ("not measured yet"). Bounded, ordered queries; nothing is written.
import type { Client } from "@libsql/client";

const DAY_MS = 86_400_000; // threshold-ok: unit conversion
const ROLE_DAYS = 30; // threshold-ok: LLM-051 view window
const DAY_ROWS_DAYS = 14; // threshold-ok: per-day view window
const MAX_ROWS = 200; // threshold-ok: bounded rows per table
const PERCENT = 100; // threshold-ok: percent

/** Outcomes that are a normal answer (a model answered, a cache answered, or rules-only mode was chosen). */
const NORMAL_OUTCOMES = ["ok", "cache-hit", "rules-only", "off"] as const;

export type LlmCounts = {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cached: number;
  /** Answered by a later provider or by rules because an earlier one could not. */
  fallbacks: number;
  /** Ended without a model answer for a reason other than the Owner's mode (budget, errors). */
  failures: number;
  cachePct: number | null;
  fallbackPct: number | null;
};
export type LlmRoleRow = LlmCounts & { role: string; provider: string };
export type LlmDayRow = LlmCounts & { d: string; provider: string };
export type LlmUsage = { sinceD: string; byRole: LlmRoleRow[]; byDay: LlmDayRow[] };

export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.floor((part * PERCENT * 2 + whole) / (whole * 2)) : null;
}

const SELECT = `COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout,
  COALESCE(SUM(cached), 0) AS cached,
  COALESCE(SUM(CASE WHEN fallback_depth <> '0' THEN 1 ELSE 0 END), 0) AS fallbacks,
  COALESCE(SUM(CASE WHEN outcome NOT IN (${NORMAL_OUTCOMES.map(() => "?").join(",")}) THEN 1 ELSE 0 END), 0) AS failures`;

type Row = Record<string, unknown>;
const int = (v: unknown): number => Number(v ?? 0); // money-float-ok: SQL count or token total

function counts(r: Row): LlmCounts {
  const calls = int(r.calls);
  const cached = int(r.cached);
  const fallbacks = int(r.fallbacks);
  return {
    calls,
    tokensIn: int(r.tin),
    tokensOut: int(r.tout),
    cached,
    fallbacks,
    failures: int(r.failures),
    cachePct: pct(cached, calls),
    fallbackPct: pct(fallbacks, calls),
  };
}

const dayAt = (now: Date, back: number): string =>
  new Date(now.getTime() - back * DAY_MS).toISOString().slice(0, 10);

export async function loadLlmUsage(
  db: Pick<Client, "execute">,
  role: string | null | undefined,
  now: Date,
  market = "AU",
): Promise<LlmUsage | null> {
  if (role !== "owner") return null;
  const sinceD = dayAt(now, ROLE_DAYS);
  const dayFrom = dayAt(now, DAY_ROWS_DAYS);
  const byRole = await db.execute({
    sql: `SELECT role, provider, ${SELECT} FROM llm_call WHERE market = ? AND d >= ?
          GROUP BY role, provider ORDER BY calls DESC, role, provider LIMIT ?`,
    args: [...NORMAL_OUTCOMES, market, sinceD, MAX_ROWS],
  });
  const byDay = await db.execute({
    sql: `SELECT d, provider, ${SELECT} FROM llm_call WHERE market = ? AND d >= ?
          GROUP BY d, provider ORDER BY d DESC, provider LIMIT ?`,
    args: [...NORMAL_OUTCOMES, market, dayFrom, MAX_ROWS],
  });
  return {
    sinceD,
    byRole: byRole.rows.map((r) => ({
      role: String(r.role),
      provider: String(r.provider),
      ...counts(r),
    })),
    byDay: byDay.rows.map((r) => ({ d: String(r.d), provider: String(r.provider), ...counts(r) })),
  };
}
