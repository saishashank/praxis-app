export type ShortRules = {
  readonly naked: boolean;
  readonly borrow: string;
  readonly shortableTiers: readonly string[];
  readonly borrowBpsPa: number;
  readonly verify: number;
};
export const SHORT_RULES: Readonly<Record<string, ShortRules>>;
export function shortRulesOf(market: string): ShortRules;
export function hasShortRules(market: string): boolean;
