// The per-market money constants every engine call site threads (M20 IN1, D-1154 items 1-3, D-1170): the settlement
// lag, the tick grid, the slippage buckets and the parcel floor of one market's seed profile. For the home market
// each value is the very constant the engines default to (`TICK_TABLE`, `SLIPPAGE_BUCKETS`,
// `MIN_MARKETABLE_PARCEL_MICRO`, `SETTLEMENT_LAG_SESSIONS`), so passing it changes nothing for AU (AT-32).
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import type { Micro } from "@/lib/money/micro";
import type { TickBand } from "@/lib/money/tick";
import { slippageBucketsOf, type SlippageBucket } from "./slippage";

export type MarketMoney = {
  readonly market: string;
  /** Sessions between trade date and settlement (`settlement_days`; AU 2, IN 1). */
  readonly lagSessions: number;
  readonly tickTable: readonly TickBand[];
  readonly buckets: readonly SlippageBucket[];
  /** The marketable-parcel floor (`parcel_floor`; AU A$500, IN Rs 25,000). */
  readonly parcelMicro: Micro;
};

const CACHE = new Map<string, MarketMoney>();

/** The money constants of a market; throws (never defaults) for a market whose profile lacks one. */
export function marketMoney(market: string): MarketMoney {
  const hit = CACHE.get(market);
  if (hit !== undefined) return hit;
  const p = staticProfile(market);
  if (p.settlementDays === null || p.tickTable === null || p.parcelFloorMicro === null) {
    throw new RangeError(`market ${market} has no settlement_days, tick_table or parcel_floor`);
  }
  const built: MarketMoney = {
    market,
    lagSessions: p.settlementDays,
    tickTable: p.tickTable,
    buckets: slippageBucketsOf(p),
    parcelMicro: p.parcelFloorMicro,
  };
  CACHE.set(market, built);
  return built;
}
