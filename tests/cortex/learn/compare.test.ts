// @vitest-environment node
// Champion / challenger duel (cortex_learning_architecture C.5; LRN-AT-7). Synthetic duel series only.
import { describe, expect, it } from "vitest";
import { checkpoint } from "@/lib/cortex/learn/checkpoint";
import {
  duelDeltas,
  eProcess,
  forwardKey,
  leaderDecision,
  matureComparisons,
  regimeOk,
  type DuelPick,
} from "@/lib/cortex/learn/compare";
import { learnConfig, LEARN_CONFIG } from "@/lib/cortex/learn/config";
import type { LeaderRow } from "@/lib/cortex/learn/types";
import { scopedPrng } from "@/lib/stats/rng";
import { compareRow, normal, weekdays } from "./fixtures";

const DATES = weekdays(400);
const TAU = LEARN_CONFIG.duelTau;

describe("matureComparisons", () => {
  const pick = (d: string, f: string | null, l: string | null): DuelPick => ({
    decisionD: d,
    family: "F1",
    bookId: "B1",
    fixedRuleVersion: "F1.v2-mom",
    learnerRuleVersion: "F1.learn",
    learnerGeneration: 3,
    fixedCode: f,
    learnerCode: l,
    regime: "RISK_ON",
  });
  it("writes matured pairs only, sorted, with agree and abstentions", () => {
    const forward = new Map([
      [forwardKey("AAA", DATES[0]!), { ret1Ppm: 1000, ret20Ppm: 20_000 }],
      [forwardKey("BBB", DATES[0]!), { ret1Ppm: -500, ret20Ppm: 5000 }],
      [forwardKey("AAA", DATES[1]!), { ret1Ppm: 0, ret20Ppm: null }],
      [forwardKey("CCC", DATES[2]!), { ret1Ppm: 0, ret20Ppm: 30_000 }],
    ]);
    const rows = matureComparisons({
      market: "ASX",
      maturedD: DATES[30]!,
      picks: [
        pick(DATES[2]!, null, "CCC"),
        pick(DATES[0]!, "AAA", "BBB"),
        pick(DATES[1]!, "AAA", "AAA"), // 20-session leg not matured
        pick(DATES[3]!, "ZZZ", null), // no forward return at all
        pick(DATES[4]!, null, null),
      ],
      forward,
    });
    expect(rows.map((r) => r.decisionD)).toEqual([DATES[0], DATES[2], DATES[4]]);
    expect(rows[0]!.agree).toBe(0);
    expect(rows[0]!.learnerRet20Ppm).toBe(5000);
    expect(rows[1]!.fixedRet20Ppm).toBeNull();
    expect(rows[2]!.agree).toBe(1);
    expect(duelDeltas(rows)).toEqual([-0.015, 0.03]);
    expect(duelDeltas(rows, 1)).toEqual([-0.0015, 0]);
  });
  it("skips agree rows and rows whose picked side has no return", () => {
    const rows = [
      compareRow(DATES[0]!, null),
      compareRow(DATES[1]!, 0.01),
      compareRow(DATES[2]!, 0.01, { learnerRet20Ppm: null }),
    ];
    expect(duelDeltas(rows)).toEqual([0.01]);
  });
});

describe("eProcess", () => {
  it("n = 0 is no evidence; tau must be positive; sides are mirror images", () => {
    expect(eProcess([], "better", TAU)).toEqual({ e: 1, n: 0, mean: 0, lo90: -Infinity });
    expect(() => eProcess([0.01], "better", 0)).toThrow(RangeError);
    const xs = [0.03, 0.01, 0.04, 0.02, 0.05, 0.0, 0.03];
    const up = eProcess(xs, "better", TAU);
    const down = eProcess(
      xs.map((x) => -x),
      "worse",
      TAU,
    );
    expect(up.e).toBeCloseTo(down.e, 9);
    expect(up.e).toBeGreaterThan(1);
    expect(eProcess(xs, "worse", TAU).e).toBeLessThan(1);
    expect(up.lo90).toBeLessThan(up.mean);
  });

  it("always valid: under no edge, peeking every night for 200 nights crosses 1/α rarely", () => {
    let crossed = 0;
    const SIMS = 400;
    for (let s = 0; s < SIMS; s += 1) {
      const rng = scopedPrng(`null:${s}`);
      const xs: number[] = [];
      for (let n = 0; n < 200; n += 1) {
        xs.push(0.03 * normal(rng));
        if (eProcess(xs, "better", TAU).e >= 1 / LEARN_CONFIG.switchAlpha) {
          crossed += 1;
          break;
        }
      }
    }
    // α = 0.05 with a plug-in sd; allow sampling slack.
    expect(crossed / SIMS).toBeLessThanOrEqual(0.08);
  });
});

