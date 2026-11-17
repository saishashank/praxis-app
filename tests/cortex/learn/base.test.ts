// @vitest-environment node
// The strict base test (Owner O-81; design B.2 tier "Learning"): a synthetic strong candidate measure
// is promoted once two 60-day blocks agree (about 120 trading days) and never before; 200 seeds of pure
// noise never pass at any weekly look; the retirement test is the mirror; one change per month; the
// new base version and its system map row; Owner words. Synthetic data only, pure (no database).
import { describe, expect, it } from "vitest";
import { ANGLES } from "@/lib/cortex/angles/registry";
import type { AngleStatus } from "@/lib/cortex/angles/types";
import {
  BASE_Q,
  BLOCK_SESSIONS,
  MAX_BLOCKS,
  T_MIN,
  baseChangeWords,
  baseRuleVersion,
  blockEvidence,
  changeAllowed,
  chooseChange,
  isSystemRow,
  nextBase,
  probeFutility,
  rootRuleVersion,
  strictVerdicts,
  type EvidenceNight,
} from "@/lib/cortex/learn/base";
import type { BaseVersionRow } from "@/lib/cortex/learn/baseStore";
import { cleanWords } from "@/lib/cortex/learn/learnWords";
import { activeSetHash } from "@/lib/cortex/score/map";
import type { MapRow } from "@/lib/cortex/store/maps";
import { scopedPrng, uniform01 } from "@/lib/stats/rng";
import { weekdays } from "./zzLearn";

const SESSIONS = weekdays("2025-01-06", "2026-12-31");

