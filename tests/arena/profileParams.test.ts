// @vitest-environment node
// M19 B2 (CXA-002 b, c, d, h; D-1003, D-1030, D-1031): the Arena, money, picks, intraday and data constants that were
// AU literals are the profile's values to the byte, and every engine takes a market's own table as an argument.
import { describe, expect, it } from "vitest";
import {
  COST_PROFILES,
  costProfileOfMarket,
  costProfilesOfMarket,
  feeFor,
} from "@/lib/arena/costs";
import { ARENA_MARKET, SEED_MICRO } from "@/lib/arena/cohort";
import {
  SETTLEMENT_LAG_SESSIONS,
  settlementDate,
  settlementItem,
  type LedgerFill,
} from "@/lib/arena/ledger";
import type { CalendarRow } from "@/lib/data/calendar";
import { PREOPEN_AT } from "@/lib/arena/preopen";
import { MIN_MARKETABLE_PARCEL_MICRO } from "@/lib/arena/sizing";
import {
  DEFAULT_STALL_FLOOR_BPS,
  DEFAULT_TICK_CROSS_FACTOR,
  DEFAULT_UNTRADEABLE_ADV_FRACTION,
  SLIPPAGE_BUCKETS,
  slippageBucketsOf,
} from "@/lib/arena/slippage";
import { MARKET_INDEX_CODE, chartSymbol, parseChartMeta } from "@/lib/data/quotes/parse";
import { QUOTE_TZ } from "@/lib/data/quotes/latest";
import {
  INDEX_CODE,
  INDEX_CODES,
  INDEX_MARKET,
  INDEX_YAHOO_SYMBOL,
} from "@/lib/data/index/indexBars.mjs";
import { TIER_RULES } from "@/lib/data/universe/tiers.mjs";
import { BENCH_INDEX_CODE } from "@/lib/intraday/measure";
import { SCAN_MARKET, SESSION_TZ } from "@/lib/intraday/run";
import { makeRational } from "@/lib/money/rational";
import { slippedFill, stallSlippageMicro, TICK_TABLE, tickFor } from "@/lib/money/tick";
import { BENCH_INDEX } from "@/lib/picks/vsMarket";
import { homeProfile, staticProfile } from "@/lib/market/staticProfile.mjs";

describe("AU constants equal today's values (the snapshot numbers, written out)", () => {
  it("market, parcel, settlement, pre-open, seed", () => {
    expect(ARENA_MARKET).toBe("AU");
    expect(SCAN_MARKET).toBe("AU");
    expect(INDEX_MARKET).toBe("AU");
    expect(MIN_MARKETABLE_PARCEL_MICRO).toBe(500_000_000n);
    expect(SETTLEMENT_LAG_SESSIONS).toBe(2);
    expect(PREOPEN_AT).toBe("09:55");
    expect(SEED_MICRO).toBe(600_000_000n);
    expect(QUOTE_TZ).toBe("Australia/Sydney");
    expect(SESSION_TZ).toBe("Australia/Melbourne");
  });
  it("tick table, slippage, tiers", () => {
    expect(TICK_TABLE).toEqual([
      { fromMicro: 0n, tickMicro: 1_000n },
      { fromMicro: 100_000n, tickMicro: 5_000n },
      { fromMicro: 2_000_000n, tickMicro: 10_000n },
    ]);
    expect(SLIPPAGE_BUCKETS.map((b) => [b.fromAdvMicro, b.bps])).toEqual([
      [5_000_000_000_000n, makeRational(10n)],
      [1_000_000_000_000n, makeRational(25n)],
      [250_000_000_000n, makeRational(60n)],
      [100_000_000_000n, makeRational(120n)],
    ]);
    expect(DEFAULT_TICK_CROSS_FACTOR).toEqual(makeRational(1n));
    expect(DEFAULT_STALL_FLOOR_BPS).toEqual(makeRational(10n));
    expect(DEFAULT_UNTRADEABLE_ADV_FRACTION).toEqual(makeRational(1n, 200n));
    expect(TIER_RULES).toBe(homeProfile().tiers);
    expect(TIER_RULES.u1.advMicro).toBe(1_000_000_000_000n);
  });
  it("cost profiles: every P-profile and its figures are today's", () => {
    expect(Object.keys(COST_PROFILES)).toEqual(["P0", "P1", "P2", "P3", "P4", "P5", "P5b", "P6"]);
    // P5 at 25,000.01 is 30_000_012 micro exactly (costs.ts header): above the top tier, 0.12 %
    expect(feeFor(COST_PROFILES.P5, 25_000_010_000n, "buy")).toBe(30_000_012n);
    expect(feeFor(COST_PROFILES.P5, 1_000_000_000n, "buy")).toBe(5_000_000n);
    expect(feeFor(COST_PROFILES.P6, 100_000_000n, "buy")).toBe(1_000_000n);
    expect(COST_PROFILES.P6.verified).toBe(true);
    expect(COST_PROFILES.P5.verified).toBe(false);
    expect(COST_PROFILES.P5.name).toBe("Default tiers (A$5 to A$29.95, then 0.12%)");
  });
  it("index codes, quote symbols and the benchmark everywhere", () => {
    expect(INDEX_CODE).toBe("AXJO");
    expect(INDEX_YAHOO_SYMBOL).toBe("^AXJO");
    expect(INDEX_CODES).toEqual(["AXJO", "GSPC", "VIX"]);
    expect(MARKET_INDEX_CODE).toBe("AXJO");
    expect(BENCH_INDEX).toBe("AXJO");
    expect(BENCH_INDEX_CODE).toBe("AXJO");
    expect(chartSymbol("AXJO")).toBe("^AXJO");
    expect(chartSymbol("BHP")).toBe("BHP.AX");
  });
});

