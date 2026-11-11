import type { AuCostProfile } from "./seed/au/costProfiles.mjs";
import type { MarketProfile } from "./profileCore.mjs";

export function staticProfile(code: string): MarketProfile;
export function homeProfile(): MarketProfile;
export function costProfilesOf(code: string): Readonly<Record<string, AuCostProfile>>;
export function benchmarkIndexOf(code: string): string;