function normal(prng: ReturnType<typeof scopedPrng>): number {
  const u = Math.max(1e-12, uniform01(prng));
  const v = uniform01(prng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Nights of an angle: next-day correlation `mu + sd·z`, four-week one of the same sign, regimes in
 *  40-day spells. */
function series(seed: string, n: number, mu: number, sd = 0.08): EvidenceNight[] {
  const prng = scopedPrng(`base-test:${seed}`);
  return SESSIONS.slice(0, n).map((d, i) => {
    const ic1 = mu + sd * normal(prng);
    return {
      d,
      ic1: Math.max(-1, Math.min(1, ic1)),
      ic20: mu === 0 ? sd * normal(prng) : mu,
      regime: Math.floor(i / 40) % 2 === 0 ? "RISK-ON" : "NEUTRAL",
    };
  });
}

const pass = (nights: EvidenceNight[], n: number, tried = 1, direction: "up" | "down" = "up") =>
  strictVerdicts(
    [
      {
        angleId: "A-D2-07",
        evidence: blockEvidence(SESSIONS.slice(0, n), nights, direction),
        charged: true,
      },
    ],
    tried,
  )[0]!;

describe("blockEvidence: fixed 60-day blocks from the start", () => {
  it("is not ready with one block and reads at most four blocks", () => {
    const s = series("ready", 400, 0.05);
    expect(blockEvidence(SESSIONS.slice(0, 119), s, "up").ready).toBe(false);
    const e2 = blockEvidence(SESSIONS.slice(0, 120), s, "up");
    expect(e2.ready).toBe(true);
    expect(e2.blockMeans).toHaveLength(2);
    expect(e2.nights).toBe(120);
    const e6 = blockEvidence(SESSIONS.slice(0, 6 * BLOCK_SESSIONS + 10), s, "up");
    expect(e6.blocksDone).toBe(6);
    expect(e6.firstBlock).toBe(6 - MAX_BLOCKS);
    expect(e6.blockMeans).toHaveLength(MAX_BLOCKS);
  });

  it("the evidence changes only when a block completes (a weekly re-read is not a new look)", () => {
    const s = series("look", 300, 0.01);
    const a = blockEvidence(SESSIONS.slice(0, 121), s, "up");
    const b = blockEvidence(SESSIONS.slice(0, 179), s, "up");
    expect(b).toEqual(a);
  });

  it("a block with fewer than 30 nights of results has no mean and cannot agree", () => {
    const s = series("thin", 120, 0.05).map((n, i) =>
      i < 100 && i >= 20 ? { ...n, ic1: null } : n,
    );
    const e = blockEvidence(SESSIONS.slice(0, 120), s, "up");
    expect(e.blockMeans[0]).toBeNull();
    expect(e.blocksAgree).toBe(false);
  });

  it("a constant series gives a huge t, p ~0 in its direction and 1 against it", () => {
    const flat = SESSIONS.slice(0, 120).map((d) => ({ d, ic1: 0.02, ic20: 0.02, regime: "X" }));
    const up = blockEvidence(SESSIONS.slice(0, 120), flat, "up");
    expect(up.t!).toBeGreaterThan(1e9);
    expect(up.p).toBeLessThan(1e-12);
    expect(blockEvidence(SESSIONS.slice(0, 120), flat, "down").p).toBe(1);
    const zero = flat.map((n) => ({ ...n, ic1: 0 }));
    expect(blockEvidence(SESSIONS.slice(0, 120), zero, "up").t).toBe(0);
    expect(blockEvidence(SESSIONS.slice(0, 120), [], "up").p).toBe(1);
  });
});

describe("promotion: the Learning tier (two blocks, t > 3, BH q 0.05 over all probes tried, regimes)", () => {
  const strong = series("strong", 400, 0.05);

  it("fires on a strong synthetic probe at 120 trading days and not one day earlier", () => {
    expect(pass(strong, 119).pass).toBe(false);
    expect(pass(strong, 119).failed).toContain("blocks");
    const v = pass(strong, 120);
    expect(v.failed).toEqual([]);
    expect(v.pass).toBe(true);
  });

  it("never fires on pure noise: 200 seeds, every weekly look from 120 to 250 days", () => {
    let fired = 0;
    let looks = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const s = series(`noise:${seed}`, 250, 0);
      for (let n = 120; n <= 250; n += 5) {
        looks += 1;
        if (pass(s, n).pass) fired += 1;
      }
    }
    expect(looks).toBe(200 * 27);
    expect(fired).toBe(0);
  });

  it("needs the charge first, the four-week sign, and every regime of 30+ nights", () => {
    const e = blockEvidence(SESSIONS.slice(0, 120), strong, "up");
    expect(strictVerdicts([{ angleId: "x", evidence: e, charged: false }], 1)[0]!.failed).toEqual([
      "not_charged",
    ]);
    const wrong20 = strong.map((n) => ({ ...n, ic20: -0.05 }));
    expect(pass(wrong20, 120).failed).toContain("four_weeks");
    // one regime (40-day spells, the first and third spells) pointing the wrong way
    const badRegime = strong.map((n) =>
      n.regime === "NEUTRAL" ? { ...n, ic1: n.ic1! - 0.12 } : n,
    );
    const v = pass(badRegime, 120);
    expect(v.failed).toContain("regime");
  });

  it("BH across all probes tried: a marginal probe passes alone but not among many tried", () => {
    // t just above 3: mean 0.025, sd 0.08 over 120 nights → t ≈ 3.4
    const marginal = SESSIONS.slice(0, 120).map((d, i) => ({
      d,
      ic1: 0.025 + (i % 2 === 0 ? 0.08 : -0.08),
      ic20: 0.025,
      regime: "X",
    }));
    const alone = pass(marginal, 120, 1);
    expect(alone.pass).toBe(true);
    const many = pass(marginal, 120, 400);
    expect(many.failed).toEqual(["bh"]);
  });

  it("a probe that points the wrong way at a block end is futile; four blocks without passing expire it", () => {
    const bad = series("bad", 400, -0.03);
    expect(probeFutility(blockEvidence(SESSIONS.slice(0, 120), bad, "up"))).toBe("futile");
    expect(probeFutility(blockEvidence(SESSIONS.slice(0, 60), bad, "up"))).toBeNull();
    const weak = series("weak", 400, 0.004);
    const e = blockEvidence(SESSIONS.slice(0, MAX_BLOCKS * BLOCK_SESSIONS), weak, "up");
    expect(["expired", "futile"]).toContain(probeFutility(e));
    expect(probeFutility(blockEvidence(SESSIONS.slice(0, 120), strong, "up"))).toBeNull();
  });
});

describe("retirement: the mirror test", () => {
  it("retires a base measure that kept pointing the wrong way, not a noisy one", () => {
    const broken = series("broken", 400, -0.05);
    expect(pass(broken, 120, 50, "down").pass).toBe(true);
    expect(pass(broken, 119, 50, "down").pass).toBe(false);
    let fired = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      if (pass(series(`noise-r:${seed}`, 250, 0), 240, 50, "down").pass) fired += 1;
    }
    expect(fired).toBe(0);
    // a strong measure is never retired
    expect(pass(series("good", 400, 0.05), 120, 50, "down").pass).toBe(false);
  });
});

