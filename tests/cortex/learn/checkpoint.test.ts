// @vitest-environment node
// The 2–3-day checkpoint (cortex_learning_architecture B.4; LRN-AT-5 checkpoint half, LRN-AT-8).
import { describe, expect, it } from "vitest";
import {
  applyCheckpoint,
  checkpoint,
  checkpointEvents,
  CHECKPOINT_KINDS,
  isCheckpointNight,
  pageHinkley,
  type CheckpointInputs,
} from "@/lib/cortex/learn/checkpoint";
import { learnConfig } from "@/lib/cortex/learn/config";
import type { AngleDayRow, LearnerWeights, LearnEvent, LeaderRow } from "@/lib/cortex/learn/types";
import { isoWeek } from "@/lib/view/format";
import { belowInt, scopedPrng, uniform01 } from "@/lib/stats/rng";
import { compareRow, event, icPaths, normal, row, rowsOf, weekdays } from "./fixtures";

const DATES = weekdays(400);
const ANGLES = ["A-D1-01", "A-D1-02", "A-D2-01", "A-D2-02", "A-D3-01", "A-D3-02"];
const NAMES = Object.fromEntries(ANGLES.map((a, i) => [a, { name: `angle ${i + 1}` }]));
const EQUAL: LearnerWeights = {
  angle: Object.fromEntries(ANGLES.map((a) => [a, 1])),
  cluster: { momentum: 1, liquidity: 1, quality: 1 },
};
const config = learnConfig({ replicates: 300 }, { relaxed: true });

function inputs(
  t: number,
  rows: readonly AngleDayRow[],
  extra: Partial<CheckpointInputs> = {},
): CheckpointInputs {
  const from = DATES[Math.max(0, t - 119)]!;
  return {
    market: "ASX",
    d: DATES[t]!,
    calendar: DATES,
    angleDays120: rows.filter((r) => r.d >= from && r.d <= DATES[t]!),
    angles: NAMES,
    weights: EQUAL,
    events10: [],
    compareRows: [],
    leaders: [],
    config,
    ...extra,
  };
}

describe("isCheckpointNight", () => {
  const cal = DATES.slice(0, 10);
  const base = { startD: cal[0]!, calendar: cal, abstainTonight: false, abstainLastNight: false };
  it("every second session from the start; postponed one session after an abstain-all night", () => {
    expect(cal.map((d) => isCheckpointNight({ ...base, d }))).toEqual(
      cal.map((_, i) => i % 2 === 0),
    );
    expect(isCheckpointNight({ ...base, d: cal[2]!, abstainTonight: true })).toBe(false);
    expect(isCheckpointNight({ ...base, d: cal[3]!, abstainLastNight: true })).toBe(true);
    expect(isCheckpointNight({ ...base, d: "2020-01-01" })).toBe(false);
    expect(isCheckpointNight({ ...base, startD: cal[5]!, d: cal[2]! })).toBe(false);
  });
});

describe("pageHinkley", () => {
  it("a drop raises the fall statistic, a rise the rise statistic", () => {
    const flat = Array.from({ length: 60 }, () => 0.03);
    const drop = [...flat, ...Array.from({ length: 20 }, () => -0.01)];
    const rise = [...flat, ...Array.from({ length: 20 }, () => 0.07)];
    expect(pageHinkley(flat, 0.005)).toEqual({ fall: 0, rise: 0 });
    expect(pageHinkley(drop, 0.005).fall).toBeGreaterThan(0.3);
    expect(pageHinkley(drop, 0.005).rise).toBe(0);
    expect(pageHinkley(rise, 0.005).rise).toBeGreaterThan(0.3);
  });
});

