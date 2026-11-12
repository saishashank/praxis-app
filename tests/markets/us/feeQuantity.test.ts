// @vitest-environment node
// M20 US1 (D-1154 item 5, D-1150): every US sell and NAV fee site passes FeeContext.quantity, and US-P1 is
// selected by date. Hand-worked in micro-USD. US-P1 (version 1, from 2026-04-04): SEC 0.00206 % of the sale value,
// FINRA TAF 0.000195 per share (min 0.01, max 9.79), each rounded half-up to the cent, then summed.
import { describe, expect, it } from "vitest";
import {
  COST_PROFILES,
  costProfilesOfMarket,
  feeFor,
  quantityAt,
  type CostProfile,
} from "@/lib/arena/costs";
import {
  costProfileAsOf,
  datedCostProfileRows,
  datedCostProfiles,
  profileOnDate,
} from "@/lib/arena/costAsOf";
import { fillIntradayStop } from "@/lib/arena/fills";
import { liquidationValueMicro } from "@/lib/arena/nav";
import {
  breakEvenMove,
  defaultSleeveConfig,
  sleeveLiquidationCostMicro,
  type SleeveTrade,
} from "@/lib/arena/sleeve";
import { roundTripCost } from "@/lib/agents/costGate";
import { costPerOrder } from "@/lib/cortex/economics/cost";
import { resizeEntryAtFill } from "@/lib/arena/sizing";
import { roundTripBrokerage } from "@/lib/replay/returns";

const P = costProfilesOfMarket("US")["US-P1"]!;
const USD = (n: bigint) => n * 1_000_000n;

describe("quantityAt", () => {
  it("floors notional / price and never returns 0", () => {
    expect(quantityAt(USD(600n), USD(50n))).toBe(12n);
    expect(quantityAt(USD(600n), USD(53n))).toBe(11n);
    expect(quantityAt(USD(10n), USD(50n))).toBe(1n);
    expect(() => quantityAt(USD(10n), 0n)).toThrow("price");
  });
});

describe("US sell and NAV fee sites carry the quantity", () => {
  it("fillIntradayStop: a stop-out sell of 100 shares prices the TAF on 100 shares", () => {
    const env = {
      bar: { openMicro: USD(50n), highMicro: USD(51n), lowMicro: USD(47n), closeMicro: USD(48n) },
      advMicro: USD(50_000_000n),
      profile: P,
    };
    const fill = fillIntradayStop(env, 100n, USD(49n));
    expect(fill).not.toBeNull();
    expect(fill!.brokerageMicro).toBe(feeFor(P, fill!.valueMicro, "sell", { quantity: 100n }));
    expect(fill!.brokerageMicro).toBeGreaterThan(0n);
  });

  it("liquidationValueMicro (NAV) sells 200 shares without a missing-quantity error", () => {
    const mark = { closeMicro: USD(50n), advMicro: USD(50_000_000n) };
    const v = liquidationValueMicro(200n, mark, { profile: P });
    const gross = 200n * USD(50n);
    expect(v).toBeLessThan(gross);
    expect(v).toBeGreaterThan(gross - USD(50n));
  });

  const trade: SleeveTrade = {
    id: "t1",
    cohortId: "c1",
    code: "AAA",
    shadow: false,
    marginMicro: USD(2_500n),
    leverage: 2n,
    notionalMicro: USD(5_000n),
    openD: "2026-11-02",
    entryPriceMicro: USD(50n),
    entryFillId: null,
    closed: null,
  };
  it("the sleeve liquidation cost and break-even derive the quantity from notional / entry price", () => {
    const cfg = defaultSleeveConfig(P);
    // 5,000 / 50 = 100 shares: SEC 0.10 + TAF 0.02 = 0.12 on the sell, a buy costs nothing
    expect(sleeveLiquidationCostMicro(trade, cfg)).toBe(120_000n);
    const be = breakEvenMove(trade, cfg);
    // 0.12 / 5,000 = 24 ppm
    expect(be.num * 1_000_000n).toBe(24n * be.den);
  });

  it("the cost gate and the Cortex economics take the price to derive the quantity", () => {
    // 600 / 50 = 12 shares on the A$600-equivalent order: sell SEC 0.012 -> 0.01, TAF 12 x 0.000195 -> min 0.01
    const c = roundTripCost(P, USD(50_000_000n), USD(50n));
    expect(c.num).toBeGreaterThan(0n);
    const o = costPerOrder({
      profile: P,
      notionalMicro: USD(5_000n),
      priceMicro: USD(50n),
      tier: "U1" as never,
      advMicro: USD(50_000_000n),
    });
    // fees = (0 on the buy + 0.12 on the sell) / 5,000 = 24 ppm
    expect(o.parts.fees.num * 1_000_000n).toBe(24n * o.parts.fees.den);
  });

  it("a US sell with no price to derive the quantity from is refused, never guessed", () => {
    expect(() => roundTripCost(P, USD(50_000_000n))).toThrow("quantity is required");
    expect(roundTripBrokerage({ profile: P } as never, USD(5_000n), USD(50n))).toBe(120_000n);
  });

  it("resizeEntryAtFill (a buy) behaves for US and AU alike", () => {
    const base = { plannedQty: 10n, fillPriceMicro: USD(50n), availableCashMicro: USD(1_000n) };
    expect(resizeEntryAtFill({ ...base, profile: P }).status).toBe("keep");
    expect(resizeEntryAtFill({ ...base, profile: COST_PROFILES.P5 }).status).toBe("keep");
  });
});

