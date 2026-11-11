// @vitest-environment node
// Pure helpers of the learner's map rows and of the nightly duel (design C.2, C.5, B.4; D-923, D-927,
// D-928): generation rows, the checkpoint row (cap / rollback / lift, never raising a weight), the start
// session, the top-pick pairing, forward returns, matured net pairing, the duel status and the leader.
import { describe, expect, it } from "vitest";
import type { CheckpointDecision } from "@/lib/cortex/learn/checkpoint";
import { learnConfig, LEARN_CONFIG } from "@/lib/cortex/learn/config";
import {
  duelPicks,
  duelStatus,
  evaluateLeader,
  forwardReturns,
  netDeltas,
} from "@/lib/cortex/learn/duel";
import {
  baseWeightsOf,
  capsOf,
  configHash,
  embargoFittedAt,
  equalWeights,
  generationBefore,
  generationOf,
  generationZero,
  learnerStartD,
  learnerWeightsOf,
  nextGeneration,
  nightlyRow,
} from "@/lib/cortex/learn/learner";
import {
  capLiftWords,
  cleanWords,
  duelWaitingWords,
  startWords,
} from "@/lib/cortex/learn/learnWords";
import type { CompareRow } from "@/lib/cortex/learn/types";
import { devIcOf, devPriorOf, learnerAngleIds } from "@/lib/cortex/learn/weekly";
import { weightsHash } from "@/lib/cortex/score/map";
import type { MapParams, MapRow, PassportRow } from "@/lib/cortex/store";

const FIXED: MapRow = {
  market: "AU",
  family: "F1",
  ruleVersion: "F1.zz.1",
  fittedAt: "2026-01-01T00:00:00.000Z",
  params: {
    a: 1,
    b: 0,
    s_mean: 0,
    s_sd: 1,
    K: 1,
    clusters: ["momentum"],
    angles: ["A-D1-02"],
    words: ["old"],
  } as unknown as MapParams,
  activeSetHash: "h",
  nEff: 1,
  pool: "p",
  fitSplit: "development",
};
const P = (m: MapRow) => m.params as unknown as Record<string, unknown>;

const decision = (over: Partial<CheckpointDecision>): CheckpointDecision => ({
  kind: "none",
  reason: "nothing",
  angleId: null,
  family: null,
  generation: null,
  reversesD: null,
  reversesSeq: null,
  expiresD: null,
  evidence: {},
  words: "",
  ...over,
});

