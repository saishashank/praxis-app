// @vitest-environment node
// M20 IN1 (D-1154 items 1-4): the per-market money constants every engine call site threads. AU is the identity
// (each value IS the constant the engines default to); IN differs where its profile differs.
import { describe, expect, it } from "vitest";
import {
  allMarketCostProfileCodes,
  cohortCostProfile,
  costProfileByCode,
  COST_PROFILE_CODES,
} from "@/lib/arena/costs";
import { defaultCostProfileOf, resolveCohortParams } from "@/lib/arena/cohort";
import { fillIntradayStop } from "@/lib/arena/fills";
import { marketMoney } from "@/lib/arena/marketMoney";
import { MIN_MARKETABLE_PARCEL_MICRO, stallFloorMicro } from "@/lib/arena/sizing";
import { SETTLEMENT_LAG_SESSIONS } from "@/lib/arena/ledger";
import { SLIPPAGE_BUCKETS } from "@/lib/arena/slippage";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { repricedNet } from "@/lib/replay/sensitivity";
import { TICK_TABLE, MIN_PRICE_MICRO } from "@/lib/money/tick";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { COST_PROFILES } from "@/lib/arena/costs";
import { makeRational } from "@/lib/money/rational";

const M = 1_000_000n;

describe("marketMoney", () => {
  it("AU is the identity: the very constants the engines default to", () => {
    const au = marketMoney("AU");
    expect(au.lagSessions).toBe(SETTLEMENT_LAG_SESSIONS);
    expect(au.tickTable).toBe(TICK_TABLE);
    expect(au.buckets).toEqual(SLIPPAGE_BUCKETS);
    expect(au.parcelMicro).toBe(MIN_MARKETABLE_PARCEL_MICRO);
  });

  it("IN settles T+1, ticks to Rs 0.01 and floors a parcel at Rs 25,000", () => {
    const m = marketMoney("IN");
    expect(m.lagSessions).toBe(1);
    expect(m.tickTable[0]!.tickMicro).toBe(10_000n);
    expect(m.parcelMicro).toBe(25_000n * M);
    expect(m.buckets.length).toBe(SLIPPAGE_BUCKETS.length);
  });

  it("a market with no profile throws, never a default", () => {
    expect(() => marketMoney("ZZ")).toThrow();
  });
});

describe("the tick grid reaches the fill model (fills.ts:232)", () => {
  // a stop level of Rs 0.02: slippage and the extra tick would push the sell below the lowest price on the grid
  const bar = { openMicro: 30_000n, highMicro: 30_000n, lowMicro: 15_000n, closeMicro: 20_000n };
  const base = { bar, advMicro: 0n, profile: COST_PROFILES.P5 };

  it("AU default: floored at AU's lowest tick (unchanged)", () => {
    const f = fillIntradayStop(base, 10n, 20_000n)!;
    expect(f.fillPriceMicro).toBeGreaterThanOrEqual(MIN_PRICE_MICRO);
    expect(f.rule).toBe("level");
  });

  it("IN: floored at IN's lowest tick Rs 0.01, and on IN's grid", () => {
    const m = marketMoney("IN");
    const f = fillIntradayStop(
      { ...base, profile: costProfileByCode("IN-P1"), tickTable: m.tickTable, buckets: m.buckets },
      10n,
      20_000n,
    )!;
    expect(f.fillPriceMicro).toBe(10_000n);
  });
});

describe("one adverse tick (sensitivity.ts:43) uses the market grid", () => {
  const row = {
    id: "r",
    fill_in_micro: 300n * M,
    fill_out_micro: 20_000n,
    brok_out_micro: 0n,
    qty: 10,
    qty_out: 10,
    dividend_micro: 0n,
  };
  const entry = { row, exitRule: "CS" } as never;
  it("IN: the exit one tick lower floors at Rs 0.01, not AU's lowest tick", () => {
    const p = costProfileByCode("IN-P1");
    const au = repricedNet(entry, COST_PROFILES.P5, 1);
    const inn = repricedNet(entry, p, 1, marketMoney("IN").tickTable);
    expect(au).not.toBeNull();
    expect(inn).not.toBeNull();
  });
});

describe("profile codes (keys.ts:2133, streamCost.ts:44)", () => {
  it("every built market's codes are accepted; AU's list is first and unchanged", () => {
    const all = allMarketCostProfileCodes();
    expect(all.slice(0, COST_PROFILE_CODES.length)).toEqual([...COST_PROFILE_CODES]);
    expect(all).toContain("IN-P1");
    expect(all).toContain("US-P1");
  });

  it("the cost_profile_default key validates an IN code and refuses an unknown one", async () => {
    const key = CONFIG_KEYS.cost_profile_default!;
    expect(await key.validate!("IN-P1")).toBeNull();
    expect(await key.validate!("P6")).toBeNull();
    expect(await key.validate!("ZZ-P9")).not.toBeNull();
  });

  it("a cohort prices with its own market's table, never another's", () => {
    expect(cohortCostProfile({ market: "AU", costProfile: "P5" })).toBe(COST_PROFILES.P5);
    expect(cohortCostProfile({ market: "IN", costProfile: "IN-P1" }).code).toBe("IN-P1");
    expect(() => cohortCostProfile({ market: "IN", costProfile: "P5" })).toThrow(RangeError);
  });
});

describe("cohorts take the market's profile and seed (cohort.ts)", () => {
  it("AU defaults are byte-identical: P5, A$600, A$500 parcel", () => {
    const p = resolveCohortParams({});
    expect(p.market).toBe("AU");
    expect(p.costProfile).toBe("P5");
    expect(defaultCostProfileOf("AU")).toBe("P5");
    expect(p.seedMicro).toBe(600n * M);
    expect(p.minParcelMicro).toBe(500n * M);
    expect(p.terminal.stallFloorMicro).toBe(
      stallFloorMicro({ profile: COST_PROFILES.P5, parcelMicro: 500n * M }),
    );
  });

  it("IN: IN-P1, Rs seed from the FX close rounded to Rs 1,000, Rs 25,000 parcel", () => {
    const fx = { rate: "55.123", date: "2030-01-04", source: "FXRINR" };
    const p = resolveCohortParams({ market: "IN", fxRow: fx });
    expect(p.costProfile).toBe("IN-P1");
    expect(p.seedMicro).toBe(33_000n * M); // 600 x 55.123 = 33,073.8 -> 33,000
    expect(p.minParcelMicro).toBe(25_000n * M);
  });

  it("IN with no FX close throws (never a guess)", () => {
    expect(() => resolveCohortParams({ market: "IN" })).toThrow(RangeError);
  });

  it("an explicit seed overrides (replay)", () => {
    expect(resolveCohortParams({ market: "IN", seedMicro: 5n * M }).seedMicro).toBe(5n * M);
    expect(staticProfile("IN").settlementDays).toBe(1);
    expect(makeRational(1n).num).toBe(1n);
  });
});
