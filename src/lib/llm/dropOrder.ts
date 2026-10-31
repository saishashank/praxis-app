// Drop order of the LLM stages when the daily total runs short (LLM-050 s13, LLM-062, D-482).
// Earlier entries are dropped first; the Evening Review text (R5) is dropped last. A stage may spend
// only what is left after the caps of the stages that come after it, so a late stage is never starved.
// Stages that do not exist in code yet (experts, Committee, overviews, news summaries) are listed
// with no cap. Every figure comes from LlmParams; nothing here is a literal rule value.
import type { LlmParams } from "@/lib/agents/params";
import { scaledCap, type BudgetUsage, type Role } from "./budget";

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
    default:
      // pick_reflection (WP8, optional) has no cap of its own: it runs inside R3's existing cap,
      // whose share is added by the stage when it exists (D-482, D-496).
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

/** The role whose daily cap a stage spends from, when it has one. */
function stageRole(stage: DropStage): Role | null {
  switch (stage) {
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
 * stages of their market-scaled cap minus what their role has already used today (never below zero).
 * A later stage that has already run (the Evening Review text is written in batch 3, before the
 * steelman) is not reserved for twice.
 */
export async function reserveAfterLeft(
  stage: DropStage,
  params: LlmParams,
  market: string,
  usage: (role: Role) => Promise<BudgetUsage>,
): Promise<number> {
  const i = DROP_ORDER.indexOf(stage);
  const share = params.marketShare[market];
  let sum = 0;
  for (const s of DROP_ORDER.slice(i + 1)) {
    const role = stageRole(s);
    if (role === null) continue;
    const cap = scaledCap(stageCap(s, params), share);
    sum += Math.max(0, cap - (await usage(role)).roleDay);
  }
  return sum;
}