describe("learner rows", () => {
  const g0 = generationZero(FIXED, ["A-D1-02", "A-D1-01"], {
    fittedAt: "2026-02-01T00:00:00.000Z",
    configHash: "c",
  });

  it("generation 0 copies the fixed map with equal weights and the learner fields", () => {
    expect(g0.ruleVersion).toBe("F1.learn");
    expect(g0.activeSetHash).toBe("h");
    expect(P(g0)).toMatchObject({ learner: true, based_on: "F1.zz.1", generation: 0, a: 1 });
    expect(P(g0).words).toBeUndefined();
    expect(learnerWeightsOf(g0)).toEqual(equalWeights(["A-D1-01", "A-D1-02"], ["momentum"]));
    expect(P(g0).weights_hash).toBe(weightsHash(learnerWeightsOf(g0)));
    expect(generationOf(g0)).toBe(0);
    expect(generationOf(FIXED)).toBe(0);
    expect(capsOf(g0)).toEqual({});
  });

  it("the next generation increments, drops caps and carries the evidence", () => {
    const w = { angle: { "A-D1-01": 0.8, "A-D1-02": 1.2 }, cluster: { momentum: 1 } };
    const capped = {
      ...g0,
      params: { ...g0.params, caps: { "A-D1-02": "2026-03-01" } } as MapParams,
    };
    const g1 = nextGeneration(capped, w, {
      fittedAt: "2026-02-08T00:00:00.000Z",
      configHash: "c",
      window: { from: "a", to: "b" },
      evidence: { x: 1 },
      words: ["w"],
    });
    expect(P(g1)).toMatchObject({ generation: 1, weights: w, words: ["w"], evidence: { x: 1 } });
    expect(P(g1).caps).toBeUndefined();
    expect(nextGeneration(FIXED, w, { fittedAt: "t", configHash: "c" }).params.based_on).toBe(
      "F1.zz.1",
    );
  });

  it("the nightly row: a cap halves and records its end; nothing to do is null", () => {
    expect(nightlyRow(FIXED, { nextSession: "x", decisions: [], fittedAt: "t" })).toBeNull();
    expect(nightlyRow(g0, { nextSession: "2026-02-03", decisions: [], fittedAt: "t" })).toBeNull();
    const cap = decision({ kind: "cap", angleId: "A-D1-02", expiresD: "2026-02-16" });
    const r = nightlyRow(g0, { nextSession: "2026-02-03", decisions: [cap], fittedAt: "t1" })!;
    expect(r.lifted).toEqual([]);
    expect(learnerWeightsOf(r.row).angle).toEqual({ "A-D1-01": 1, "A-D1-02": 0.5 });
    expect(P(r.row)).toMatchObject({
      generation: 0,
      generation_tag: "0c",
      caps: { "A-D1-02": "2026-02-16" },
    });
    expect(baseWeightsOf(r.row).angle["A-D1-02"]).toBe(1);
    // a cap without an end runs to the Friday check
    const open = nightlyRow(g0, {
      nextSession: "2026-02-03",
      decisions: [decision({ kind: "cap", angleId: "A-D1-02" })],
      fittedAt: "t1",
    })!;
    expect(capsOf(open.row)).toEqual({ "A-D1-02": "9999-12-31" });
    // the night before the cap ends it is lifted back to the generation's own weight
    const lift = nightlyRow(r.row, { nextSession: "2026-02-16", decisions: [], fittedAt: "t2" })!;
    expect(lift.lifted).toEqual(["A-D1-02"]);
    expect(learnerWeightsOf(lift.row).angle["A-D1-02"]).toBe(1);
    expect(P(lift.row).generation_tag).toBe("0e");
    expect(P(lift.row).caps).toBeUndefined();
  });

  it("a rollback lowers to the earlier generation, never raises", () => {
    const g1 = nextGeneration(
      g0,
      { angle: { "A-D1-01": 0.6, "A-D1-02": 1.4 }, cluster: { momentum: 1 } },
      {
        fittedAt: "2026-02-08T00:00:00.000Z",
        configHash: "c",
      },
    );
    const before = generationBefore([g0, g1], "F1.learn", 1)!;
    expect(before).toBe(g0);
    expect(generationBefore([g0, g1], "F1.learn", 0)).toBeUndefined();
    const rb = decision({ kind: "rollback", angleId: "A-D1-02", generation: 1 });
    const r = nightlyRow(g1, {
      nextSession: "2026-02-10",
      decisions: [rb],
      before: baseWeightsOf(before),
      fittedAt: "t",
    })!;
    expect(learnerWeightsOf(r.row).angle).toEqual({ "A-D1-01": 0.6, "A-D1-02": 1 });
    expect(P(r.row).generation_tag).toBe("1r");
  });

  it("the start session, the embargo instant and the config hash", () => {
    const sessions = ["2026-01-30", "2026-02-02", "2026-02-03"];
    expect(learnerStartD([g0], g0, sessions, "18:10")).toBe("2026-02-02");
    expect(learnerStartD([], g0, sessions)).toBeNull();
    expect(learnerStartD([g0], g0, ["2026-01-30"])).toBeNull();
    expect(embargoFittedAt("2026-02-02", 1000, "18:10")).toBe("2026-02-02T07:10:01.000Z");
    expect(configHash(LEARN_CONFIG)).toBe(
      configHash(learnConfig({ replicates: 100 }, { relaxed: true })),
    );
    expect(configHash(LEARN_CONFIG)).not.toBe(configHash(learnConfig({ maxStep: 0.3 })));
  });
});

