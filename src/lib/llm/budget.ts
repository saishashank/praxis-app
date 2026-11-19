// Token budget accounting (LLM-050, LLM-021, design 4.6 decision 2). Both token caps apply and the
// stricter wins: the role's daily cap and the all-roles daily total (each scaled by the market's
// share, an exact fraction), and, for nightly-batch calls, the per-market nightly cap. Every
// threshold comes from LlmParams; nothing here is a literal rule value.
import type { LlmParams } from "@/lib/agents/params";

export type Role = "R1" | "R2" | "R3" | "R5" | "R6" | "R7";
export const ROLES: readonly Role[] = ["R1", "R2", "R3", "R5", "R6", "R7"];

/**
 * M22 (D-1410): the key a call's tokens are charged to and logged under (`llm_call.role`). A role is its own bucket, except R7
 * (the Committee judge), which spends the Committee bucket; the two named buckets are shared by several roles: Committee
 * debaters and the judge, and expert triage and extraction. The roles' caps and the two buckets partition the daily total.
 */
export type BudgetKey = Role | "committee" | "experts";

/** The keys that carry their own daily cap (R7 reads the Committee cap and is never charged directly). */
export const BUDGET_KEYS: readonly BudgetKey[] = [
  "R1",
  "R2",
  "R3",
  "R5",
  "R6",
  "committee",
  "experts",
];

/** The bucket a key is charged to: R7 spends the Committee bucket, every other key is its own bucket. */
export const bucketOf = (key: BudgetKey): BudgetKey => (key === "R7" ? "committee" : key);

/** Rough token estimate (characters per token) used only to size the pre-call reservation. */
const CHARS_PER_TOKEN = 4; // threshold-ok: estimation heuristic, not a rule threshold

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type BudgetUsage = {
  /** Tokens already spent today by this budget key (role or bucket) in this market. */
  roleDay: number;
  /** Tokens already spent today by all roles in this market. */
  totalDay: number;
  /** Tokens already spent today by nightly-batch calls in this market. */
  marketNight: number;
};

export type BudgetBinding = "role" | "total" | "nightly";

export type Allowance = { allowed: number; binding: BudgetBinding };

/** floor(cap x share) with exact integer arithmetic; a market without a share gets nothing. */
export function scaledCap(cap: number, share: { num: bigint; den: bigint } | undefined): number {
  if (!share || share.den === 0n) return 0;
  return Number((BigInt(cap) * share.num) / share.den);
}

export function allowance(
  params: LlmParams,
  key: BudgetKey,
  market: string,
  nightly: boolean,
  usage: BudgetUsage,
): Allowance {
  const share = params.marketShare[market];
  const candidates: Allowance[] = [
    { allowed: scaledCap(params.roleDailyTokens[key], share) - usage.roleDay, binding: "role" },
    { allowed: scaledCap(params.dailyTotal, share) - usage.totalDay, binding: "total" },
  ];
  if (nightly) {
    candidates.push({
      allowed: params.nightlyTokensPerMarket - usage.marketNight,
      binding: "nightly",
    });
  }
  let best = candidates[0];
  for (const c of candidates) if (c.allowed < best.allowed) best = c;
  return { allowed: Math.max(0, best.allowed), binding: best.binding };
}

/** True when a call projected to use `projected` tokens fits under the stricter cap. */
export function fits(allow: Allowance, projected: number): boolean {
  return projected <= allow.allowed;
}
