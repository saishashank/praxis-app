// M17 WP9 (D-311, D-464): the round-trip cost of one intraday-stream candidate, the SAME rule as the
// Cortex calibration (`costPerOrder`: fee + max(ARN-032 slippage, half-spread floor) on each fill) at the
// standard parcel, so the stream is never judged on cheaper costs than the Cortex. Lives outside
// `src/lib/intraday` because the cost profile table is an arena module (AT-60 import guard).
import type { Client } from "@libsql/client";
import { COST_PROFILES, COST_PROFILE_CODES } from "@/lib/arena/costs";
import { getConfig } from "@/lib/config/store";
import {
  ADV_FLOOR_PER_PARCEL_MICRO,
  costPerOrder,
  type LiquidityTier,
} from "@/lib/cortex/economics/cost";

/** Standard parcel of the stream's cost: A$1,000 (D-464). */
export const STREAM_PARCEL_MICRO = 1_000_000_000n; // threshold-ok: standard parcel A$1,000
const MICRO = 1_000_000; // threshold-ok: micro units

/**
 * Round-trip cost in ppm of the parcel for `code` as of `sessionD`: tier and ADV from the latest
 * universe snapshot on or before the session (no row: tier U3 at the ADV floor, the dearest case).
 */
export async function streamCostPpm(
  db: Client,
  market: string,
  code: string,
  sessionD: string,
  priceDollars: number,
): Promise<number> {
  const snap = (
    await db.execute({
      sql: `SELECT tier, adv FROM universe_snapshot WHERE market = ? AND code = ? AND d <= ?
            ORDER BY d DESC LIMIT 1`,
      args: [market, code, sessionD],
    })
  ).rows[0];
  const tier = (snap === undefined ? "U3" : String(snap.tier)) as LiquidityTier;
  const advMicro =
    snap === undefined || snap.adv === null
      ? ADV_FLOOR_PER_PARCEL_MICRO
      : BigInt(Math.round(Number(snap.adv) * MICRO)); // money-float-ok: boundary conversion
  const code0 = String(await getConfig(db, "cost_profile_default"));
  const profile =
    COST_PROFILES[
      (COST_PROFILE_CODES as readonly string[]).includes(code0)
        ? (code0 as keyof typeof COST_PROFILES)
        : "P5"
    ];
  return costPerOrder({
    profile,
    notionalMicro: STREAM_PARCEL_MICRO,
    priceMicro: BigInt(Math.max(1, Math.round(priceDollars * MICRO))), // money-float-ok
    tier,
    advMicro,
  }).ppm;
}
