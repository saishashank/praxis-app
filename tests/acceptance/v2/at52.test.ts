// @vitest-environment node
// AT-52 (M15 P6; CTX-021, CTX-022, CTX-022a, CTX-022b, CTX-024, CTX-028): the economics fixtures,
// asserted through the public functions the night path uses. The unit modules own the long tables;
// this is the acceptance read-through. Synthetic ZZ data only (SEC-110).
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import { type Bar, type FillEnv, fillEntryLimit, limitPriceMicro } from "@/lib/arena/fills";
import { breakEvenCard } from "@/lib/cortex/economics/breakEven";
import { costFraction, costPerOrder } from "@/lib/cortex/economics/cost";
import { DEFAULT_ENTRY_GAP_CAP } from "@/lib/cortex/economics/gapCap";
import { rankCandidates, type RankCandidate } from "@/lib/cortex/economics/rank";
import { gateEconomic } from "@/lib/cortex/gates";
import { ratchetStop, rebaseStop } from "@/lib/cortex/states/corpAction";
import { makeRational } from "@/lib/money/rational";
import { breakEvenP } from "@/lib/stats/breakEven";
import { cellStat, mapFor } from "../../cortex/night/zzNight";

const A$ = (d: number) => BigInt(d) * 1_000_000n;

describe("AT-52 p_be card line", () => {
  it("gain 10 %, loss 6 %, cost 2.5 % gives a break-even probability of 53.1 %", () => {
    expect(breakEvenP(0.1, 0.06, 0.025)).toBeCloseTo(0.53125, 12);
    const card = breakEvenCard(0.1, 0.06);
    const at25 = card.line.find((r) => r.c === 0.025)!;
    expect((at25.pBe * 100).toFixed(1)).toBe("53.1");
    expect(card.line.map((r) => r.c)).toEqual([0.025, 0.05, 0.075]);
    expect(card.line[1]!.pBe).toBeGreaterThan(at25.pBe);
  });

  it("the card also shows p_be at the order's own cost", () => {
    const own = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(500),
      priceMicro: 200_000n,
      tier: "U2",
      advMicro: A$(300_000),
    });
    const card = breakEvenCard(0.1, 0.06, own);
    expect(card.atOrderCost!.c).toBeCloseTo(0.07, 12);
    expect(card.atOrderCost!.pBe).toBeCloseTo((0.06 + 0.07) / 0.16, 12);
  });
});

describe("AT-52 the 40/60 cell fails G04_economic", () => {
  it("40 setups where 60 are needed: 'not enough history', with the gate id and the value", () => {
    const map = { ok: true as const, map: mapFor("F1") };
    const forty = cellStat("F1|top3|v1|U1", { n: 40 });
    const r = gateEconomic({ map, cell: forty, regime: "NEUTRAL", inBand: true });
    expect(r).toMatchObject({ pass: false, gateId: "G04_economic" });
    expect(r).toMatchObject({ value: "not_enough_history: 40 setups < 60" });
    const sixty = cellStat("F1|top3|v1|U1", { n: 60 });
    expect(gateEconomic({ map, cell: sixty, regime: "NEUTRAL", inBand: true }).pass).toBe(true);
  });
});

describe("AT-52 ranking: equal p, ATR 4 % against 6 %", () => {
  const cand = (over: Partial<RankCandidate> & { code: string }): RankCandidate => ({
    volBucket: "mid",
    meanNet: 0.03,
    nEff: 120,
    lReal: 0.05,
    disagreement: 0,
    advMicro: 1_000_000_000_000n,
    ...over,
  });
  it("the lower-ATR name ranks first", () => {
    const ranked = rankCandidates(
      [cand({ code: "ZZ06", lReal: 0.06, volBucket: "high" }), cand({ code: "ZZ04", lReal: 0.04 })],
      0.03,
    );
    expect(ranked.map((r) => r.candidate.code)).toEqual(["ZZ04", "ZZ06"]);
  });
});

describe("AT-52 cost per order (D-311)", () => {
  it("a A$0.20 U2 stock on a A$500 parcel costs 70,000 ppm (7.0 %)", () => {
    const c = costPerOrder({
      profile: COST_PROFILES.P5,
      notionalMicro: A$(500),
      priceMicro: 200_000n,
      tier: "U2",
      advMicro: A$(300_000),
    });
    expect(c.ppm).toBe(70_000);
    expect(costFraction(c)).toBeCloseTo(0.07, 12);
  });
});

describe("AT-52 +9 % open against an 8 % cap", () => {
  const env: FillEnv = {
    bar: {
      openMicro: 10_900_000n,
      highMicro: 11_000_000n,
      lowMicro: 10_850_000n,
      closeMicro: 10_900_000n,
    },
    advMicro: 5_000_000_000_000n,
    profile: COST_PROFILES.P5,
  };
  it("stays unfilled when the session low is above the limit, the same in the live and the shadow arm", () => {
    const limit = limitPriceMicro(
      10_000_000n,
      9_000_000n,
      DEFAULT_ENTRY_GAP_CAP,
      makeRational(20n, 100n),
    );
    expect(limit).toBe(10_800_000n);
    const live = fillEntryLimit(env, 60n, limit);
    const shadow = fillEntryLimit(env, 60n, limit);
    expect(live).toEqual({ status: "unfilled", reason: "limit_not_reached" });
    expect(shadow).toEqual(live);
  });

  it("fills at the limit when the low trades through it", () => {
    const limit = 10_800_000n;
    const bar: Bar = { ...env.bar, lowMicro: 10_700_000n };
    const out = fillEntryLimit({ ...env, bar }, 60n, limit);
    expect(out.status).toBe("filled");
  });
});

describe("AT-52 ratchet invariant", () => {
  const c = (dollars: number) => BigInt(dollars) * 1_000_000n;
  it("a stop never goes down, except by a confirmed 2-for-1 re-base", () => {
    expect(ratchetStop(c(900), c(850))).toBe(c(900));
    expect(ratchetStop(c(900), c(950))).toBe(c(950));
    expect(rebaseStop(c(900), makeRational(2n))).toBe(c(450));
    expect(ratchetStop(c(900), c(440), makeRational(2n))).toBe(c(450));
    expect(ratchetStop(c(900), c(470), makeRational(2n))).toBe(c(470));
  });
});
