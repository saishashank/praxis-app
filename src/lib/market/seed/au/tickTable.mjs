// AU tick table, slippage buckets and liquidity tiers, moved byte-for-byte from src/lib/money/tick.ts,
// src/lib/arena/slippage.ts, src/lib/cortex/economics/cost.ts and src/lib/data/universe/tiers.mjs
// (M19 A1, D-1003 d). Plain ESM data in micro units of the market currency (AUD). The engines (stream B2)
// take these as arguments; an edit here is a new money constant (D-710, D-817).

/**
 * [VERIFY] AU tick table as written in spec 05 ARN-032 (l.65): A$0.001 below A$0.10, A$0.005 for A$0.10 to
 * below A$2.00, A$0.01 from A$2.00. Band edges are lower-inclusive.
 */
export const AU_TICK_TABLE = Object.freeze([
  Object.freeze({ fromMicro: 0n, tickMicro: 1_000n }),
  Object.freeze({ fromMicro: 100_000n, tickMicro: 5_000n }),
  Object.freeze({ fromMicro: 2_000_000n, tickMicro: 10_000n }),
]);

/**
 * ARN-032 slippage: ADV buckets (lower-inclusive edge of 20-session ADV in micro-AUD, bps of the reference
 * price, high to low), the default tick-cross factor, the stall-floor bps (decision 4), the ARN-013
 * un-tradeable ADV fraction written as a ratio (decision 12), and the CTX-071 half-spread floors by tier in
 * ppm of the price (D-294). Numbers only: the engine turns them into rationals as it does today.
 */
export const AU_SLIPPAGE = Object.freeze({
  buckets: Object.freeze([
    Object.freeze({ fromAdvMicro: 5_000_000_000_000n, bps: 10 }),
    Object.freeze({ fromAdvMicro: 1_000_000_000_000n, bps: 25 }),
    Object.freeze({ fromAdvMicro: 250_000_000_000n, bps: 60 }),
    Object.freeze({ fromAdvMicro: 100_000_000_000n, bps: 120 }),
  ]),
  tick_cross_factor: 1,
  stall_floor_bps: 10,
  untradeable_adv_fraction: Object.freeze({ num: 1, den: 200 }),
  half_spread_ppm_by_tier: Object.freeze({ U1: 500n, U2: 2_500n, U3: 7_500n }),
});

const MICRO = 1_000_000n;

/** spec 05 ARN-010 table, micro-AUD (D-189, D-861). */
export const AU_TIERS = Object.freeze({
  windowSessions: 60,
  u1: Object.freeze({
    advMicro: 1_000_000n * MICRO,
    priceMicro: 500_000n,
    top: 300,
    minSessions: 54,
  }),
  u2: Object.freeze({
    advMicro: 250_000n * MICRO,
    priceMicro: 200_000n,
    listedDays: 365,
    mcapMicro: 30_000_000n * MICRO,
  }),
  u3: Object.freeze({ advMicro: 100_000n * MICRO, priceMicro: 100_000n }),
});
