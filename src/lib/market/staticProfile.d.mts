import type { CostPlanText } from "./seed/au/costPlans.mjs";
import type { AuCostProfile } from "./seed/au/costProfiles.mjs";
import type { ComponentsCostProfile } from "./seed/componentsRule.mjs";
import type { MarketProfile } from "./profileCore.mjs";

export function staticProfile(code: string): MarketProfile;
export function homeProfile(): MarketProfile;
export function costProfilesOf(
  code: string,
): Readonly<Record<string, AuCostProfile | ComponentsCostProfile>>;
export function costPlansOf(code: string): Readonly<Record<string, CostPlanText>>;
export function benchmarkIndexOf(code: string): string;
