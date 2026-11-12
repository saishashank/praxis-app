import type { ComponentsCostProfile } from "./componentsRule.mjs";
export type CostVersion = {
  readonly code: string;
  readonly version: number;
  readonly effective_from: string;
  readonly profile: ComponentsCostProfile;
};
export const COST_VERSION_TABLES: Readonly<Record<string, readonly CostVersion[]>>;
export function costVersionsOf(market: string): readonly CostVersion[];
