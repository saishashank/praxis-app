// @vitest-environment node
// D-1860: trial angles (passport measured / candidate) in the learning Cortex's scorecard. They are scored
// beside the proven angles under `trial:<id>` keys and ids, worded as trial, and can never reach the
// weights, the map, a leader or the "Chance of a net gain".
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ANGLES } from "@/lib/cortex/angles/registry";
import { baseIdOf, isTrialId, trialDefsOf, trialId } from "@/lib/cortex/angles/trial";
import type { AngleStatus } from "@/lib/cortex/angles/types";
import {
  moverCoverage,
  scorecardNight,
  trialAngles,
  type FeatureNight,
} from "@/lib/cortex/learn/scorecard";
import { angleDaysOfHorizon, angleDaysSince, insertAngleDays } from "@/lib/cortex/learn/store";
import { top5Flags } from "@/lib/cortex/learn/top5";
import {
  coverageWords,
  hasBannedTerm,
  NO_HISTORY_WORDS,
  scorecardWords,
  TRIAL_LABEL,
} from "@/lib/cortex/learn/words";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { BACK21, D, featureNight, input, PREV } from "./zzLearn";

afterEach(cleanupTempDbs);
const NOW = new Date(`${D}T00:00:00.000Z`);

/** A feature night whose angles are all TRIAL (keys `trial:<id>`). */
const trialNight = (d: string): FeatureNight => {
  const n = featureNight(d);
  return {
    d,
    rows: n.rows.map((r) => ({
      ...r,
      features: Object.fromEntries(
        Object.entries(r.features)
          .filter(([k]) => k !== "A-D1-09") // the gate is stored but never scored
          .map(([k, v]) => [trialId(k), v]),
      ),
    })),
  };
};
/** A night with proven AND trial values in the same rows. */
const mixedNight = (d: string): FeatureNight => {
  const p = featureNight(d);
  const t = trialNight(d);
  return {
    d,
    rows: p.rows.map((r, i) => ({ ...r, features: { ...r.features, ...t.rows[i]!.features } })),
  };
};

describe("trial angle set", () => {
  const status = (m: Record<string, AngleStatus>) => new Map(Object.entries(m));
  it("takes measured / candidate score angles with a compute and live readers, never active, watch or retired", () => {
    const ok = ANGLES.filter((a) => a.kind === "score" && a.exclusive !== true).slice(0, 4);
    const [a, b, c, d] = ok;
    const set = trialDefsOf(
      ANGLES,
      [],
      status({ [a!.id]: "measured", [b!.id]: "candidate", [c!.id]: "retired", [d!.id]: "active" }),
    ).map((x) => x.id);
    expect(set).not.toContain(c!.id);
    expect(set).not.toContain(d!.id);
    expect(set.length).toBeGreaterThan(0);
    // an angle with no passport is not trial; a gate angle never is
    expect(trialDefsOf(ANGLES, [], new Map())).toEqual([]);
    const gate = ANGLES.find((x) => x.kind === "gate")!;
    expect(trialDefsOf(ANGLES, [], status({ [gate.id]: "measured" }))).toEqual([]);
    // an angle already in the scored set is not trial too
    expect(trialDefsOf(ANGLES, [a!], status({ [a!.id]: "measured" }))).toEqual([]);
  });
  it("marks and unmarks ids", () => {
    expect(trialId("A-D1-02")).toBe("trial:A-D1-02");
    expect(isTrialId("trial:A-D1-02")).toBe(true);
    expect(isTrialId("A-D1-02")).toBe(false);
    expect(baseIdOf("trial:A-D1-02")).toBe("A-D1-02");
    expect(baseIdOf("A-D1-02")).toBe("A-D1-02");
  });
});

describe("scorecard with trial values", () => {
  it("scores trial angles under trial ids with a trial manifest id; proven rows are untouched", () => {
    const proven = scorecardNight(input());
    const mixed = scorecardNight(
      input({ featuresPrev: mixedNight(PREV), featuresBack20: mixedNight(BACK21) }),
    );
    const isT = (r: { angleId: string }) => isTrialId(r.angleId);
    expect(mixed.rows.filter((r) => !isT(r))).toEqual(proven.rows);
    const t = mixed.rows.filter(isT);
    expect(t.length).toBeGreaterThan(0);
    expect(new Set(t.map((r) => r.angleId))).toEqual(
      new Set(["trial:A-D1-02", "trial:A-D2-01", "trial:A-D1-06"]),
    );
    expect(t.every((r) => r.manifestId.startsWith("trial:"))).toBe(true);
    expect(t.find((r) => r.angleId === "trial:A-D1-02" && r.horizon === 1)!.ic).toBe(
      proven.rows.find((r) => r.angleId === "A-D1-02" && r.horizon === 1)!.ic,
    );
  });
  it("a night without trial values gives rows with no trial marker", () => {
    expect(trialAngles(featureNight(PREV))).toEqual([]);
    expect(JSON.stringify(scorecardNight(input()).rows)).not.toContain("trial:");
  });
});

