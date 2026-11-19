export type AuFeeRule =
  | { readonly kind: "flat"; readonly feeMicro: bigint }
  | {
      readonly kind: "tiered";
      readonly tiers: readonly { readonly upToMicro: bigint; readonly feeMicro: bigint }[];
      readonly above: AuFeeRule;
    }
  | {
      readonly kind: "pct";
      /** Decimal-percent text such as "0.12%"; the engine parses it with parseRational. */
      readonly rate: string;
      readonly minMicro: bigint;
      readonly maxMicro: bigint | null;
      readonly freeFirstBuyBelowMicro: bigint | null;
    }
  | { readonly kind: "zeroFeeListElse"; readonly otherwise: AuFeeRule };

export type AuCostProfile = {
  readonly code: string;
  readonly version: number;
  readonly name: string;
  readonly specRef: string;
  readonly verify: true;
  readonly verified: boolean;
  readonly rule: AuFeeRule;
};

export const AU_COST_PROFILES: Readonly<Record<string, AuCostProfile>>;
export const AU_COST_PROFILE_CODES: readonly string[];
