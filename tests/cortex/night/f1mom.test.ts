// F1.v2-mom in the night (O-79; D-888..D-891): the exclusive angle, the rule's own scored set and hash,
// the within-tier ranking, the time_hold plan and the tranche cadence. ZZ world (no real data).
import { describe, expect, it } from "vitest";
import type { Family } from "@/lib/agents/families/types";
import { defaultAgentParams } from "@/lib/agents/params";
import { ruleScoredSet, scoredSet } from "@/lib/cortex/angles/registry";
import type { AngleDef } from "@/lib/cortex/angles/types";
import {
  familyPlan,
  isEntryNight,
  runNight,
  timeHoldPlan,
  type FamilyNightRule,
} from "@/lib/cortex/night";
import { activeSetHash } from "@/lib/cortex/score/map";
import type { CortexMap } from "@/lib/cortex/score/types";
import {
  calendarFor,
  HASH,
  mapFor,
  NIGHT_ANGLES,
  nightInputs,
  nightView,
  nightWorld,
  PASSPORTS,
  ruleFor,
  SESSIONS,
} from "./zzNight";

/** A synthetic exclusive momentum angle (the night's stand-in for A-D1-11): 10-session return. */
const EXCL: AngleDef = {
  id: "A-D1-11",
  version: 1,
  domain: 1,
  title: "ZZ long momentum",
  definition: "close over the close ten sessions back, minus one",
  kind: "score",
  cluster: "momentum",
  orientation: 1,
  horizonSessions: 120,
  warmupSessions: 11,
  inputs: ["bar_au"],
  grid: {},
  exclusive: true,
  compute: (view, code, t) => {
    const s = view.adj(code, t, 11);
    if (s.adjClose.length < 11) return undefined;
    return Number(s.adjClose[10]! - s.adjClose[0]!) / Number(s.adjClose[0]!);
  },
};
const ANGLES = [...NIGHT_ANGLES, EXCL];
const PASS = new Map([...PASSPORTS, ["A-D1-11", "active" as const]]);
const OWN_SET = [{ id: "A-D1-11", version: 1, cluster: "momentum" as const }];
const OWN_HASH = activeSetHash(OWN_SET);

const momRule = (extra: Partial<FamilyNightRule> = {}): FamilyNightRule =>
  ruleFor("F1", {
    ruleVersion: "F1.v2-mom",
    clusters: ["momentum"],
    angles: ["A-D1-11"],
    top3MinS: -1,
    plan: "time_hold",
    hold: 120,
    ...extra,
  });
const momMap = (): CortexMap => ({
  ...mapFor("F1"),
  ruleVersion: "F1.v2-mom",
  K: 1,
  clusters: ["momentum"],
  activeSetHash: OWN_HASH,
});

function inputsWith(rule: FamilyNightRule, t = SESSIONS.length - 1) {
  const base = nightInputs(t);
  return nightInputs(t, {
    angles: ANGLES,
    passports: PASS,
    rules: new Map<Family, FamilyNightRule>([...base.rules, ["F1", rule]]),
    maps: new Map([...base.maps, ["F1", momMap()]]),
  });
}

describe("exclusive angles (D-888)", () => {
  it("never enter the global scored set, so the shared hash is the same with or without them", () => {
    const status = (id: string) => PASS.get(id) ?? "candidate";
    const global = scoredSet(ANGLES, status);
    expect(global.map((a) => a.id)).not.toContain("A-D1-11");
    const hash = activeSetHash(
      global.map((a) => ({ id: a.id, version: a.version, cluster: a.cluster as "momentum" })),
    );
    expect(hash).toBe(HASH);
  });

  it("are scored by a rule that lists them; unknown or inactive ids are left out", () => {
    const status = (id: string) => PASS.get(id) ?? "candidate";
    expect(ruleScoredSet(ANGLES, status, ["A-D1-11"]).map((a) => a.id)).toEqual(["A-D1-11"]);
    expect(ruleScoredSet(ANGLES, status, ["A-D1-11", "A-D9-99"]).map((a) => a.id)).toEqual([
      "A-D1-11",
    ]);
    expect(ruleScoredSet(ANGLES, () => "candidate", ["A-D1-11"])).toEqual([]);
    expect(ruleScoredSet(ANGLES, status, undefined)).toEqual(scoredSet(ANGLES, status));
  });

  it("leave the night's shared features, hash and the other families' decisions unchanged", () => {
    const plain = runNight(nightInputs());
    const withRule = runNight(inputsWith(momRule()));
    expect(withRule.activeSetHash).toBe(plain.activeSetHash);
    expect([...withRule.features.values()].every((m) => !m.has("A-D1-11"))).toBe(true);
    const others = (out: typeof plain) =>
      JSON.stringify(
        [...out.shadow, ...out.blocked].filter((x) => x.family !== "F1"),
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      );
    expect(others(withRule)).toBe(others(plain));
  });
});