describe("checkpoint", () => {
  it("LRN-AT-5 (checkpoint): an IC drop at session 100 is capped within 20 sessions; a rise is never raised", () => {
    const paths = icPaths({
      angles: ANGLES,
      sessions: 160,
      sd: 0.015,
      seed: "at5c",
      meanAt: (a, t) =>
        a === "A-D2-01"
          ? t >= 100
            ? -0.01
            : 0.03
          : a === "A-D1-01"
            ? t >= 100
              ? 0.08
              : 0.03
            : 0.03,
    });
    const rows = rowsOf(paths, DATES, 0, 160, [1]);
    let weights = EQUAL;
    let capAt: number | null = null;
    let rise = 0;
    for (let t = 100; t < 140; t += 2) {
      const out = checkpoint(inputs(t, rows, { weights }));
      for (const x of out) expect(CHECKPOINT_KINDS).toContain(x.kind);
      const next = applyCheckpoint(weights, out);
      for (const a of ANGLES) expect(next.angle[a]!).toBeLessThanOrEqual(weights.angle[a]!);
      expect(next.angle["A-D1-01"]).toBe(1); // the rising angle is never raised (nor cut)
      if (
        out.some(
          (x) => x.angleId === "A-D1-01" && x.kind === "escalate" && x.reason === "rise_alarm",
        )
      )
        rise += 1;
      const cap = out.find((x) => x.angleId === "A-D2-01" && x.kind === "cap");
      if (cap && capAt === null) {
        capAt = t;
        expect(cap.expiresD).toBe(DATES[t + config.capSessions]);
        expect(next.angle["A-D2-01"]).toBe(0.5);
      }
      weights = next;
    }
    expect(capAt).not.toBeNull();
    expect(capAt! - 100).toBeLessThanOrEqual(20);
    expect(rise).toBeGreaterThan(0);
  });

  it("data break first: PSI above the level or a universe jump stops the angle's other checks", () => {
    const paths = icPaths({
      angles: ["A-D1-01", "A-D1-02"],
      sessions: 120,
      sd: 0.01,
      seed: "db",
      meanAt: (_a, t) => (t >= 100 ? -0.05 : 0.03),
    });
    const rows = rowsOf(paths, DATES, 0, 120, [1]).map((r) =>
      r.d === DATES[119]
        ? r.angleId === "A-D1-01"
          ? { ...r, psiPpm: 400_000 }
          : { ...r, n: 300 }
        : r,
    );
    const out = checkpoint(
      inputs(119, rows, { angles: { "A-D1-01": { name: "x" }, "A-D1-02": { name: "y" } } }),
    );
    expect(out.map((x) => [x.angleId, x.kind, x.reason])).toEqual([
      ["A-D1-01", "none", "data_break"],
      ["A-D1-02", "none", "data_break"],
    ]);
    expect(out[0]!.words).toContain("data, not learning");
  });

  it("form rule: 8 of the last 10 nights below the median → words only", () => {
    const rng = scopedPrng("form");
    const series = Array.from({ length: 110 }, () => 0.02 + 0.01 * normal(rng));
    const sorted = [...series].sort((a, b) => a - b);
    const med = sorted[55]!;
    for (let i = 0; i < 10; i += 1) series.push(med - 0.004);
    const rows = series.map((ic, t) => row(DATES[t]!, "A-D1-01", 1, ic));
    const out = checkpoint(inputs(119, rows, { angles: { "A-D1-01": { name: "x" } } }));
    expect(out.map((x) => [x.kind, x.reason])).toEqual([["none", "quiet"]]);
    expect(out[0]!.words).toContain("10 of the last 10 nights");
  });

  it("too short a series, or a quiet night → 'nothing to change'", () => {
    const rows = DATES.slice(0, 10).map((d) => row(d, "A-D1-01", 1, 0.01));
    const out = checkpoint(inputs(9, rows, { angles: { "A-D1-01": { name: "x" } } }));
    expect(out.map((x) => x.reason)).toEqual(["nothing"]);
    expect(checkpointEvents("ASX", DATES[9]!, out, 4)).toEqual([
      expect.objectContaining({ kind: "checkpoint", seq: 4, words: "Review: nothing to change." }),
    ]);
  });

  // Five angles fall together.
  const fallRows = () => {
    const paths = icPaths({
      angles: ANGLES.slice(0, 5),
      sessions: 120,
      sd: 0.01,
      seed: "fall5",
      meanAt: (_a, t) => (t >= 100 ? -0.03 : 0.03),
    });
    return rowsOf(paths, DATES, 0, 120, [1]);
  };

  it("weekly cap: with 2 actions already this week only 1 more; the rest are recorded as escalate", () => {
    const t = 119;
    const sameWeek = DATES.filter((d) => isoWeek(d) === isoWeek(DATES[t]!) && d < DATES[t]!);
    expect(sameWeek.length).toBeGreaterThanOrEqual(1);
    const events10: LearnEvent[] = [
      event(sameWeek[0]!, 0, "watch", { angleId: "A-D3-02" }),
      event(sameWeek[0]!, 1, "cap", { angleId: "A-D3-02", expiresD: DATES[t - 1]! }),
      event(DATES[t - 12]!, 0, "cap", { angleId: "A-D3-02", expiresD: DATES[t - 2]! }), // last week: not counted
    ];
    const out = checkpoint(inputs(t, fallRows(), { events10 }));
    const acts = out.filter((x) => ["watch", "cap", "rollback"].includes(x.kind));
    const esc = out.filter((x) => x.reason === "weekly_cap");
    expect(acts.length).toBe(1);
    expect(esc.length).toBe(4);
    expect(esc[0]!.evidence.wanted).toBe("cap");
    expect(esc[0]!.words).toContain("this week's limit");
  });

  it("an angle already capped is not capped again; at the floor it is watched; a recent raise is rolled back", () => {
    const t = 119;
    const d = DATES[t]!;
    const events10: LearnEvent[] = [
      event(DATES[t - 3]!, 0, "cap", { angleId: "A-D1-01", expiresD: DATES[t + 5]! }),
      event(DATES[t - 4]!, 2, "reweight", { generation: 7, evidence: { raisedMost: "A-D1-02" } }),
      event(DATES[t - 4]!, 3, "reweight", { generation: 6, evidence: { raisedMost: "A-D2-01" } }),
      event(DATES[t - 30]!, 0, "reweight", { generation: 2, evidence: { raisedMost: "A-D2-02" } }), // too old
    ];
    const weights: LearnerWeights = {
      angle: { ...EQUAL.angle, "A-D2-02": 0.25 },
      cluster: EQUAL.cluster,
    };
    const out = checkpoint(
      inputs(t, fallRows(), {
        events10,
        weights,
        config: learnConfig({ replicates: 300, actionsWeekMax: 6 }, { relaxed: true }),
      }),
    );
    const by = Object.fromEntries(out.map((x) => [x.angleId, x]));
    expect(by["A-D1-01"]).toBeUndefined();
    expect(by["A-D1-02"]).toMatchObject({
      kind: "rollback",
      generation: 7,
      reversesSeq: 2,
      reversesD: DATES[t - 4],
    });
    expect(by["A-D2-01"]).toMatchObject({ kind: "rollback", generation: 6, reversesSeq: 3 });
    expect(by["A-D2-02"]).toMatchObject({ kind: "watch" });
    expect(by["A-D3-01"]).toMatchObject({ kind: "cap" });
    const ev = checkpointEvents("ASX", d, out, 0);
    expect(ev.find((e) => e.kind === "rollback")!.evidence.reverses).toBe(`${DATES[t - 4]}:2`);
    expect(ev.find((e) => e.kind === "cap")!.expiresD).toBe(DATES[t + 10]);
    const before: LearnerWeights = {
      angle: { ...EQUAL.angle, "A-D1-02": 0.7, "A-D2-01": 1.4 },
      cluster: { momentum: 0.8, liquidity: 1.3, quality: 1 },
    };
    const next = applyCheckpoint(weights, out, before);
    expect(next.angle["A-D1-02"]).toBe(0.7);
    expect(next.angle["A-D2-01"]).toBe(1);
    expect(next.angle["A-D3-01"]).toBe(0.5);
    expect(next.cluster).toEqual({ momentum: 0.8, liquidity: 1, quality: 1 });
    expect(out[0]!.words).toMatch(/weekly update of \w{3} \d+ \w{3}/);
  });

  it("the cap expiry date is unknown beyond the calendar", () => {
    const out = checkpoint({ ...inputs(119, fallRows()), calendar: DATES.slice(0, 120) });
    const cap = out.find((x) => x.kind === "cap")!;
    expect(cap.expiresD).toBeNull();
    expect(cap.words).toContain("until the Friday check");
  });

  it("LRN-AT-8 fuzz: closed kinds, never a weight increase, never more than the weekly cap", () => {
    const rng = scopedPrng("fuzz");
    const kinds = ["watch", "cap", "rollback", "reweight", "escalate", "checkpoint"] as const;
    for (let c = 0; c < 120; c += 1) {
      const nA = 1 + belowInt(rng, 6);
      const ids = ANGLES.slice(0, nA);
      const T = 20 + belowInt(rng, 120);
      const shiftAt = belowInt(rng, T);
      const paths = icPaths({
        angles: ids,
        sessions: T,
        sd: 0.005 + 0.05 * uniform01(rng),
        seed: `fuzz:${c}`,
        meanAt: (a, t) => (t >= shiftAt ? (uniform01(rng) < 0.5 ? -0.05 : 0.05) : 0.02),
      });
      const rows = rowsOf(paths, DATES, 0, T, [1]).map((r) =>
        uniform01(rng) < 0.05 ? { ...r, ic: null, psiPpm: belowInt(rng, 500_000) } : r,
      );
      const t = T - 1;
      const events10: LearnEvent[] = [];
      const nE = belowInt(rng, 8);
      for (let e = 0; e < nE; e += 1) {
        const back = belowInt(rng, Math.min(10, t + 1));
        events10.push(
          event(DATES[t - back]!, e, kinds[belowInt(rng, kinds.length)]!, {
            angleId: ids[belowInt(rng, ids.length)]!,
            generation: belowInt(rng, 5),
            expiresD: DATES[t - back + belowInt(rng, 12)]!,
            evidence: { raisedMost: ids[belowInt(rng, ids.length)]! },
          }),
        );
      }
      const weights: LearnerWeights = {
        angle: Object.fromEntries(ids.map((a) => [a, 2 * uniform01(rng)])),
        cluster: { momentum: 2 * uniform01(rng), liquidity: 2 * uniform01(rng) },
      };
      const before: LearnerWeights = {
        angle: Object.fromEntries(ids.map((a) => [a, 3 * uniform01(rng)])),
        cluster: { momentum: 3 * uniform01(rng), liquidity: 3 * uniform01(rng), extra: 9 },
      };
      const leaders: LeaderRow[] =
        uniform01(rng) < 0.5
          ? [
              {
                market: "ASX",
                family: "F1",
                sinceD: DATES[0]!,
                leader: "learner",
                learnerRuleVersion: null,
                learnerGeneration: null,
                evidence: {},
                setBy: "evaluator",
              },
            ]
          : [];
      const compareRows = DATES.slice(0, Math.min(t, 40)).map((d) =>
        compareRow(d, 0.05 * normal(rng) - 0.01),
      );
      const cfg = learnConfig(
        { replicates: 60, actionsWeekMax: 1 + belowInt(rng, 6) },
        { relaxed: true },
      );
      const inp: CheckpointInputs = {
        market: "ASX",
        d: DATES[t]!,
        calendar: DATES,
        angleDays120: rows,
        angles: Object.fromEntries(ids.map((a) => [a, { name: a.toLowerCase() }])),
        weights,
        events10,
        compareRows,
        leaders,
        config: cfg,
      };
      const out = checkpoint(inp);
      expect(out.length).toBeGreaterThan(0);
      for (const x of out) expect(CHECKPOINT_KINDS).toContain(x.kind);
      const week = isoWeek(DATES[t]!);
      const prior = events10.filter(
        (e) =>
          e.d < DATES[t]! && ["watch", "cap", "rollback"].includes(e.kind) && isoWeek(e.d) === week,
      ).length;
      const acts = out.filter((x) => ["watch", "cap", "rollback"].includes(x.kind)).length;
      expect(acts).toBeLessThanOrEqual(Math.max(0, cfg.actionsWeekMax - prior));
      const next = applyCheckpoint(weights, out, before);
      expect(Object.keys(next.angle).sort()).toEqual(Object.keys(weights.angle).sort());
      expect(Object.keys(next.cluster).sort()).toEqual(Object.keys(weights.cluster).sort());
      for (const k of Object.keys(weights.angle))
        expect(next.angle[k]!).toBeLessThanOrEqual(weights.angle[k]!);
      for (const k of Object.keys(weights.cluster))
        expect(next.cluster[k]!).toBeLessThanOrEqual(weights.cluster[k]!);
      // Deterministic: the same inputs give the same decisions.
      expect(JSON.stringify(checkpoint(inp))).toBe(JSON.stringify(out));
    }
  });
});
