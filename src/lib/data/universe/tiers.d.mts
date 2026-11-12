export const MICRO: bigint;
export type TierRules = {
  readonly windowSessions: number;
  readonly u1: {
    readonly advMicro: bigint;
    readonly priceMicro: bigint;
    readonly top: number;
    readonly minSessions: number;
  };
  readonly u2: {
    readonly advMicro: bigint;
    readonly priceMicro: bigint;
    readonly listedDays: number;
    readonly mcapMicro: bigint;
  };
  readonly u3: { readonly advMicro: bigint; readonly priceMicro: bigint };
};
export const TIER_RULES: TierRules;
/** The tier table of a market profile (M20 A4); throws when it is not set. */
export function tierRulesOf(profile: { readonly code: string; readonly tiers: unknown }): TierRules;
export function medianMicro(values: readonly bigint[]): bigint;
export type TierInput = {
  code: string;
  priceMicro: bigint;
  tradedMicro: bigint[];
  listedSince: string | null;
  mcapMicro?: bigint | null;
};
export type TierOut =
  | { tier: "U1" | "U2" | "U3"; status: "active"; advMicro: bigint | null }
  | { tier: "U3"; status: "below_floor"; advMicro: bigint | null };
export function assignTiers(
  rows: TierInput[],
  d: string,
  rules?: TierRules,
): Map<string, TierOut>;
