// @vitest-environment node
// D-1858: why a candidate did not become a pick, counted per profile in fixed reason codes (the dated
// rerun of 20 Nov 2026 had 51 strategy candidates, added 0 and did not say why). The count is read only:
// generatePicks returns the same picks with or without it. Synthetic ZZ data (SEC-110).
import { describe, expect, it } from "vitest";
import {
  formatSkips,
  generatePicks,
  SKIP_REASONS,
  type GenerateContext,
  type SkipTally,
} from "@/lib/picks/generate";
import type { PickInput } from "@/lib/picks/types";
import { params } from "./harness";

const mk = (code: string, tier: PickInput["tier"], over: Partial<PickInput> = {}): PickInput => ({
  code,
  signalId: `sig:${code}`,
  cardId: `card:${code}`,
  family: "F1",
  ruleVersion: "F1.v1",
  variant: "U",
  tier,
  rankScore: "5/1",
  label: "PASSED-BACKTEST",
  referenceMicro: 10_000_000n,
  stopMicro: 9_200_000n,
  advValueMicro: 5_000_000_000n,
  vol: 0.05,
  scenario: { n: 87, badPpm: -60_000, typicalPpm: 30_000, goodPpm: 110_000 },
  aimReachPpm: 400_000,
  holdMedianSessions: 15,
  medianDropPpm: 50_000,
  factors: [],
  basedOn: ["a", "b", "c", "d"],
  ...over,
});

const ctx = (
  inputs: readonly PickInput[],
  over: Partial<GenerateContext> = {},
  pickParams = params.picks,
): GenerateContext => ({
  market: "AU",
  d: "2030-03-22",
  calendar: [],
  picks: pickParams,
  universe: [
    ...inputs.map((i) => ({ code: i.code, tier: i.tier, vol: 0.05 })),
    { code: "ZZ01", tier: "U1" as const, vol: 0.01 },
    { code: "ZZ02", tier: "U2" as const, vol: 0.02 },
    { code: "ZZ03", tier: "U3" as const, vol: 0.09 },
  ],
  createdAt: "2030-03-22T07:00:00.000Z",
  ...over,
});

const run = (
  inputs: readonly PickInput[],
  over: Partial<GenerateContext> = {},
  p = params.picks,
) => {
  const skips: SkipTally = {};
  const picks = generatePicks(inputs, ctx(inputs, over, p), undefined, skips);
  return { picks, skips };
};

describe("generatePicks skip counts (D-1858)", () => {
  const inputs = [
    mk("YY01", "U3"),
    mk("YY02", "U3"),
    mk("YY03", "U2"),
    mk("YY04", "U1"),
    mk("YY05", "U3", { scenario: null }),
    mk("YY06", "U3", { stopMicro: null }),
    mk("YY07", "U3", { holdMedianSessions: 0 }),
    mk("YY08", "U3", { scenario: { n: 87, badPpm: -60_000, typicalPpm: 0, goodPpm: 0 } }),
  ];

  it("counts tier, band and the basics per profile, one reason per candidate", () => {
    const { skips } = run(inputs);
    // aggressive takes every tier but only its own band; the four basics each stop one U3 stock
    expect(skips.aggressive).toEqual({ band: 2, no_history: 1, no_stop: 1, no_hold: 1, no_aim: 1 });
    // balanced: U3 stocks are not in its tiers; the U1 stock is in the conservative band
    expect(skips.balanced).toEqual({ tier: 6, band: 1 });
    expect(skips.conservative).toEqual({ tier: 7 });
    for (const t of Object.values(skips)) {
      for (const k of Object.keys(t)) expect(SKIP_REASONS).toContain(k);
    }
  });

  it("counts held, family cap, size and rank limit in the order the picks are made", () => {
    const aggr = (list: PickInput[], over: Partial<GenerateContext> = {}, p = params.picks) =>
      run(list, over, p).skips.aggressive!;
    const u3 = ["YY01", "YY02", "YY03", "YY04", "YY05"].map((c, i) =>
      mk(c, "U3", { rankScore: `${9 - i}/1` }),
    );
    // held: a company already published for the profile is not picked again
    const existing = new Map([["aggressive", [{ rank: 1, code: "YY01", family: "SL" }]]]);
    expect(aggr(u3, { existing }, { ...params.picks, picksMaxPerFamily: 99 })).toEqual({ held: 1 });
    // family cap: one pick per family, the others are counted
    expect(aggr(u3, {}, { ...params.picks, picksMaxPerFamily: 1 })).toEqual({ family_cap: 4 });
    // rank limit: two places, three candidates left over
    expect(aggr(u3, {}, { ...params.picks, picksPerProfile: 2, picksMaxPerFamily: 99 })).toEqual({
      rank_full: 3,
    });
    // size: a profile whose portfolio amount is nothing sizes no pick
    const zero = {
      ...params.picks,
      portfolioAmounts: { ...params.picks.portfolioAmounts, aggressive: 0 },
    };
    expect(aggr(u3, {}, zero)).toEqual({ size: 5 });
  });

  it("does not change the picks: the same output with and without the count", () => {
    for (const set of [inputs, inputs.slice(0, 2), []]) {
      const plain = generatePicks(set, ctx(set));
      const counted = run(set).picks;
      expect(counted).toEqual(plain);
      expect(JSON.stringify(counted, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(
        JSON.stringify(plain, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
    }
  });

  it("every candidate is counted once per profile: picked, or exactly one reason", () => {
    const { picks, skips } = run(inputs);
    for (const profile of ["aggressive", "balanced", "conservative"]) {
      const skipped = Object.values(skips[profile] ?? {}).reduce((n, v) => n + (v ?? 0), 0);
      expect(skipped + picks.filter((p) => p.profile === profile).length, profile).toBe(
        inputs.length,
      );
    }
  });
});

describe("formatSkips (D-1858)", () => {
  it("prints profiles in name order and reasons in a fixed order, codes and counts only", () => {
    expect(
      formatSkips({
        balanced: { no_history: 12, band: 30, rank_full: 1 },
        aggressive: { size: 2 },
        conservative: {},
      }),
    ).toBe("aggressive:size=2;balanced:band=30+no_history=12+rank_full=1");
  });
  it("says none when nothing was skipped", () => {
    expect(formatSkips({})).toBe("none");
    expect(formatSkips({ balanced: {} })).toBe("none");
  });
});
