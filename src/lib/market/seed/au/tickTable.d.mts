export type AuTickBand = { readonly fromMicro: bigint; readonly tickMicro: bigint };
export const AU_TICK_TABLE: readonly AuTickBand[];

export const AU_SLIPPAGE: {
  readonly buckets: readonly { readonly fromAdvMicro: bigint; readonly bps: number }[];
  readonly tick_cross_factor: number;
  readonly stall_floor_bps: number;
  readonly untradeable_adv_fraction: { readonly num: number; readonly den: number };
  readonly half_spread_ppm_by_tier: Readonly<Record<"U1" | "U2" | "U3", bigint>>;
};

export const AU_TIERS: {
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