describe("one change per family per month; retirement before promotion; never an empty base", () => {
  const cur = { version: 2, sinceD: "2026-03-02" };
  it("changeAllowed counts trading days since the version's first night", () => {
    expect(changeAllowed({ version: 1, sinceD: "2026-03-02" }, "2026-03-03", [])).toBe(true);
    expect(changeAllowed(cur, "2026-03-30", [])).toBe(false); // 20 trading days later
    expect(changeAllowed(cur, "2026-03-27", [])).toBe(false);
    expect(changeAllowed(cur, "2026-03-31", [])).toBe(true);
    expect(changeAllowed(cur, "2026-02-27", [])).toBe(false);
  });

  it("chooseChange", () => {
    const ev = (t: number) =>
      ({ ...blockEvidence([], [], t > 0 ? "up" : "down"), t }) as ReturnType<typeof blockEvidence>;
    const v = (id: string, ok: boolean) => ({ angleId: id, pass: ok, adjustedP: 0, failed: [] });
    const promos = [
      { verdict: v("A", true), evidence: ev(4) },
      { verdict: v("B", true), evidence: ev(6) },
      { verdict: v("C", false), evidence: ev(9) },
    ];
    const retires = [
      { verdict: v("R1", true), evidence: ev(-4) },
      { verdict: v("R2", true), evidence: ev(-7) },
    ];
    expect(chooseChange(promos, retires, 3)?.angleId).toBe("R2");
    expect(chooseChange(promos, retires, 1)?.angleId).toBe("B");
    expect(chooseChange(promos, [], 3)).toMatchObject({ kind: "promote", angleId: "B" });
    expect(chooseChange([], [], 3)).toBeNull();
  });
});