describe("the engines take a market's own table", () => {
  const coarse = [{ fromMicro: 0n, tickMicro: 50_000n }] as const;
  it("tickFor and the slippage rounding use the table passed", () => {
    expect(tickFor(150_000n)).toBe(5_000n);
    expect(tickFor(150_000n, coarse)).toBe(50_000n);
    // a 10 bps bucket on a price of 1.00 is 1_000 micro; the tick term (one tick of the table) dominates
    const fill = slippedFill(1_000_000n, "buy", makeRational(10n), makeRational(1n), coarse);
    expect(fill).toBe(1_050_000n);
    expect(slippedFill(1_000_000n, "buy", makeRational(10n), makeRational(1n))).toBe(1_005_000n);
    // the stall floor: max(10 bps, one tick), up to the grid
    expect(stallSlippageMicro(1_000_000n, coarse)).toBe(50_000n);
  });
  it("settlementDate takes the lag in sessions (default: the profile's T+2)", () => {
    const cal: CalendarRow[] = [{ d: "2026-03-09", kind: "holiday", close_time: null }]; // Monday a holiday
    expect(settlementDate("2026-03-05", cal)).toBe("2026-03-10");
    expect(settlementDate("2026-03-05", cal, 1)).toBe("2026-03-06");
    expect(settlementDate("2026-03-06", cal, 1)).toBe("2026-03-10");
    const fill: LedgerFill = {
      id: "f1",
      d: "2026-03-05",
      code: "ZZA",
      side: "sell",
      qty: 1n,
      valueMicro: 1_000_000n,
      brokerageMicro: 0n,
    };
    expect(settlementItem(fill, cal, 1).settleD).toBe("2026-03-06");
  });
  it("the cost profile and slippage buckets of a market come from its seed; IN and US resolve (M20 A4)", () => {
    const au = staticProfile("AU");
    expect(costProfileOfMarket(au)).toEqual(COST_PROFILES.P5);
    expect(Object.keys(costProfilesOfMarket("AU"))).toHaveLength(8);
    expect(slippageBucketsOf(au)).toEqual(SLIPPAGE_BUCKETS);
    for (const [code, formula] of [
      ["IN", "IN-P1"],
      ["US", "US-P1"],
    ] as const) {
      const p = staticProfile(code);
      expect(costProfileOfMarket(p).code).toBe(formula);
      expect(Object.keys(costProfilesOfMarket(code))).toEqual([formula]);
      expect(slippageBucketsOf(p)).toHaveLength(4);
      expect(p.settlementDays).toBe(1);
    }
    // a market with no seed table still throws, never a guess
    expect(() => costProfilesOfMarket("ZZ")).toThrow("not built (M20)");
  });
  it("chartSymbol and parseChartMeta follow the market's suffix, benchmark and currency", () => {
    const inProfile = staticProfile("IN");
    expect(chartSymbol("TCS", inProfile)).toBe("TCS.NS");
    expect(chartSymbol("NSEI", inProfile)).toBe("^NSEI");
    const meta = (currency: string, symbol: string) => ({
      chart: {
        result: [
          {
            meta: {
              currency,
              symbol,
              regularMarketPrice: 100.5,
              regularMarketTime: 1_700_000_000,
              regularMarketVolume: 10,
              chartPreviousClose: 99,
            },
          },
        ],
      },
    });
    const now = new Date("2023-11-14T22:30:00.000Z");
    expect(parseChartMeta(meta("INR", "TCS.NS"), "TCS", now, inProfile)).not.toHaveProperty(
      "reject",
    );
    expect(parseChartMeta(meta("AUD", "TCS.NS"), "TCS", now, inProfile)).toEqual({
      reject: "bad_currency",
    });
    // default: the home market's currency and suffix
    expect(parseChartMeta(meta("AUD", "BHP.AX"), "BHP", now)).not.toHaveProperty("reject");
  });
});