describe("weekly pure helpers", () => {
  const pass = (angleId: string, evidence: unknown, status = "active"): PassportRow =>
    ({ angleId, evidence, status, cluster: "momentum" }) as unknown as PassportRow;
  it("the development IC is the first numeric key, else 0", () => {
    expect(devIcOf({ rank_ic: 0.03, ic: 0.1 })).toBe(0.03);
    expect(devIcOf({ ic: "x" })).toBe(0);
    expect(devIcOf(null)).toBe(0);
  });
  it("priors carry the registry cluster and name; the learner weighs the rule's own scored set", () => {
    const prior = devPriorOf(["A-D1-02", "A-ZZ-99"], [pass("A-D1-02", { dev_ic: 0.02 })]);
    expect(prior["A-D1-02"]!.devIc).toBe(0.02);
    expect(prior["A-D1-02"]!.name.length).toBeGreaterThan(0);
    expect(prior["A-ZZ-99"]).toEqual({ devIc: 0, cluster: "other", name: "" });
    expect(learnerAngleIds(FIXED, [pass("A-D1-02", {})])).toEqual(["A-D1-02"]);
    expect(learnerAngleIds(FIXED, [pass("A-D1-02", {}, "candidate")])).toEqual([]);
    // D-971: a base row admits its promoted measure without a passport row
    const base = {
      ...FIXED,
      params: { ...FIXED.params, admitted: ["A-D1-02", 7] },
    } as unknown as typeof FIXED;
    expect(learnerAngleIds(base, [pass("A-D1-02", {}, "candidate")])).toEqual(["A-D1-02"]);
  });
});

