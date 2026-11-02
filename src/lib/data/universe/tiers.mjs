// ARN-010 tiers from stored bars, point in time (D-189). Pure ESM + JSDoc (the Batch 1 CLI runs it
// without a TS build; the replay world imports it too, so both compute the same tiers).
//
// spec 05 ARN-010: "Tiers are recomputed daily from point-in-time data and stored with every trade.
// U1 = top 300 codes by 60-session median traded value (plus listed ETFs) with raw price >= A$0.50
// - computed from stored raw bars, not index membership."
//   | U1 Core      | ADV >= A$1M; price >= A$0.50                                          |
//   | U2 Extended  | ADV >= A$250k; price >= A$0.20; >= 12 months listed; mcap >= A$30M    |
//   | U3 Discovery | ADV >= A$100k; price >= A$0.10                                        |
// ADV here is the 60-session median traded value (close x volume) of the bars up to the night.
// Not applied yet (recorded in D-189): the market-cap test of U2 is skipped while no market cap is
// known (mcap null), and "plus listed ETFs" is not added (the universe holds companies).
// D-253: U1 needs stored bars on at least 54 of the 60 sessions (90 %), not on all 60. ARN-010 asks
// for the 60-session median, not a bar every session; a vendor miss on a few days (a partial night,
// a trading halt) kept every large company out of U1. A recent listing (fewer bars) still stays out.
// A code below the U3 floor gets no tier: it is stored with status `below_floor` and no family sees it.

export const MICRO = 1_000_000n;
/** spec 05 ARN-010 table, micro-AUD. */
export const TIER_RULES = Object.freeze({
  windowSessions: 60,
  u1: { advMicro: 1_000_000n * MICRO, priceMicro: 500_000n, top: 300, minSessions: 54 },
  u2: {
    advMicro: 250_000n * MICRO,
    priceMicro: 200_000n,
    listedDays: 365,
    mcapMicro: 30_000_000n * MICRO,
  },
  u3: { advMicro: 100_000n * MICRO, priceMicro: 100_000n },
});

/** Median of a non-empty list (the lower middle of an even count: never an invented value). */
export function medianMicro(values) {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * @typedef {{
 *   code: string,
 *   priceMicro: bigint,          raw close of the night
 *   tradedMicro: bigint[],       close x volume of each stored bar in the last 60 sessions
 *   listedSince: string | null,  date of the first stored bar (or the listing date)
 *   mcapMicro?: bigint | null,
 * }} TierInput
 * @typedef {{ tier: "U1" | "U2" | "U3", status: "active" } | { tier: "U3", status: "below_floor" }} TierOut
 */

/** 365 days before `d` (YYYY-MM-DD), calendar arithmetic in UTC. */
function yearBefore(d, days) {
  const t = Date.parse(`${d}T00:00:00Z`) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Tiers of every code for the night `d`. Ties for the U1 top 300 are broken by code so the result
 * is deterministic.
 * @param {TierInput[]} rows @param {string} d
 * @returns {Map<string, TierOut & { advMicro: bigint | null }>}
 */
export function assignTiers(rows, d) {
  const R = TIER_RULES;
  const out = new Map();
  const withAdv = rows.map((r) => ({
    ...r,
    adv: r.tradedMicro.length === 0 ? null : medianMicro(r.tradedMicro),
  }));
  const u1 = withAdv
    .filter(
      (r) =>
        r.adv !== null &&
        r.tradedMicro.length >= R.u1.minSessions &&
        r.adv >= R.u1.advMicro &&
        r.priceMicro >= R.u1.priceMicro,
    )
    .sort((a, b) => (a.adv > b.adv ? -1 : a.adv < b.adv ? 1 : a.code < b.code ? -1 : 1))
    .slice(0, R.u1.top);
  const inU1 = new Set(u1.map((r) => r.code));
  const listedBy = yearBefore(d, R.u2.listedDays);
  for (const r of withAdv) {
    let t;
    if (inU1.has(r.code)) t = { tier: "U1", status: "active" };
    else if (
      r.adv !== null &&
      r.adv >= R.u2.advMicro &&
      r.priceMicro >= R.u2.priceMicro &&
      r.listedSince !== null &&
      r.listedSince <= listedBy &&
      (r.mcapMicro == null || r.mcapMicro >= R.u2.mcapMicro)
    )
      t = { tier: "U2", status: "active" };
    else if (r.adv !== null && r.adv >= R.u3.advMicro && r.priceMicro >= R.u3.priceMicro)
      t = { tier: "U3", status: "active" };
    else t = { tier: "U3", status: "below_floor" };
    out.set(r.code, { ...t, advMicro: r.adv });
  }
  return out;
}