describe("nextBase: version 1 → 2, the system row, the count in words", () => {
  const status = (id: string): AngleStatus => (id === "A-D1-11" ? "active" : "candidate");
  const v1: BaseVersionRow = {
    market: "AU",
    family: "F1",
    version: 1,
    sinceD: "2026-03-02",
    reason: "initial",
    ruleVersion: "F1.v2-mom",
    angles: ["A-D1-11"],
    added: [],
    removed: [],
    evidence: {},
    createdAt: "2026-03-02T20:00:00.000Z",
  };
  const fixed: MapRow = {
    market: "AU",
    family: "F1",
    ruleVersion: "F1.v2-mom",
    fittedAt: "2026-01-01T00:00:00.000Z",
    params: {
      a: 1.2,
      b: -0.3,
      s_mean: 0,
      s_sd: 1,
      K: 1,
      clusters: ["momentum"],
      angles: ["A-D1-11"],
      tiers: ["U1"],
      top3_min_s: 0.8,
      plan: "time_hold",
      hold: 120,
    } as unknown as MapRow["params"],
    activeSetHash: "h",
    nEff: 300,
    pool: "F1",
    fitSplit: "development",
  };
  const strong = series("strong", 400, 0.05);
  const evidence = blockEvidence(SESSIONS.slice(0, 120), strong, "up");
  const change = {
    kind: "promote" as const,
    angleId: "A-D2-07",
    verdict: { angleId: "A-D2-07", pass: true, adjustedP: 0, failed: [] },
    evidence,
  };

  it("adds the measure, numbers the version and writes a p-less system row used from the next night", () => {
    const nb = nextBase({
      current: v1,
      map: fixed,
      change,
      sinceD: "2026-08-25",
      now: "2026-08-24T20:00:00.000Z",
      angles: ANGLES,
      status,
      evidence: { t: evidence.t },
    })!;
    expect(nb.version).toMatchObject({
      version: 2,
      reason: "promote",
      ruleVersion: "F1.v2-mom+b2",
      angles: ["A-D1-11", "A-D2-07"],
      added: ["A-D2-07"],
      removed: [],
      sinceD: "2026-08-25",
    });
    const p = nb.map.params as unknown as Record<string, unknown>;
    expect(isSystemRow(nb.map)).toBe(true);
    expect(p).toMatchObject({
      system: true,
      base_version: 2,
      based_on: "F1.v2-mom",
      claims_p: false,
      p_hidden: true,
      a: 0,
      b: 0,
      K: 2,
      clusters: ["momentum", "event"],
      angles: ["A-D1-11", "A-D2-07"],
      admitted: ["A-D2-07"],
      refit_from: "2026-08-25",
      top3_min_s: 0.8,
      plan: "time_hold",
    });
    expect(p.learner).toBeUndefined();
    expect(nb.map.fittedAt).toBe("2026-08-24T20:00:00.000Z");
    expect(nb.map.ruleVersion).toBe("F1.v2-mom+b2");
    expect(nb.map.activeSetHash).toBe(
      activeSetHash([
        { id: "A-D1-11", version: 1, cluster: "momentum" },
        { id: "A-D2-07", version: 2, cluster: "event" },
      ]),
    );
    const words = baseChangeWords({
      family: "F1",
      change,
      count: nb.version.angles.length,
      sinceD: "2026-08-25",
      tonight: "2026-08-24",
    });
    expect(words).toContain("New measure added to the base");
    expect(words).toContain("heavy trading without news (the base now has 2 measures)");
    expect(words).toContain("Tue 25 Aug");
    expect(cleanWords(words)).toBe(true);
  });

  it("retires (count goes down), from a system row carrying learner keys it drops them", () => {
    const v2 = { ...v1, version: 2, ruleVersion: "F1.v2-mom+b2", angles: ["A-D1-11", "A-D2-07"] };
    const sys: MapRow = {
      ...fixed,
      ruleVersion: "F1.v2-mom+b2",
      params: {
        ...(fixed.params as object),
        angles: ["A-D1-11", "A-D2-07"],
        admitted: ["A-D2-07"],
        learner: true,
        weights: {},
      } as unknown as MapRow["params"],
    };
    const nb = nextBase({
      current: v2,
      map: sys,
      change: { ...change, kind: "retire", angleId: "A-D2-07" },
      sinceD: "2026-11-02",
      now: "2026-10-30T20:00:00.000Z",
      angles: ANGLES,
      status,
      evidence: {},
    })!;
    expect(nb.version).toMatchObject({ version: 3, reason: "retire", removed: ["A-D2-07"] });
    expect(nb.version.ruleVersion).toBe("F1.v2-mom+b3");
    const p = nb.map.params as unknown as Record<string, unknown>;
    expect(p.admitted).toBeUndefined();
    expect(p.learner).toBeUndefined();
    expect(p.weights).toBeUndefined();
    expect(p.K).toBe(1);
    const words = baseChangeWords({
      family: "F1",
      change: { kind: "retire", angleId: "A-D2-07", evidence },
      count: 1,
      sinceD: "2026-11-02",
      tonight: "2026-10-30",
    });
    expect(words).toContain("Measure taken out of the base");
    expect(words).toContain("(the base now has 1 measure)");
    expect(cleanWords(words)).toBe(true);
  });

  it("refuses an empty base or an unknown id", () => {
    const retireLast = { ...change, kind: "retire" as const, angleId: "A-D1-11" };
    expect(
      nextBase({
        current: v1,
        map: fixed,
        change: retireLast,
        sinceD: "x",
        now: "y",
        angles: ANGLES,
        status,
        evidence: {},
      }),
    ).toBeNull();
    expect(
      nextBase({
        current: v1,
        map: fixed,
        change: { ...change, angleId: "A-D9-99" },
        sinceD: "x",
        now: "y",
        angles: ANGLES,
        status,
        evidence: {},
      }),
    ).toBeNull();
  });

  it("rule versions", () => {
    expect(rootRuleVersion("F1.v2-mom+b3")).toBe("F1.v2-mom");
    expect(baseRuleVersion("F1.v2-mom+b2", 3)).toBe("F1.v2-mom+b3");
    expect(BASE_Q).toBe(0.05);
    expect(T_MIN).toBe(3);
  });
});
