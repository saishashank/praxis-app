// @vitest-environment node
// AGT-113 pick generator (pure): ch.16 acceptance criteria, caps, ordering, determinism.
import { describe, expect, it } from "vitest";
import {
  compareRankScore,
  generatePicks,
  labelRank,
  nthSessionAfter,
  type GenerateContext,
} from "@/lib/picks/generate";
import type { PickInput, UniverseCode } from "@/lib/picks/types";
import { slippageFill } from "@/lib/arena/slippage";
import { params } from "./harness";

const D = "2030-03-22"; // a Friday
const REF = 10_000_000n;

function mk(over: Partial<PickInput> & { code: string }): PickInput {
  return {
    signalId: `sig:${over.code}`,
    cardId: `card:${over.code}`,
    family: "F1",
    ruleVersion: "F1.v1",
    variant: "U",
    tier: "U1",
    rankScore: "5/1",
    label: "UNVALIDATED",
    referenceMicro: REF,
    stopMicro: 9_200_000n,
    advValueMicro: 5_000_000_000n,
    vol: 0.01,
    scenario: { n: 87, badPpm: -60_000, typicalPpm: 30_000, goodPpm: 110_000 },
    aimReachPpm: 400_000,
    holdMedianSessions: 15,
    medianDropPpm: 50_000,
    factors: [],
    basedOn: ["rsi_short: 6/1 (needed 10/1)", "b", "c", "d"],
    ...over,
  };
}

const universe: UniverseCode[] = [
  { code: "ZZ01", tier: "U1", vol: 0.01 },
  { code: "ZZ02", tier: "U1", vol: 0.02 },
  { code: "ZZ03", tier: "U1", vol: 0.03 },
  { code: "ZZ04", tier: "U2", vol: 0.04 },
  { code: "ZZ05", tier: "U3", vol: 0.05 },
  { code: "ZZ06", tier: "U1", vol: 0.015 },
];

function ctx(over: Partial<GenerateContext> = {}): GenerateContext {
  return {
    market: "AU",
    d: D,
    calendar: [],
    picks: params.picks,
    universe,
    createdAt: "2030-03-22T07:00:00.000Z",
    ...over,
  };
}

const many = (): PickInput[] => [
  mk({ code: "ZZ01", rankScore: "9/1", vol: 0.01 }),
  mk({ code: "ZZ02", rankScore: "8/1", vol: 0.02 }),
  mk({ code: "ZZ03", rankScore: "7/1", vol: 0.03 }),
  mk({ code: "ZZ04", tier: "U2", rankScore: "6/1", family: "F4", ruleVersion: "F4.v1" }),
  mk({ code: "ZZ05", tier: "U3", rankScore: "5/1", family: "F5", ruleVersion: "F5.v1" }),
  mk({ code: "ZZ06", rankScore: "4/1", family: "F3", ruleVersion: "F3.v1", vol: 0.015 }),
];

