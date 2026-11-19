// US tick table, slippage buckets and liquidity tiers (M20 A4; D-1104, D-1118, D-1131, D-1132). Plain ESM data in
// micro units of USD. Every figure is [VERIFY].
const MICRO = 1_000_000n;
const USD = (dollars) => BigInt(dollars) * MICRO;

/**
 * USD 0.0001 below USD 1.00, USD 0.01 from USD 1.00 (lower-inclusive). Source: SEC Rule 612 of Regulation NMS
 * (minimum pricing increment: a cent at or above USD 1.00, a hundredth of a cent below), 17 CFR 242.612; not read
 * in this build [VERIFY].
 */
export const US_TICK_TABLE = Object.freeze([
  Object.freeze({ fromMicro: 0n, tickMicro: 100n }),
  Object.freeze({ fromMicro: USD(1), tickMicro: 10_000n }),
]);

/**
 * [VERIFY] pending a price source (D-1132): the US extract has no price history, so buckets.json is empty. The
 * edges are AU's A$5M / 1M / 250k / 100k converted at a fixed A$1 = US$0.65 (D-1151) and rounded half-up to
 * USD 10,000: 3,250,000; 650,000; 162,500 -> 160,000; 65,000 -> 70,000. bps and factors are AU's (ARN-118).
 * Replace them with percentile edges when a price source exists.
 */
export const US_SLIPPAGE = Object.freeze({
  buckets: Object.freeze([
    Object.freeze({ fromAdvMicro: USD(3_250_000), bps: 10 }),
    Object.freeze({ fromAdvMicro: USD(650_000), bps: 25 }),
    Object.freeze({ fromAdvMicro: USD(160_000), bps: 60 }),
    Object.freeze({ fromAdvMicro: USD(70_000), bps: 120 }),
  ]),
  tick_cross_factor: 1,
  stall_floor_bps: 10,
  untradeable_adv_fraction: Object.freeze({ num: 1, den: 200 }),
  half_spread_ppm_by_tier: Object.freeze({ U1: 500n, U2: 2_500n, U3: 7_500n }),
});

/**
 * [VERIFY] pending a price source (D-1132): AU's tier table at A$1 = US$0.65, ADV edges rounded half-up to
 * USD 10,000 (650,000; 160,000; 70,000), price floors to the cent (A$0.50 -> 0.33, A$0.20 -> 0.13,
 * A$0.10 -> 0.07), U2 market cap A$30M -> USD 19,500,000; `top` 300, sessions and listing days are AU's.
 */
export const US_TIERS = Object.freeze({
  windowSessions: 60,
  u1: Object.freeze({
    advMicro: USD(650_000),
    priceMicro: 330_000n,
    top: 300,
    minSessions: 54,
  }),
  u2: Object.freeze({
    advMicro: USD(160_000),
    priceMicro: 130_000n,
    listedDays: 365,
    mcapMicro: USD(19_500_000),
  }),
  u3: Object.freeze({ advMicro: USD(70_000), priceMicro: 70_000n }),
});