describe("the F1.v2-mom rule in the night (D-889, D-890)", () => {
  it("scores the rule's own set under its own map and gives the time_hold plan", () => {
    const out = runNight(inputsWith(momRule()));
    const f1 = [...out.decisions, ...out.queued, ...out.shadow].filter((x) => x.family === "F1");
    expect(f1.length).toBeGreaterThan(0);
    for (const dec of f1) {
      expect(dec.plan.trails).toEqual([]);
      expect(dec.plan.cs).toEqual([
        { id: "max_hold", via: null, kind: "time_stop", sessions: 120, minReturn: null },
      ]);
      expect(dec.p).not.toBeNull(); // the map passed the guard on the rule's own hash
    }
  });

  it("blocks every candidate at G04 when a listed angle is missing (never a throw)", () => {
    const out = runNight(inputsWith(momRule({ angles: ["A-D1-11", "A-D9-99"] })));
    const f1 = out.blocked.filter((x) => x.family === "F1");
    expect(f1.length).toBeGreaterThan(0);
    expect(f1.every((x) => x.firstFail === "G04_economic")).toBe(true);
    expect([...out.decisions, ...out.shadow].filter((x) => x.family === "F1")).toEqual([]);
  });

  it("ranks the listed angle within the rule's tiers only", () => {
    // a U3-only rule sees no U1 code: no F1 candidate at all
    const out = runNight(inputsWith(momRule({ tiers: ["U3"] })));
    expect(
      [...out.decisions, ...out.shadow, ...out.blocked].filter((x) => x.family === "F1"),
    ).toEqual([]);
  });
});

describe("timeHoldPlan and familyPlan (D-890)", () => {
  const params = defaultAgentParams();
  it("is a cap stop at max_stop_distance_pct, no trail, one time stop", () => {
    const plan = timeHoldPlan(params, 120);
    expect(plan.initialStops).toEqual([
      {
        id: "initial",
        via: null,
        spec: { atr_micro: null, k: null, cap: params.entry.maxStopDistance, level_micro: null },
      },
    ]);
    expect(plan.trails).toEqual([]);
    expect(familyPlan("F1", params, 1_000n, { plan: "time_hold", hold: 120 })).toEqual(plan);
    expect(familyPlan("F1", params, 1_000n)).not.toEqual(plan);
  });
  it("refuses a missing or bad hold", () => {
    expect(() => timeHoldPlan(params, undefined)).toThrow(/hold/);
    expect(() => timeHoldPlan(params, 0)).toThrow(/hold/);
    expect(() => timeHoldPlan(params, 1.5)).toThrow(/hold/);
  });
});

describe("tranche cadence (D-891)", () => {
  const view = nightView(nightWorld());
  const rule = { entryEvery: 5, entryAnchor: SESSIONS[10]! };
  it("enters only on nights a multiple of entryEvery sessions from the anchor, both ways", () => {
    expect(isEntryNight(rule, SESSIONS[10]!, view)).toBe(true);
    expect(isEntryNight(rule, SESSIONS[15]!, view)).toBe(true);
    expect(isEntryNight(rule, SESSIONS[5]!, view)).toBe(true);
    expect(isEntryNight(rule, SESSIONS[11]!, view)).toBe(false);
    expect(isEntryNight(rule, SESSIONS[9]!, view)).toBe(false);
    expect(isEntryNight(undefined, SESSIONS[11]!, view)).toBe(true);
  });
  it("uses the calendar walk for an anchor outside the view", () => {
    const far = { entryEvery: 5, entryAnchor: "2026-01-26" }; // a Monday, 5 weekdays before 2026-02-02
    const cal = { sessions: [SESSIONS[0]!], calendar: calendarFor(SESSIONS) };
    expect(isEntryNight(far, SESSIONS[0]!, cal)).toBe(true);
    expect(isEntryNight(far, SESSIONS[1]!, { ...cal, sessions: [SESSIONS[1]!] })).toBe(false);
  });
  it("makes no decision, blocked row or abstain for the rule's books off an entry night", () => {
    const t = SESSIONS.length - 1;
    const anchor = SESSIONS[t - 1]!; // the last night is one session after the anchor
    const out = runNight(inputsWith(momRule({ entryEvery: 20, entryAnchor: anchor }), t));
    const f1 = [...out.decisions, ...out.queued, ...out.shadow, ...out.blocked].filter(
      (x) => x.family === "F1",
    );
    expect(f1).toEqual([]);
    expect(out.abstains.filter((a) => a.bookId === "E01")).toEqual([]);
    const on = runNight(inputsWith(momRule({ entryEvery: 20, entryAnchor: SESSIONS[t]! }), t));
    expect([...on.decisions, ...on.shadow].filter((x) => x.family === "F1").length).toBeGreaterThan(
      0,
    );
  });
});