describe("AGT-113 acceptance (ch.16 section 16.21)", () => {
  it("gives each profile 0 to 5 picks, each with every stored field and no LLM text", () => {
    const picks = generatePicks(many(), ctx());
    const profiles = Object.keys(params.picks.profiles);
    for (const profile of profiles) {
      const mine = picks.filter((p) => p.profile === profile);
      expect(mine.length).toBeLessThanOrEqual(params.picks.picksPerProfile);
      for (const p of mine) {
        expect(p.buyMaxMicro).toBeGreaterThanOrEqual(p.referenceMicro);
        expect(p.stopMicro).toBeLessThan(p.referenceMicro);
        expect(p.aimMicro).toBeGreaterThan(p.referenceMicro);
        expect(p.badPpm).toBeLessThan(p.typicalPpm);
        expect(p.typicalPpm).toBeLessThan(p.goodPpm);
        expect(p.timeFrameSessions).toBe(15);
        expect(p.sizeMicro).toBeGreaterThan(0n);
        expect(p.riskMicro).toBeGreaterThan(0n);
        expect(p.basedOn.length).toBeGreaterThanOrEqual(1);
        expect(p.basedOn.length).toBeLessThanOrEqual(3);
        expect(p.pickSha).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(picks.filter((p) => p.profile === "aggressive").length).toBeGreaterThan(0);
  });

  it("derives the buy zone, aim and valid-until from stored numbers only", () => {
    const [p] = generatePicks([mk({ code: "ZZ01" })], ctx()).filter(
      (x) => x.profile === "balanced",
    );
    expect(p!.buyMaxMicro).toBe(slippageFill(REF, "buy", 5_000_000_000n).fillMicro);
    expect(p!.aimMicro).toBe(REF + (REF * 110_000n) / 1_000_000n);
    // D is a Friday: the second session after it is Tuesday
    expect(p!.validUntilD).toBe("2030-03-26");
    expect(p!.aimReachPpm).toBe(400_000);
    expect(p!.nSimilar).toBe(87);
  });

  it("takes at most picks_max_per_family per profile and one pick per company", () => {
    const sameFamily = ["ZZ01", "ZZ02", "ZZ03", "ZZ06"].map((code, i) =>
      mk({ code, rankScore: `${9 - i}/1` }),
    );
    const picks = generatePicks(sameFamily, ctx()).filter((p) => p.profile === "aggressive");
    expect(picks.length).toBe(params.picks.picksMaxPerFamily);
    const dup = generatePicks([mk({ code: "ZZ01" }), mk({ code: "ZZ01", family: "F4" })], ctx());
    expect(dup.filter((p) => p.profile === "aggressive")).toHaveLength(1);
  });

  it("respects picks_per_profile, including 0", () => {
    const cfg = { ...params.picks, picksPerProfile: 1, picksMaxPerFamily: 5 };
    const one = generatePicks(many(), ctx({ picks: cfg }));
    for (const profile of Object.keys(cfg.profiles)) {
      expect(one.filter((p) => p.profile === profile).length).toBeLessThanOrEqual(1);
    }
    expect(generatePicks(many(), ctx({ picks: { ...cfg, picksPerProfile: 0 } }))).toEqual([]);
  });

  it("orders by validation label first, then rank score", () => {
    const list = [
      mk({ code: "ZZ01", rankScore: "99/1", label: "FAILED" }),
      mk({ code: "ZZ02", rankScore: "1/1", label: "CONSISTENT-FORWARD", family: "F4" }),
      mk({ code: "ZZ03", rankScore: "50/1", label: "UNVALIDATED", family: "F5" }),
      mk({ code: "ZZ06", rankScore: "60/1", label: "UNVALIDATED", family: "F3" }),
    ];
    const codes = generatePicks(list, ctx())
      .filter((p) => p.profile === "aggressive")
      .map((p) => p.code);
    expect(codes).toEqual(["ZZ02", "ZZ06", "ZZ03", "ZZ01"]);
    expect(labelRank("CONSISTENT-FORWARD")).toBeLessThan(labelRank("PASSED-BACKTEST"));
    expect(labelRank("something new")).toBe(labelRank("UNVALIDATED"));
  });

  it("compares rank scores with exact fractions and unknown last", () => {
    expect(compareRankScore("1/3", "1/2")).toBeGreaterThan(0);
    expect(compareRankScore("2/1|1/2", "2/1|unknown")).toBeLessThan(0);
    expect(compareRankScore("3/1", "3/1")).toBe(0);
  });
});

describe("profile rules and caps", () => {
  it("keeps Conservative to U1 and the lowest-volatility third, Balanced to U1-U2", () => {
    const picks = generatePicks(many(), ctx());
    const tiersOf = (profile: string) =>
      new Set(picks.filter((p) => p.profile === profile).map((p) => p.tier));
    expect([...tiersOf("conservative")].every((t) => t === "U1")).toBe(true);
    expect(tiersOf("balanced").has("U3")).toBe(false);
    // U1 volatilities are 0.01, 0.015, 0.02, 0.03: the lowest third is the first two
    const con = picks.filter((p) => p.profile === "conservative").map((p) => p.code);
    expect(con.every((c) => ["ZZ01", "ZZ06"].includes(c))).toBe(true);
    expect(con.length).toBeGreaterThan(0);
  });

  it("drops families whose median drop-from-peak is above 10 % (or unknown) for Balanced", () => {
    const list = [
      mk({ code: "ZZ01", medianDropPpm: 120_000 }),
      mk({ code: "ZZ02", medianDropPpm: null, family: "F4" }),
      mk({ code: "ZZ03", medianDropPpm: 100_000, family: "F5" }),
    ];
    const balanced = generatePicks(list, ctx())
      .filter((p) => p.profile === "balanced")
      .map((p) => p.code);
    expect(balanced).toEqual(["ZZ03"]);
    const aggressive = generatePicks(list, ctx()).filter((p) => p.profile === "aggressive");
    expect(aggressive).toHaveLength(3);
  });

  it("sizes by the smaller of the position cap and the risk cap", () => {
    const picks = generatePicks([mk({ code: "ZZ01" })], ctx());
    for (const p of picks) {
      const spec = params.picks.profiles[p.profile]!;
      const amount = BigInt(params.picks.portfolioAmounts[p.profile]!) * 1_000_000n;
      const capMicro = (amount * BigInt(Math.round(spec.maxPctPerPick * 100))) / 10_000n;
      const riskMicro = (amount * BigInt(Math.round(spec.riskPctPerPick * 100))) / 10_000n;
      expect(p.sizeMicro).toBeLessThanOrEqual(capMicro);
      expect(p.riskMicro).toBeLessThanOrEqual(riskMicro + 1n);
    }
    // Balanced, stop 8 % away: the 10 % position cap (A$1,000) binds, not the 1 % risk cap
    const bal = picks.find((p) => p.profile === "balanced")!;
    expect(bal.sizeMicro).toBe(1_000_000_000n);
    // a stop 50 % away: the 1 % risk cap (A$100) binds, so the size is about A$200
    const wide = generatePicks([mk({ code: "ZZ01", stopMicro: 5_000_000n })], ctx()).find(
      (p) => p.profile === "balanced",
    )!;
    expect(wide.sizeMicro).toBeGreaterThan(190_000_000n);
    expect(wide.sizeMicro).toBeLessThan(210_000_000n);
    expect(wide.riskMicro).toBeLessThanOrEqual(100_000_000n + 1n);
  });

  it("makes no pick without history, a stop, a time frame or a positive good case", () => {
    const bad = [
      mk({ code: "ZZ01", scenario: null }),
      mk({ code: "ZZ02", stopMicro: null, family: "F4" }),
      mk({ code: "ZZ03", holdMedianSessions: null, family: "F5" }),
      mk({
        code: "ZZ06",
        scenario: { n: 50, badPpm: -50_000, typicalPpm: -10_000, goodPpm: -1_000 },
        family: "F3",
      }),
      mk({ code: "ZZ04", stopMicro: REF, tier: "U2", family: "F2" }),
    ];
    expect(generatePicks(bad, ctx())).toEqual([]);
  });
});

describe("determinism and the luck-check twin", () => {
  it("gives identical picks for the same inputs in any order", () => {
    const a = generatePicks(many(), ctx());
    const b = generatePicks([...many()].reverse(), ctx());
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(0);
  });

  it("changes the hash when any published number changes", () => {
    const a = generatePicks([mk({ code: "ZZ01" })], ctx())[0]!;
    const b = generatePicks([mk({ code: "ZZ01", stopMicro: 9_100_000n })], ctx())[0]!;
    expect(b.pickSha).not.toBe(a.pickSha);
  });

  it("draws the twin from the profile universe, never the pick itself, and repeatably", () => {
    const picks = generatePicks(many(), ctx());
    for (const p of picks) {
      expect(p.luckCode).not.toBeNull();
      expect(p.luckCode).not.toBe(p.code);
      const spec = params.picks.profiles[p.profile]!;
      const tier = universe.find((u) => u.code === p.luckCode)!.tier;
      expect(spec.tiers).toContain(tier);
    }
    expect(generatePicks(many(), ctx()).map((p) => p.luckCode)).toEqual(
      picks.map((p) => p.luckCode),
    );
  });
});

describe("nthSessionAfter", () => {
  it("skips weekends and holidays", () => {
    expect(nthSessionAfter("2030-03-22", 1, [])).toBe("2030-03-25");
    expect(
      nthSessionAfter("2030-03-22", 1, [{ d: "2030-03-25", kind: "holiday", close_time: null }]),
    ).toBe("2030-03-26");
  });
});