describe("duel glue", () => {
  const row = (
    bookId: string,
    code: string,
    ruleVersion: string | null,
    rankKey: string | null,
  ) => ({
    d: "2026-02-02",
    bookId,
    code,
    family: "F1",
    ruleVersion,
    rankKey,
  });
  const learners = new Map([["F1", { ruleVersion: "F1.learn", generation: 3 }]]);

  it("pairs the top pick of each real book; an abstained side is null", () => {
    const picks = duelPicks({
      decisionD: "2026-02-02",
      learners,
      regime: "RISK-ON",
      rows: [
        row("E01", "ZZB", "F1.zz.1", "[1,0]"),
        row("E01", "ZZA", "F1.zz.1", "[2,0]"),
        row("E01", "ZZC", "F1.zz.1", "[2,0]"),
        row("E01#learn", "ZZD", "F1.learn", "bad json"),
        row("E02#learn", "ZZE", "F1.learn", null),
        row("E03", "ZZF", null, "[1]"),
        { ...row("E04", "ZZG", "F1.zz.1", "[1]"), family: "F4" },
        { ...row("E05", "ZZG", "F1.zz.1", "[1]"), d: "2026-02-03" },
      ],
    });
    expect(picks.map((p) => [p.bookId, p.fixedCode, p.learnerCode, p.fixedRuleVersion])).toEqual([
      ["E01", "ZZA", "ZZD", "F1.zz.1"],
      ["E02", null, "ZZE", "none"],
      ["E03", "ZZF", null, "F1.v1"],
    ]);
    expect(picks[0]).toMatchObject({ learnerGeneration: 3, regime: "RISK-ON" });
  });

  it("forward returns from the decision close; a missing bar gives null or no entry", () => {
    const bars = new Map([
      [
        "A",
        [
          { d: "2026-02-02", c: 10 },
          { d: "2026-02-03", c: 11 },
          { d: "2026-03-02", c: 12 },
        ],
      ],
      ["B", [{ d: "2026-02-02", c: 10 }]],
      ["C", [{ d: "2026-02-03", c: 10 }]],
    ]);
    const f = forwardReturns({
      codes: ["A", "B", "C", "A"],
      decisionD: "2026-02-02",
      end20: "2026-03-02",
      bars,
    });
    expect(f.get("A@2026-02-02")).toEqual({ ret1Ppm: 100000, ret20Ppm: 200000 });
    expect(f.get("B@2026-02-02")).toEqual({ ret1Ppm: null, ret20Ppm: null });
    expect(f.has("C@2026-02-02")).toBe(false);
  });

  it("matured net pairs by night and book, disagreement only", () => {
    const o = (d: string, bookId: string, code: string, rv: string | null, net: number) => ({
      d,
      bookId,
      code,
      ruleVersion: rv,
      netMicro: net,
      fillMicro: 1_000_000,
      qty: 10,
    });
    const r = netDeltas(
      [
        o("2026-02-02", "E01", "A", "F1.zz.1", 1_000_000),
        o("2026-02-02", "E01#learn", "B", "F1.learn", 2_000_000),
        o("2026-02-03", "E01", "A", "F1.zz.1", 1_000_000),
        o("2026-02-03", "E01#learn", "A", "F1.learn", 1_000_000),
        o("2026-02-04", "E01", "A", "F1.zz.1", 1_000_000),
        { ...o("2026-02-05", "E01", "A", "F1.zz.1", 1), qty: 0 },
      ],
      "F1.learn",
    );
    expect(r.paired).toBe(2);
    expect(r.deltas).toEqual([0.1]);
  });

  const cmp = (i: number, agree: 0 | 1, l: number, f: number, regime = "RISK-ON"): CompareRow => ({
    market: "AU",
    decisionD: `2026-01-${String(i + 1).padStart(2, "0")}`,
    family: "F1",
    bookId: "E01",
    fixedRuleVersion: "F1.zz.1",
    learnerRuleVersion: "F1.learn",
    learnerGeneration: 0,
    fixedCode: "A",
    learnerCode: agree ? "A" : "B",
    agree,
    fixedRet1Ppm: 0,
    learnerRet1Ppm: 0,
    fixedRet20Ppm: f,
    learnerRet20Ppm: l,
    maturedD: "2026-02-01",
    regime,
  });

  it("the duel status: four-week series primary when the rule holds four weeks or less (D-927)", () => {
    const rows = [
      cmp(0, 1, 0, 0),
      ...Array.from({ length: 25 }, (_, i) => cmp(i + 1, 0, 60_000, 0)),
    ];
    const s = duelStatus({ compareRows: rows, net: [], hold: 20, config: LEARN_CONFIG });
    expect(s).toMatchObject({
      nights: 26,
      agree: 1,
      differ20: 25,
      primary: "four_weeks",
      matured: 0,
    });
    expect(s.eBetter20).toBeGreaterThan(20);
    expect(s.mean20).toBeCloseTo(0.06);
    expect(
      duelStatus({ compareRows: rows, net: [], hold: null, config: LEARN_CONFIG }).primary,
    ).toBe("net");
    expect(
      duelStatus({ compareRows: rows, net: [], hold: 120, config: LEARN_CONFIG }).primary,
    ).toBe("net");
    const cfg = learnConfig({ switchMinNights: 20 });
    expect(evaluateLeader({ status: s, leader: "fixed", sinceLastChange: null, config: cfg })).toBe(
      "switch",
    );
    expect(evaluateLeader({ status: s, leader: "fixed", sinceLastChange: 3, config: cfg })).toBe(
      "stay",
    );
    const net = duelStatus({ compareRows: rows, net: [], hold: null, config: cfg });
    expect(
      evaluateLeader({ status: net, leader: "fixed", sinceLastChange: null, config: cfg }),
    ).toBe("stay");
    const behind = duelStatus({
      compareRows: Array.from({ length: 25 }, (_, i) => cmp(i, 0, -60_000, 0)),
      net: [],
      hold: 20,
      config: cfg,
    });
    expect(
      evaluateLeader({ status: behind, leader: "learner", sinceLastChange: 1, config: cfg }),
    ).toBe("fallback");
  });
});

describe("integration phrases (LRN-AT-9)", () => {
  it("are plain market words", () => {
    for (const w of [
      startWords("F1"),
      startWords(null),
      duelWaitingWords("F1"),
      capLiftWords(["52-week-high proximity"]),
    ]) {
      expect(cleanWords(w), w).toBe(true);
    }
    expect(capLiftWords(["a", "b"])).toContain("'a' and 'b'");
  });
});