describe("leaderDecision and LRN-AT-7 (switch, fallback, cool-down)", () => {
  const config = LEARN_CONFIG;

  it("switch needs e ≥ 20 AND ≥ 40 matured disagreement nights, never before", () => {
    const rng = scopedPrng("ahead");
    const xs: number[] = [];
    let firstE20: number | null = null;
    let switchedAt: number | null = null;
    for (let n = 1; n <= 200 && switchedAt === null; n += 1) {
      xs.push(0.03 + 0.02 * normal(rng));
      const better = eProcess(xs, "better", TAU);
      const worse = eProcess(xs, "worse", TAU);
      if (firstE20 === null && better.e >= 20) firstE20 = n;
      const call = leaderDecision({
        leader: "fixed",
        eLearnerBetter: better.e,
        eLearnerWorse: worse.e,
        disagreeNights: n,
        regimeOk: true,
        sinceLastChange: null,
        config,
      });
      if (call === "switch") {
        switchedAt = n;
        expect(better.e).toBeGreaterThanOrEqual(20);
      }
      expect(call).not.toBe("fallback");
    }
    expect(firstE20).not.toBeNull();
    expect(firstE20!).toBeLessThan(40); // evidence came early...
    expect(switchedAt).toBe(40); // ...but the switch waited for the 40 nights.
  });

  it("no switch while a regime is negative, the learner's verdict is worse, inside the cool-down or with the kill on", () => {
    const base = {
      leader: "fixed" as const,
      eLearnerBetter: 100,
      eLearnerWorse: 0.1,
      disagreeNights: 50,
      regimeOk: true,
      sinceLastChange: null,
      config,
    };
    expect(leaderDecision(base)).toBe("switch");
    expect(leaderDecision({ ...base, regimeOk: false })).toBe("stay");
    expect(leaderDecision({ ...base, verdictOk: false })).toBe("stay");
    expect(leaderDecision({ ...base, sinceLastChange: 19 })).toBe("stay");
    expect(leaderDecision({ ...base, sinceLastChange: 20 })).toBe("switch");
    expect(leaderDecision({ ...base, eLearnerWorse: 10 })).toBe("stay");
    expect(leaderDecision({ ...base, config: learnConfig({ learnerOff: 1 }) })).toBe("stay");
    expect(
      leaderDecision({ ...base, leader: "learner", config: learnConfig({ learnerOff: 1 }) }),
    ).toBe("fallback");
  });

  it("learner behind at α 0.10 → fallback at the next checkpoint, immediately (no cool-down), then 20 sessions before a switch", () => {
    const leaders: LeaderRow[] = [
      {
        market: "ASX",
        family: "F1",
        sinceD: DATES[0]!,
        leader: "learner",
        learnerRuleVersion: "F1.learn",
        learnerGeneration: 1,
        evidence: {},
        setBy: "evaluator",
      },
    ];
    const rng = scopedPrng("behind");
    const rows = [];
    let fellBackAt: number | null = null;
    for (let i = 1; i < 120 && fellBackAt === null; i += 1) {
      rows.push(compareRow(DATES[i]!, -0.03 + 0.02 * normal(rng)));
      if (i % 2 !== 0) continue; // checkpoints every second session
      const out = checkpoint({
        market: "ASX",
        d: DATES[i]!,
        calendar: DATES,
        angleDays120: [],
        angles: {},
        weights: { angle: {}, cluster: {} },
        events10: [],
        compareRows: rows,
        leaders,
        config,
      });
      const fb = out.find((x) => x.kind === "fallback");
      const eWorse = eProcess(
        rows.map((r) => (r.learnerRet20Ppm! - r.fixedRet20Ppm!) / 1e6),
        "worse",
        TAU,
      ).e;
      if (fb) {
        fellBackAt = i;
        expect(eWorse).toBeGreaterThanOrEqual(10);
        expect(fb.family).toBe("F1");
        expect(fb.expiresD).toBe(DATES[i + 20]);
        expect(fb.words).toContain("fallen behind");
      } else {
        expect(eWorse).toBeLessThan(10);
      }
    }
    expect(fellBackAt).not.toBeNull();
    // After the fallback the fixed rule leads; a strong learner cannot switch back inside 20 sessions.
    for (let k = 0; k < 20; k += 1) {
      expect(
        leaderDecision({
          leader: "fixed",
          eLearnerBetter: 1e6,
          eLearnerWorse: 0,
          disagreeNights: 100,
          regimeOk: true,
          sinceLastChange: k,
          config,
        }),
      ).toBe("stay");
    }
  });

  it("checkpoint: the Owner kill falls back; a fixed leader is never switched by a checkpoint", () => {
    const mk = (leader: "fixed" | "learner"): LeaderRow[] => [
      {
        market: "ASX",
        family: "F1",
        sinceD: DATES[0]!,
        leader,
        learnerRuleVersion: null,
        learnerGeneration: null,
        evidence: {},
        setBy: "evaluator",
      },
      {
        market: "ASX",
        family: "F4",
        sinceD: DATES[50]!,
        leader: "learner",
        learnerRuleVersion: null,
        learnerGeneration: null,
        evidence: {},
        setBy: "evaluator",
      },
    ];
    const ahead = DATES.slice(1, 80).map((d) => compareRow(d, 0.05));
    const base = {
      market: "ASX",
      d: DATES[10]!,
      calendar: DATES,
      angleDays120: [],
      angles: {},
      weights: { angle: {}, cluster: {} },
      events10: [],
      compareRows: ahead,
      config,
    };
    expect(checkpoint({ ...base, leaders: mk("fixed") }).map((x) => x.kind)).toEqual(["none"]);
    const off = checkpoint({
      ...base,
      leaders: mk("learner"),
      config: learnConfig({ learnerOff: 1 }),
    });
    expect(off.map((x) => [x.kind, x.reason])).toEqual([["fallback", "owner_off"]]);
    expect(off[0]!.words).toContain("switched off");
  });

  it("regimeOk: a regime with ≥ 10 disagreement nights and a negative mean blocks", () => {
    const good = DATES.slice(0, 12).map((d) => compareRow(d, 0.01));
    const bad = DATES.slice(12, 24).map((d) => compareRow(d, -0.01, { regime: "RISK_OFF" }));
    const small = DATES.slice(24, 30).map((d) => compareRow(d, -0.05, { regime: "SHOCK" }));
    expect(regimeOk([...good, ...small], 10)).toBe(true);
    expect(regimeOk([...good, ...bad], 10)).toBe(false);
  });
});
