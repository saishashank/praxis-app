// The seed shape of the `components` fee rule (M20 A4, D-1102): used by in/costProfiles.mjs and us/costProfiles.mjs.
export type ComponentItem = {
  readonly name: string;
  readonly side: "buy" | "sell" | "both";
  /** value: rate x order value; per_share: rate (currency units) x quantity; per_order: rate (currency units); pct_of: rate x sum of the `of` items. */
  readonly basis: "value" | "per_share" | "per_order" | "pct_of";
  readonly of?: readonly string[];
  /** Decimal text (a trailing % is a percentage): a fraction for value / pct_of, currency units otherwise. */
  readonly rate: string;
  /** Currency units as decimal text; clamps the item's exact amount before rounding. */
  readonly min?: string;
  readonly max?: string;
  readonly effective_from: string | null;
  readonly source_ref: string;
};
export type ComponentsFeeRule = {
  readonly kind: "components";
  readonly round: "total_half_up_cent" | "per_item_half_up_cent";
  readonly items: readonly ComponentItem[];
};
export type ComponentsCostProfile = {
  readonly code: string;
  readonly version: number;
  readonly name: string;
  readonly specRef: string;
  readonly verify: true;
  readonly verified: boolean;
  readonly rule: ComponentsFeeRule;
};
