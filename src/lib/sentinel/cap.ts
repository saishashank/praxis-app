// DAT-251 b (D-954): how many announcements one Sentinel call may assess.
//   effective cap = min(news_assess_per_run, LLM headroom cap, Turso cap)
//   LLM headroom cap  the items the rest of today's LLM budget can assess at the measured cost per item
//   Turso cap         40 (the old AGT-010 / PLT-075 ceiling) while the Turso meter is at `notice` or worse
// So the key can only raise the cap inside the LLM budget and the 20 % Turso line. Today's Sentinel
// assessment is rules-only (materiality.ts), so its measured LLM cost per item is 0 and the headroom cap
// does not bind; the branch is live the moment an assessment spends tokens (M22).
// Rows-ok: two reads, both single rows (the newest usage sample, today's token sum over run_record).
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import {
  dayBounds,
  latestTursoSample,
  levelFor,
  monthBounds,
  TURSO_FREE_PLAN,
  tursoThresholds,
  type MeterLevel,
} from "@/lib/usage/meters";

/** The Turso cap: the old fixed ceiling, applied only near the Turso line. */
export const TURSO_NEAR_LINE_CAP = 40; // threshold-ok: DAT-251 b / D-954, fixed
/** Measured LLM tokens one assessed item costs today: the Sentinel is rules-only, so none. */
export const LLM_TOKENS_PER_ITEM = 0; // threshold-ok: measured, see the header

export type CapInputs = {
  /** `news_assess_per_run`. */
  key: number;
  /** Tokens left in today's LLM budget, or null when unknown. */
  llmRemainingTokens: number | null;
  /** Measured tokens per assessed item (0 = the assessment spends none). */
  tokensPerItem: number;
  /** Worst Turso meter level. */
  tursoLevel: MeterLevel;
};

export type EffectiveCap = {
  cap: number;
  key: number;
  llmHeadroomCap: number | null; // null = not limited by the LLM budget
  tursoCap: number | null; // null = not limited by Turso
};

/** Pure: the three-way minimum. A cap is never below 1, so the queue always moves. */
export function effectiveAssessCap(i: CapInputs): EffectiveCap {
  const llmHeadroomCap =
    i.tokensPerItem > 0 && i.llmRemainingTokens !== null
      ? Math.max(0, Math.floor(i.llmRemainingTokens / i.tokensPerItem))
      : null;
  const tursoCap =
    i.tursoLevel === "notice" || i.tursoLevel === "alert" || i.tursoLevel === "degrade"
      ? TURSO_NEAR_LINE_CAP
      : null;
  const cap = Math.max(1, Math.min(i.key, llmHeadroomCap ?? Infinity, tursoCap ?? Infinity));
  return { cap, key: i.key, llmHeadroomCap, tursoCap };
}

/** The worst Turso level from the newest platform sample; no usable sample = `ok` (the estimate is not read here). */
export async function tursoLevelNow(db: Client, now: Date): Promise<MeterLevel> {
  const [ceilingPct, noticePct] = await Promise.all([
    getConfig(db, "turso_free_ceiling_pct") as Promise<number>,
    getConfig(db, "turso_notice_pct") as Promise<number>,
  ]);
  const sample = await latestTursoSample(db, now, monthBounds(now));
  if (sample === null) return "ok";
  const t = tursoThresholds(noticePct, ceilingPct);
  const limit = (plan: number) => (plan * ceilingPct) / 100;
  const ratios = [
    sample.rowsRead / limit(TURSO_FREE_PLAN.rowsRead),
    sample.rowsWritten / limit(TURSO_FREE_PLAN.rowsWritten),
  ];
  const order: MeterLevel[] = ["ok", "notice", "alert", "degrade"];
  return ratios
    .map((r) => levelFor(r, t))
    .reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), "ok" as MeterLevel);
}

/** Reads the inputs and returns the effective cap for this call. */
export async function loadEffectiveCap(db: Client, now: Date): Promise<EffectiveCap> {
  const key = Number(await getConfig(db, "news_assess_per_run"));
  const budget = Number(await getConfig(db, "llm_daily_budget_total"));
  const day = dayBounds(now);
  const used = await db.execute({
    sql: `SELECT SUM(llm_tokens) AS t FROM run_record WHERE started_at >= ? AND started_at < ?`,
    args: [day.start, day.end],
  });
  const remaining = Number.isFinite(budget)
    ? Math.max(0, budget - Number(used.rows[0]?.t ?? 0))
    : null;
  return effectiveAssessCap({
    key: Number.isInteger(key) ? key : TURSO_NEAR_LINE_CAP,
    llmRemainingTokens: remaining,
    tokensPerItem: LLM_TOKENS_PER_ITEM,
    tursoLevel: await tursoLevelNow(db, now),
  });
}