describe("US-P1 by date (D-1150, D-1181)", () => {
  const sell = (p: CostProfile, value: bigint, qty: bigint) =>
    feeFor(p, value, "sell", { quantity: qty });

  it("lists four dated versions, ascending, version 1 being the A4 profile", () => {
    const v = datedCostProfiles("US", "US-P1");
    expect(v.map((x) => x.effectiveFrom)).toEqual([
      "2024-05-22",
      "2025-05-14",
      "2026-01-01",
      "2026-04-04",
    ]);
    expect(v.map((x) => x.version)).toEqual([4, 3, 2, 1]);
    expect(v[3]!.profile.rule).toEqual(P.rule);
  });

  it("picks the version in force: sell 100 at US$50 over the four regimes", () => {
    const value = USD(5_000n);
    // 2026-11-10: SEC 0.103 -> 0.10 + TAF 0.0195 -> 0.02 = 0.12
    expect(sell(costProfileAsOf("US", P, "2026-11-10"), value, 100n)).toBe(120_000n);
    // 2026-02-02: SEC none + TAF 0.0195 -> 0.02
    expect(sell(costProfileAsOf("US", P, "2026-02-02"), value, 100n)).toBe(20_000n);
    // 2025-08-01: SEC none + TAF 100 x 0.000166 = 0.0166 -> 0.02
    expect(sell(costProfileAsOf("US", P, "2025-08-01"), value, 100n)).toBe(20_000n);
    // 2025-01-15: SEC 5,000 x 0.0000278 = 0.139 -> 0.14, TAF 0.02 = 0.16
    expect(sell(costProfileAsOf("US", P, "2025-01-15"), value, 100n)).toBe(160_000n);
  });

  it("a change date belongs to the new version and the day before to the old", () => {
    const value = USD(100_000n);
    const q = 100_000n;
    // 2026-04-03: no SEC fee, TAF 19.50 -> cap 9.79
    expect(sell(costProfileAsOf("US", P, "2026-04-03"), value, q)).toBe(9_790_000n);
    // 2026-04-04: SEC 2.06 + 9.79
    expect(sell(costProfileAsOf("US", P, "2026-04-04"), value, q)).toBe(11_850_000n);
    // 2025-05-13: SEC 2.78; TAF 16.60 -> cap 8.30 = 11.08
    expect(sell(costProfileAsOf("US", P, "2025-05-13"), value, q)).toBe(11_080_000n);
    // 2025-05-14: no SEC fee, TAF cap 8.30
    expect(sell(costProfileAsOf("US", P, "2025-05-14"), value, q)).toBe(8_300_000n);
  });

  it("refuses a session before the first version and a malformed date", () => {
    expect(() => costProfileAsOf("US", P, "2024-05-21")).toThrow("no US-P1 version");
    expect(() => costProfileAsOf("US", P, "2026-4-1")).toThrow("YYYY-MM-DD");
  });

  it("the home market and a profile with no dated schedule keep the very same object", () => {
    expect(costProfileAsOf("AU", COST_PROFILES.P5, "2019-01-01")).toBe(COST_PROFILES.P5);
    expect(profileOnDate(COST_PROFILES.P5, "2026-11-10")).toBe(COST_PROFILES.P5);
    expect(profileOnDate(P, "2026-11-10").version).toBe(1);
    expect(profileOnDate(P, "2025-01-15").version).toBe(4);
  });

  it("produces one append-only cost_profile row per version, effective_from as the instant", () => {
    const rows = datedCostProfileRows("US", "US-P1");
    expect(rows.map((r) => r.effective_from)).toEqual([
      "2024-05-22T00:00:00.000Z",
      "2025-05-14T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-04-04T00:00:00.000Z",
    ]);
    expect(rows.every((r) => r.verified === 0)).toBe(true);
  });
});