describe("mover coverage", () => {
  const movers = [
    { code: "ZZ040", side: "gainer" as const, cause: "x" },
    { code: "ZZ001", side: "loser" as const, cause: "x" },
  ];
  it("is null without any score; uses trial scores only when no proven angle has any, and says so", () => {
    expect(moverCoverage(null, movers)).toBeNull();
    const proven = moverCoverage(featureNight(PREV), movers);
    expect(proven).not.toBeNull();
    expect(proven!.trial).toBeUndefined();
    expect(moverCoverage(trialNight(PREV), movers)).toMatchObject({ trial: true });
    // proven scores win when both exist
    expect(moverCoverage(mixedNight(PREV), movers)!.trial).toBeUndefined();
  });
});

describe("words", () => {
  const cov = {
    gainers: 5,
    gainersInTop: 1,
    losers: 5,
    losersInTop: 0,
    newsBeforeOpen: 0,
    newsInTop: 0,
    scored: 40,
  };
  it("no passports at all: the history has not been loaded yet", () => {
    const s = scorecardWords({ d: D, rows: [], coverage: null, historyLoaded: false, now: NOW });
    expect(s.lines[0]).toBe(NO_HISTORY_WORDS);
    expect(s.lines[2]).toBe(
      "The Cortex's history has not been loaded yet, so the angles cannot be judged over a month.",
    );
    expect(s.lines.join(" ")).not.toContain("stored no scores");
    // with a history but no night, the old wording stands
    expect(coverageWords("Tue 10 Nov", null)).toContain("stored no scores");
    expect(coverageWords("Tue 10 Nov", null, true)).toContain("stored no scores");
  });
  it("trial-only scores are called trial scores (angles not yet proven), never proof", () => {
    const card = scorecardNight(
      input({ featuresPrev: trialNight(PREV), featuresBack20: trialNight(BACK21) }),
    );
    const s = scorecardWords({
      d: D,
      rows: card.rows.filter((r) => !isTrialId(r.angleId)),
      trialRows: card.rows.filter((r) => isTrialId(r.angleId)),
      coverage: { ...cov, trial: true },
      now: NOW,
    });
    expect(s.lines[0]).toContain(`Judged on ${TRIAL_LABEL}`);
    expect(s.lines[1]).toContain(`on ${TRIAL_LABEL}`);
    expect(s.lines[2]).toContain(`on ${TRIAL_LABEL}`);
    expect(s.lines[1]).toContain("'52-week-high proximity'");
    expect(s.numbers.rows).toBe(0);
    expect(s.numbers.trial).toMatchObject({ rows: card.rows.length, nextDayOf: 2 });
    for (const l of s.lines) expect(hasBannedTerm(l)).toBe(false);
  });
  it("proven angles are worded as before when both exist; trial adds only numbers", () => {
    const both = scorecardNight(
      input({ featuresPrev: mixedNight(PREV), featuresBack20: mixedNight(BACK21) }),
    );
    const proven = scorecardNight(input());
    const a = scorecardWords({
      d: D,
      rows: both.rows.filter((r) => !isTrialId(r.angleId)),
      trialRows: both.rows.filter((r) => isTrialId(r.angleId)),
      coverage: cov,
      now: NOW,
    });
    const b = scorecardWords({ d: D, rows: proven.rows, coverage: cov, now: NOW });
    expect(a.lines).toEqual(b.lines);
    expect(a.numbers.trial).toBeDefined();
    expect(b.numbers.trial).toBeUndefined();
  });
});

describe("top-5 flags", () => {
  it("never carry a trial angle", () => {
    const sets = {
      gainers: [{ code: "ZZ040" }],
      losers: [{ code: "ZZ001" }],
    } as unknown as Parameters<typeof top5Flags>[1];
    const flags = top5Flags(mixedNight(PREV), sets);
    expect(Object.keys(flags).some((k) => k.startsWith("trial:"))).toBe(false);
    expect(Object.keys(flags)).toContain("A-D1-02");
  });
});

describe("the learner never reads a trial row", () => {
  it("angleDaysSince and angleDaysOfHorizon leave trial rows out", async () => {
    const db = await freshDb("main");
    const card = scorecardNight(
      input({ featuresPrev: mixedNight(PREV), featuresBack20: mixedNight(BACK21) }),
    );
    expect(card.rows.some((r) => isTrialId(r.angleId))).toBe(true);
    await insertAngleDays(db, card.rows);
    const all = await db.execute("SELECT COUNT(*) AS n FROM cortex_angle_day");
    expect(Number(all.rows[0]!.n)).toBe(card.rows.length);
    const since = await angleDaysSince(db, "AU", "2000-01-01");
    for (const r of since) expect(isTrialId(r.angleId)).toBe(false);
    expect(since.length).toBe(card.rows.filter((r) => !isTrialId(r.angleId)).length);
    for (const h of [1, 20] as const) {
      for (const r of await angleDaysOfHorizon(db, "AU", h, "2000-01-01"))
        expect(isTrialId(r.angleId)).toBe(false);
    }
  });
  it("the chance of a net gain reads no angle score and no trial marker", () => {
    const src = readFileSync("src/lib/picks/chance.ts", "utf8");
    expect(src).not.toMatch(/cortex_angle_day|cortex_feature_daily|trial/);
  });
});
