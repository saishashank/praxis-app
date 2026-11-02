// @vitest-environment node
// Scorecard (KB-074, D-532) and AT-41 (a): two ZZ experts, high reach with failed claims vs low reach with
// passing claims, sort by evidence; 2 scored claims read "insufficient".
import { describe, expect, it } from "vitest";
import { compareEvidence, evidenceSortKey, scorecard } from "@/lib/experts/scorecard";
import type { CallOutcomeView, ClaimView, ScreeningResultView } from "@/lib/experts/types";

const claim = (id: string, clusterId: string | null, over: Partial<ClaimView> = {}): ClaimView => ({
  id,
  type: "method",
  testability: "testable_eod",
  clusterId,
  status: "screened",
  statement: "ZZ statement",
  formalisationText: null,
  vocabularyGapText: null,
  claimedEdgeText: null,
  ...over,
});
const many = (n: number, prefix: string, cluster: string): ClaimView[] =>
  Array.from({ length: n }, (_, i) => claim(`${prefix}-${i}`, cluster));
const res = (clusterId: string, survived: boolean): ScreeningResultView => ({
  clusterId,
  survived,
});

describe("scorecard", () => {
  it("is insufficient below minScored", () => {
    const c = scorecard({
      claims: [claim("a", "K-1"), claim("b", "K-1")],
      results: [res("K-1", true)],
      calls: [],
      minScored: 10,
    });
    expect(c.scored).toBe(2);
    expect(c.state).toBe("insufficient");
    expect(c.passShare).toMatchObject({ k: 2, n: 2 });
  });

  it("scores testable method/risk_rule/event_link claims whose cluster has a result", () => {
    const c = scorecard({
      claims: [
        claim("m1", "K-1"),
        claim("r1", "K-1", { type: "risk_rule" }),
        claim("e1", "K-2", { type: "event_link" }),
        claim("call1", "K-1", { type: "call" }),
        claim("nt", "K-1", { testability: "not_testable" }),
        claim("none", "K-9"),
        claim("nocluster", null),
      ],
      results: [res("K-1", true), res("K-2", false)],
      calls: [],
      minScored: 3,
    });
    expect(c.scored).toBe(3);
    expect(c.passShare).toMatchObject({ k: 2, n: 3 });
    expect(c.state).toBe("scored");
    expect(c.byStatus.screened).toBe(7);
    expect(c.byStatus.promoted).toBe(0);
  });

  it("uses a Wilson 90 % interval for the pass share", () => {
    const c = scorecard({
      claims: many(20, "p", "K-1"),
      results: [res("K-1", true)],
      calls: [],
      minScored: 5,
    });
    expect(c.passShare!.interval.upper).toBe(1);
    expect(c.passShare!.interval.lower).toBeGreaterThan(0.8);
    expect(c.passShare!.interval.lower).toBeLessThan(1);
  });

  it("counts settled calls toward scored and summarises vs market with the luck median", () => {
    const calls: CallOutcomeView[] = [
      { claimId: "c1", state: "closed_target", vsMarketPpm: 50_000, luckPct: 10 },
      { claimId: "c2", state: "closed_stop", vsMarketPpm: -20_000, luckPct: 60 },
      { claimId: "c3", state: "closed_horizon", vsMarketPpm: 10_000, luckPct: 30 },
      { claimId: "c4", state: "no_bars", vsMarketPpm: null, luckPct: null },
    ];
    const c = scorecard({ claims: [], results: [], calls, minScored: 3 });
    expect(c.scored).toBe(3);
    expect(c.state).toBe("scored");
    expect(c.calls).toMatchObject({ n: 3, medianPpm: 10_000, beatingPct: 67, luckMedianPct: 30 });
    expect(c.passShare).toBeNull();
  });

  it("is deterministic", () => {
    const x = {
      claims: many(12, "d", "K-1"),
      results: [res("K-1", false)],
      calls: [],
      minScored: 10,
    };
    expect(scorecard(x)).toEqual(scorecard(x));
  });
});

describe("AT-41 (a) directory order is by evidence, not reach", () => {
  // The audience is not an input of scorecard() at all, so reach cannot move a card.
  const reach = { "ZZ Loud": 900_000, "ZZ Quiet": 120 };
  const loud = scorecard({
    claims: many(12, "l", "K-F"),
    results: [res("K-F", false)],
    calls: [],
    minScored: 10,
  });
  const quiet = scorecard({
    claims: many(12, "q", "K-P"),
    results: [res("K-P", true)],
    calls: [],
    minScored: 10,
  });
  const few = scorecard({
    claims: many(2, "f", "K-P"),
    results: [res("K-P", true)],
    calls: [],
    minScored: 10,
  });

  it("puts the passing low-reach expert first and an insufficient card last", () => {
    const cards = [
      { name: "ZZ Loud", card: loud },
      { name: "ZZ Few", card: few },
      { name: "ZZ Quiet", card: quiet },
    ];
    cards.sort((a, b) => compareEvidence(a.card, b.card) || (a.name < b.name ? -1 : 1));
    expect(cards.map((c) => c.name)).toEqual(["ZZ Quiet", "ZZ Loud", "ZZ Few"]);
    expect(reach["ZZ Loud"]).toBeGreaterThan(reach["ZZ Quiet"]);
    expect(few.state).toBe("insufficient");
  });

  it("sort key is state, lower bound, calls median, n", () => {
    const k = evidenceSortKey(quiet);
    expect(k).toHaveLength(4);
    expect(k[0]).toBe(1);
    expect(k[3]).toBe(12);
    expect(evidenceSortKey(few)[0]).toBe(0);
  });
});
