// India (NSE) tick table, slippage buckets and liquidity tiers (M20 A4; D-1104, D-1118, D-1131). Plain ESM data in
// micro units of INR. Every figure is [VERIFY] until evidence is recorded.
const MICRO = 1_000_000n;
const INR = (rupees) => BigInt(rupees) * MICRO;

/**
 * Rs 0.01 below Rs 250, Rs 0.05 from Rs 250 (lower-inclusive edges). Source: the NSE circular reducing the tick
 * size of securities priced up to Rs 250 to Rs 0.01 (2024), nseindia.com; not read in this build [VERIFY]. The
 * fall-back, if A3 cannot confirm it, is the flat Rs 0.05 of the M19 seed (D-1104).
 */
export const IN_TICK_TABLE = Object.freeze([
  Object.freeze({ fromMicro: 0n, tickMicro: 10_000n }),
  Object.freeze({ fromMicro: INR(250), tickMicro: 50_000n }),
]);

/**
 * Edges: ADV percentiles of the NSE bhavcopy extract (3,224 codes, as of 2026-11-12), the same percentile ranks
 * as AU's A$5M / 1M / 250k / 100k edges, rounded half-up to Rs 100,000 (buckets.json of task A1: 791,700,000;
 * 271,500,000; 122,000,000; 66,500,000). bps, tick_cross_factor, stall_floor_bps (D-1118), the un-tradeable
 * fraction and the half-spread floors are AU's, unchanged (ARN-118).
 */
export const IN_SLIPPAGE = Object.freeze({
  buckets: Object.freeze([
    Object.freeze({ fromAdvMicro: INR(791_700_000), bps: 10 }),
    Object.freeze({ fromAdvMicro: INR(271_500_000), bps: 25 }),
    Object.freeze({ fromAdvMicro: INR(122_000_000), bps: 60 }),
    Object.freeze({ fromAdvMicro: INR(66_500_000), bps: 120 }),
  ]),
  tick_cross_factor: 1,
  stall_floor_bps: 10,
  untradeable_adv_fraction: Object.freeze({ num: 1, den: 200 }),
  half_spread_ppm_by_tier: Object.freeze({ U1: 500n, U2: 2_500n, U3: 7_500n }),
});

/**
 * Tier edges from the same extract (buckets.json `tiers`: 189,200,000; 88,700,000; 48,100,000 INR); `top` is
 * the same share of codes as AU's top 300 of 1,839 (16.31 %): 514 of 3,148 (A1 `u1_top`). The price floors and
 * the U2 market-cap floor are AU's converted at a fixed rate of Rs 55 per A$ (D-1151, [VERIFY]): A$0.50 -> Rs 27.50,
 * A$0.20 -> Rs 11.00, A$0.10 -> Rs 5.50, A$30M -> Rs 1,650M. Sessions and listing days are AU's.
 */
export const IN_TIERS = Object.freeze({
  windowSessions: 60,
  u1: Object.freeze({
    advMicro: INR(189_200_000),
    priceMicro: 27_500_000n,
    top: 514,
    minSessions: 54,
  }),
  u2: Object.freeze({
    advMicro: INR(88_700_000),
    priceMicro: INR(11),
    listedDays: 365,
    mcapMicro: INR(1_650_000_000),
  }),
  u3: Object.freeze({ advMicro: INR(48_100_000), priceMicro: 5_500_000n }),
});
