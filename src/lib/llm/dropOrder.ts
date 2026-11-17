// Drop order of the LLM stages when the daily total runs short (LLM-050 s13, LLM-062, D-482).
// Earlier entries are dropped first; the Evening Review text (R5) is dropped last. A stage may spend
// only what is left after the caps of the stages that come after it, so a late stage is never starved.
// M22 (D-1411): the expert and Committee stages take their bucket caps; reflections spend the R6 bucket (shared with the
// steelman) and are reserved per night by the caller. Stages that do not exist in code yet (overviews, news summaries) are
// listed with no cap. Every figure comes from LlmParams; nothing here is a literal rule value.
import type { LlmParams } from "@/lib/agents/params";
import { scaledCap, type BudgetKey, type BudgetUsage } from "./budget";

export const DROP_ORDER = [
  "expert_ingest",
  "committee",
  "company_overview",
  "news_summary",
  "steelman",
  "pick_reflection",
  "evening_review",
] as const;
export type DropStage = (typeof DROP_ORDER)[number];

/** Daily token cap of a stage that exists in code today; 0 for a stage that does not (yet). */
function stageCap(stage: DropStage, params: LlmParams): number {
  switch (stage) {
    case "evening_review":
      return params.roleDailyTokens.R5;
    case "steelman":
      return params.roleDailyTokens.R6;
    case "expert_ingest":
      return params.roleDailyTokens.experts;
    case "committee":
      return params.roleDailyTokens.committee;
    default:
      // pick_reflection spends the R6 bucket with the steelman (D-1411, D-1424): no cap of its own, a per-night
      // reservation instead (reserveAfterLeft). Overviews and news summaries do not exist in code yet.
      return 0;
  }
}

/** Sum of the daily caps of the stages after `stage` (D-482). */
export function reserveAfter(stage: DropStage, params: LlmParams): number {
  const i = DROP_ORDER.indexOf(stage);
  let sum = 0;
  for (const s of DROP_ORDER.slice(i + 1)) sum += stageCap(s, params);
  return sum;
}

/** The budget key whose daily cap a stage spends from, when it has one. */
function stageRole(stage: DropStage): BudgetKey | null {
  switch (stage) {
    case "expert_ingest":
      return "experts";
    case "committee":
      return "committee";
    case "evening_review":
      return "R5";
    case "steelman":
      return "R6";
    default:
      return null;
  }
}

/**
 * D-505: what the stages after `stage` still have to spend tonight in one market: the sum over those
 * stages of their market-scaled cap minus what their budget key has already used today (never below zero).
 * A later stage that has already run (the Evening Review text is written in batch 3, before the
 * steelman) is not reserved for twice.
 *
 * D-1411: `reflectionReserve` (tokens, default 0; the caller sizes it for the picks that settled tonight, as the words
 * phase sizes its R5 reservation) is what the steelman leaves for the reflections that follow it, limited to the R6 cap
 * still unspent. It applies only to a stage that comes at or after the steelman: an earlier stage already counts the
 * whole R6 cap, reflections included.
 */
export async function reserveAfterLeft(
  stage: DropStage,
  params: LlmParams,
  market: string,
  usage: (key: BudgetKey) => Promise<BudgetUsage>,
  reflectionReserve = 0,
): Promise<number> {
  const i = DROP_ORDER.indexOf(stage);
  const share = params.marketShare[market];
  const steelmanAhead = DROP_ORDER.indexOf("steelman") > i;
  let sum = 0;
  for (const s of DROP_ORDER.slice(i + 1)) {
    if (s === "pick_reflection") {
      if (steelmanAhead || reflectionReserve <= 0) continue; // inside R6's cap, which the steelman's share already counts
      const r6Left = Math.max(
        0,
        scaledCap(params.roleDailyTokens.R6, share) - (await usage("R6")).roleDay,
      );
      sum += Math.min(reflectionReserve, r6Left);
      continue;
    }
    const role = stageRole(s);
    if (role === null) continue;
    const cap = scaledCap(stageCap(s, params), share);
    sum += Math.max(0, cap - (await usage(role)).roleDay);
  }
  return sum;
}
