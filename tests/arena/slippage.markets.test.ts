// @vitest-environment node
// M20 A4 (D-1104, D-1118, D-1131, ARN-118): the slippage buckets and tier edges of IN and US come from their seeds.
// IN edges are the ADV percentiles of the NSE bhavcopy extract (task A1, buckets.json, rounded to Rs 100,000);
// US edges are AU's converted at A$1 = US$0.65 and rounded half-up to US$10,000 (D-1151, [VERIFY], D-1132).
import { describe, expect, it } from "vitest";
import {
  bucketBpsFor,
  slippageBucketsOf,
  slippageFill,
  SLIPPAGE_BUCKETS,
} from "@/lib/arena/slippage";
import { stallFloorBpsOf } from "@/lib/arena/sizing";
import { tierRulesOf } from "@/lib/data/universe/tiers.mjs";
import { AU_SLIPPAGE, AU_TIERS } from "@/lib/market/seed/au/tickTable.mjs";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { makeRational } from "@/lib/money/rational";

const M = 1_000_000n;

describe("IN buckets and tiers", () => {
  const inProfile = staticProfile("IN");

  it("slippageBucketsOf no longer throws; edges are the extract's, bps are AU's", () => {
    const b = slippageBucketsOf(inProfile);
    expect(b.map((x) => x.fromAdvMicro)).toEqual([
      791_700_000n * M,
      271_500_000n * M,
      122_000_000n * M,
      66_500_000n * M,
    ]);
    expect(b.map((x) => x.bps)).toEqual(SLIPPAGE_BUCKETS.map((x) => x.bps));
  });

  it("lower-inclusive edges: exactly Rs 791.7M is 10 bps, one micro below is 25; under the last edge is 120", () => {
    const b = slippageBucketsOf(inProfile);
    expect(bucketBpsFor(791_700_000n * M, b)).toEqual(makeRational(10n));
    expect(bucketBpsFor(791_700_000n * M - 1n, b)).toEqual(makeRational(25n));
    expect(bucketBpsFor(66_500_000n * M, b)).toEqual(makeRational(120n));
    expect(bucketBpsFor(1n, b)).toEqual(makeRational(120n));
  });

  it("tiers from the extract: 189.2M / 88.7M / 48.1M, top 514; the other figures are AU's", () => {
    const t = tierRulesOf(inProfile);
    expect(t.u1.advMicro).toBe(189_200_000n * M);
    expect(t.u2.advMicro).toBe(88_700_000n * M);
    expect(t.u3.advMicro).toBe(48_100_000n * M);
    expect(t.u1.top).toBe(514);
    expect(t.u1.minSessions).toBe(AU_TIERS.u1.minSessions);
    expect(t.windowSessions).toBe(60);
    // Rs 55 per A$: 0.50 -> 27.50, 0.20 -> 11.00, 0.10 -> 5.50, A$30M -> Rs 1,650M
    expect([t.u1.priceMicro, t.u2.priceMicro, t.u3.priceMicro]).toEqual([
      27_500_000n,
      11_000_000n,
      5_500_000n,
    ]);
    expect(t.u2.mcapMicro).toBe(1_650_000_000n * M);
  });

  it("the stall floor is AU's 10 bps (D-1118)", () => {
    expect(stallFloorBpsOf(inProfile)).toEqual(makeRational(10n));
  });
});

describe("US buckets and tiers (derived from AU at A$1 = US$0.65, [VERIFY])", () => {
  const usProfile = staticProfile("US");
  const UNIT = 10_000n * M; // round half-up to US$10,000
  const derive = (auEdge: bigint): bigint => {
    const x = (auEdge * 65n) / 100n; // exact: AU edges are multiples of 1,000 micro-units x 100
    return ((x + UNIT / 2n) / UNIT) * UNIT;
  };

  it("slippage edges are AU's x 0.65 rounded half-up to US$10,000", () => {
    const edges = slippageBucketsOf(usProfile).map((b) => b.fromAdvMicro);
    expect(edges).toEqual(AU_SLIPPAGE.buckets.map((b) => derive(b.fromAdvMicro)));
    // by hand: 3,250,000; 650,000; 162,500 -> 160,000; 65,000 -> 70,000
    expect(edges).toEqual([3_250_000n * M, 650_000n * M, 160_000n * M, 70_000n * M]);
  });

  it("tier ADV edges are AU's x 0.65 rounded the same way; price floors to the cent", () => {
    const t = tierRulesOf(usProfile);
    expect([t.u1.advMicro, t.u2.advMicro, t.u3.advMicro]).toEqual([
      derive(AU_TIERS.u1.advMicro),
      derive(AU_TIERS.u2.advMicro),
      derive(AU_TIERS.u3.advMicro),
    ]);
    expect([t.u1.advMicro, t.u2.advMicro, t.u3.advMicro]).toEqual([
      650_000n * M,
      160_000n * M,
      70_000n * M,
    ]);
    // 0.50 x 0.65 = 0.325 -> 0.33; 0.20 x 0.65 = 0.13; 0.10 x 0.65 = 0.065 -> 0.07 (half up)
    expect([t.u1.priceMicro, t.u2.priceMicro, t.u3.priceMicro]).toEqual([
      330_000n,
      130_000n,
      70_000n,
    ]);
    expect(t.u2.mcapMicro).toBe(19_500_000n * M);
  });

  it("the stall floor is AU's 10 bps (D-1118)", () => {
    expect(stallFloorBpsOf(usProfile)).toEqual(makeRational(10n));
  });
});

describe("slippageFill on the market's tick table", () => {
  it("US$0.50, ADV above the top edge (10 bps): 0.5005 on the US grid, 0.505 on the default (AU) grid", () => {
    const us = staticProfile("US");
    const buckets = slippageBucketsOf(us);
    const adv = 4_000_000n * M;
    expect(
      slippageFill(500_000n, "buy", adv, makeRational(1n), buckets, us.tickTable!).fillMicro,
    ).toBe(500_500n);
    expect(slippageFill(500_000n, "buy", adv, makeRational(1n), buckets).fillMicro).toBe(505_000n);
  });

  it("AU's default path is unchanged without a table", () => {
    const r = slippageFill(10_000_000n, "buy", 6_000_000n * M, makeRational(1n));
    // A$10.00, 10 bps: slip max(0.01, tick 0.01) = 0.01 -> 10.01
    expect(r.fillMicro).toBe(10_010_000n);
  });
});
