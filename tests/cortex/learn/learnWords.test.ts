// @vitest-environment node
// LRN-AT-9: every learner line comes from the phrase helpers and passes the ban list (CTX-070 + no angle
// ids, no ISO dates, no "sessions", no statistic names); spans in weeks; dates as "Fri 6 Nov".
import { describe, expect, it } from "vitest";
import { applyCheckpoint, checkpoint } from "@/lib/cortex/learn/checkpoint";
import { learnConfig } from "@/lib/cortex/learn/config";
import * as W from "@/lib/cortex/learn/learnWords";
import { reweight, type DevPrior } from "@/lib/cortex/learn/reweight";
import { scopedPrng } from "@/lib/stats/rng";
import { event, icPaths, rowsOf, weekdays } from "./fixtures";

const NIGHT = "2026-11-06";

describe("learnWords", () => {
  it("the ban list catches what it must", () => {
    for (const bad of [
      "angle A-D1-02 moved",
      "on 2026-11-06",
      "at 20:30:00",
      "over 20 sessions",
      "e-value 12",
      "the p-value",
      "IC fell",
      "PSI jumped",
      "Page–Hinkley alarm",
      "the lower bound",
      "top decile",
      "n_eff 24",
      "G07_gap_cap",
      "rule F1.learn",
      "generation 17",
    ]) {
      expect(W.cleanWords(bad), bad).toBe(false);
    }
    expect(W.cleanWords("Review: nothing to change.")).toBe(true);
  });

  it("spans in weeks, luck as 1 in N, dates as 'Fri 6 Nov'", () => {
    expect(W.spanWords(20)).toBe("four weeks");
    expect(W.spanWords(5)).toBe("a week");
    expect(W.spanWords(60)).toBe("twelve weeks");
    expect(W.spanWords(120)).toBe("24 weeks");
    expect(W.spanWords(13)).toBe("13 trading days");
    expect(W.luckWords(12.4)).toBe("chance of luck about 1 in 12");
    expect(W.luckWords(0.5)).toBe("no better than chance so far");
    expect(W.luckWords(5000)).toBe("chance of luck below 1 in 1,000");
    expect(W.dayWords("2026-11-06", NIGHT)).toBe("Fri 6 Nov");
    expect(W.dayWords("2027-01-08", NIGHT)).toBe("Fri 8 Jan 2027");
    expect(W.falseAlarmWords(99)).toContain("once in 100 trading days");
    expect(W.percentWords(0.011)).toBe("1.1 %");
    expect(W.nameList([])).toBe("");
    expect(W.nameList(["a"])).toBe("'a'");
    expect(W.nameList(["a", "b", "c"])).toBe("'a', 'b' and 'c'");
    expect(W.familyWords("F1")).toBe("the trend breakout setup");
    expect(W.familyWords(null)).toBe("this setup");
    expect(W.clusterWords("momentum")).toBe("recent price strength");
    expect(W.clusterWords("nope")).toBe("another group of angles");
  });

  it("LRN-AT-9: every phrase helper's output is clean", () => {
    const name = "52-week-high proximity";
    const lines = [
      W.NOTHING_TO_CHANGE,
      W.dataBreakWords(name),
      W.watchWords(name, 99),
      W.capWords(name, 99, "2026-11-20", NIGHT),
      W.capWords(undefined, 99, null, NIGHT),
      W.rollbackWords(name, "2026-10-31", NIGHT),
      W.riseWords(name),
      W.quietWords(name, 8, 10),
      W.weeklyLimitWords(name),
      W.fallbackWords("F1", 14, "2026-12-12", NIGHT),
      W.fallbackWords(null, 14, null, NIGHT),
      W.ownerOffWords("F4"),
      W.switchWords("F1", 25, 41),
      W.duelWords({ agree: 23, nights: 31, mean: 0.009, e: 6, matured: 3, needed: 40 }),
      W.duelWords({ agree: 10, nights: 10, mean: 0, e: 1, matured: 0, needed: 40 }),
      W.duelWords({ agree: 5, nights: 10, mean: -0.004, e: 0.4, matured: 0, needed: 40 }),
      W.reweightWords({
        changed: true,
        up: [name],
        down: ["range contraction"],
        maxStep: 0.25,
        realMove: 0.11,
        placeboMove: 0.08,
      }),
      W.reweightWords({
        changed: true,
        up: [],
        down: [],
        maxStep: 0.4,
        realMove: 0.03,
        placeboMove: 0.08,
      }),
      W.reweightWords({
        changed: false,
        up: [],
        down: [],
        maxStep: 0.25,
        realMove: 0,
        placeboMove: null,
      }),
    ];
    for (const l of lines) expect(W.cleanWords(l), l).toBe(true);
    expect(W.capWords(name, 99, "2026-11-20", NIGHT)).toContain(
      "until Fri 20 Nov or the Friday check",
    );
    expect(lines[16]).not.toContain("within chance");
    expect(lines[17]).toContain("within chance");
    expect(lines[17]).toContain("40.0 % of the way");
  });

  it("LRN-AT-9: the words the cores emit (checkpoint and reweight) are clean", () => {
    const dates = weekdays(200);
    const ids = ["A-D1-01", "A-D1-02", "A-D2-01"];
    const plain: Record<string, string> = {
      "A-D1-01": "52-week-high proximity",
      "A-D1-02": "relative strength",
      "A-D2-01": "heavy volume",
    };
    const paths = icPaths({
      angles: ids,
      sessions: 140,
      sd: 0.01,
      seed: "w",
      meanAt: (a, t) => (t >= 120 ? (a === "A-D1-01" ? -0.05 : 0.09) : 0.03),
    });
    const rows = rowsOf(paths, dates, 0, 140, [1, 20]);
    const config = learnConfig({ replicates: 100, actionsWeekMax: 1 }, { relaxed: true });
    const out = checkpoint({
      market: "ASX",
      d: dates[139]!,
      calendar: dates,
      angleDays120: rows,
      angles: Object.fromEntries(ids.map((a) => [a, { name: plain[a]! }])),
      weights: { angle: { "A-D1-01": 1, "A-D1-02": 1, "A-D2-01": 1 }, cluster: {} },
      events10: [
        event(dates[136]!, 0, "reweight", { generation: 3, evidence: { raisedMost: "A-D1-01" } }),
      ],
      compareRows: [],
      leaders: [],
      config,
    });
    expect(out.length).toBeGreaterThan(0);
    for (const x of out) expect(W.cleanWords(x.words), x.words).toBe(true);
    expect(
      applyCheckpoint({ angle: { "A-D1-01": 1 }, cluster: {} }, out).angle["A-D1-01"],
    ).toBeLessThanOrEqual(1);
    const prior: DevPrior = Object.fromEntries(
      ids.map((a) => [
        a,
        { devIc: 0.03, cluster: a.startsWith("A-D1") ? "momentum" : "liquidity", name: plain[a]! },
      ]),
    );
    const r = reweight({
      angleDays60: rows.filter((x) => x.d >= dates[80]!),
      devPrior: prior,
      current: { angle: {}, cluster: {} },
      config,
      prng: scopedPrng("w"),
    });
    for (const l of r.words) expect(W.cleanWords(l), l).toBe(true);
  });
});
