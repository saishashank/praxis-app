// @vitest-environment node
// The learner as a challenger in the night (design C.4; D-923): its rows in the shadow arm only, with
// `#learn` book ids and its own rule version; the roles swap through the same code path when the
// learner leads (`#fixed`); LRN-AT-6 on the night (a stale or hand-edited learner map blocks only
// the learner's rows). runNight stays pure and deterministic. Synthetic ZZ world only.
import { describe, expect, it } from "vitest";
import type { Family } from "@/lib/agents/families/types";
import {
  baseBookId,
  FIXED_SUFFIX,
  LEARN_SUFFIX,
  nightOutputJson,
  runNight,
  type BlockedDecision,
  type Decision,
  type FamilyNightRule,
  type NightChallenger,
  type NightOutput,
} from "@/lib/cortex/night";
import { weightsHash } from "@/lib/cortex/score/map";
import type { CortexMap, ScoreWeights } from "@/lib/cortex/score/types";
import { scoreOf } from "@/lib/cortex/score/score";
import { CLUSTERS, mapFor, nightInputs, ruleFor, SCORED, SESSIONS } from "./zzNight";

const T = SESSIONS.length - 1;
/** Within the cap at K = 3 (largest share 1 / 2.9 ≈ 0.345 ≤ 0.35). */
const W: ScoreWeights = { cluster: { liquidity: 0.9 }, angle: { "A-D1-01": 1 } };

function learnRule(extra: Partial<FamilyNightRule> = {}): FamilyNightRule {
  return ruleFor("F1", {
    ruleVersion: "F1.learn",
    learner: true,
    basedOn: "F1.zz.1",
    generation: 2,
    weights: W,
    ...extra,
  });
}
function learnMap(over: Partial<CortexMap> = {}): CortexMap {
  return {
    ...mapFor("F1"),
    ruleVersion: "F1.learn",
    fittedAt: "2026-03-20T09:00:00.000Z",
    weights: W,
    weightsHash: weightsHash(W),
    generation: 2,
    learner: true,
    ...over,
  };
}
const withLearner = (ch: Partial<NightChallenger> = {}, t = T) =>
  nightInputs(t, {
    challengers: new Map<Family, NightChallenger>([
      ["F1", { rule: learnRule(), map: learnMap(), ...ch }],
    ]),
  });

const isTagged = (x: { bookId: string }) => x.bookId !== baseBookId(x.bookId);
const familyRows = (out: NightOutput) =>
  nightOutputJson({
    ...out,
    shadow: out.shadow.filter((x) => !isTagged(x)),
    blocked: out.blocked.filter((x) => !isTagged(x)),
  });
const g04 = (x: BlockedDecision) => x.trace.find((e) => e.gateId === "G04_economic");

describe("C.4: the learner challenger runs in the shadow arm only", () => {
  const plain = runNight(nightInputs(T));
  const out = runNight(withLearner());
  const learn = [...out.shadow, ...out.blocked].filter((x) => x.bookId.endsWith(LEARN_SUFFIX));

  it("writes #learn rows for the F1 book, stamped with the learner's rule version", () => {
    expect(learn.length).toBeGreaterThan(0);
    expect(new Set(learn.map((x) => x.bookId))).toEqual(new Set(["E01#learn"]));
    expect(learn.every((x) => x.ruleVersion === "F1.learn" && x.arm === "shadow")).toBe(true);
    expect(out.shadow.filter((x) => x.bookId === "E01#learn")).toHaveLength(1);
  });

  it("never a live decision, queue, abstain or feature from the challenger", () => {
    for (const x of [...out.decisions, ...out.queued]) expect(isTagged(x)).toBe(false);
    for (const a of out.abstains) expect(isTagged(a)).toBe(false);
    expect(nightOutputJson({ features: out.features } as unknown as NightOutput)).toBe(
      nightOutputJson({ features: plain.features } as unknown as NightOutput),
    );
  });

  it("leaves every family-rule row byte-identical (the family rows carry no rule version)", () => {
    expect(familyRows(out)).toBe(nightOutputJson(plain));
    expect(
      [...out.decisions, ...out.shadow.filter((x) => !isTagged(x))].every(
        (x) => x.ruleVersion === undefined,
      ),
    ).toBe(true);
  });

  it("scores with the learner's weights (S of every candidate is the weighted S)", () => {
    expect(learn.some((x) => x.p !== null)).toBe(true); // the learner map passed its guard
    // a band no code reaches: every candidate is recorded blocked at G04 with its S
    const all = runNight(withLearner({ rule: learnRule({ top3MinS: 2 }) })).blocked.filter(
      (x) => x.bookId === "E01#learn",
    );
    expect(all.map((x) => x.code)).toEqual(["ZZA", "ZZB", "ZZC", "ZZD"]);
    let differs = false;
    for (const x of all) {
      const f = out.features.get(x.code)!;
      expect(x.s).toBe(scoreOf(f, SCORED, [...CLUSTERS], 3, W).s);
      if (x.s !== scoreOf(f, SCORED, [...CLUSTERS]).s) differs = true;
    }
    expect(differs).toBe(true);
  });

  it("CTX-026 off for the allowed family, exactly as the shadow arm", () => {
    const sh = out.shadow.find((x) => x.bookId === "E01#learn")!;
    expect(sh.trace.find((x) => x.gateId === "G11_portfolio")).toEqual({
      gateId: "G11_portfolio",
      pass: true,
      value: "shadow:limits_off",
    });
  });

  it("is pure: two runs on the same inputs give the same bytes", () => {
    expect(nightOutputJson(runNight(withLearner()))).toBe(nightOutputJson(out));
  });
});

describe("LRN-AT-6 in the night: only the learner's rows are stopped", () => {
  const plain = runNight(nightInputs(T));

  it("a learner map fitted on another scored set → every #learn row blocked at G04 map_stale", () => {
    const out = runNight(withLearner({ map: learnMap({ activeSetHash: "0".repeat(64) }) }));
    const learn = out.blocked.filter((x) => x.bookId === "E01#learn");
    expect(learn.length).toBeGreaterThan(0);
    expect(learn.every((x) => x.firstFail === "G04_economic" && x.p === null)).toBe(true);
    expect(new Set(learn.map((x) => g04(x)?.value))).toEqual(new Set(["map_stale"]));
    expect(out.shadow.filter((x) => isTagged(x))).toEqual([]);
    expect(familyRows(out)).toBe(nightOutputJson(plain));
  });

  it("a hand-edited weights hash → map_invalid; the fixed rule is unaffected", () => {
    const out = runNight(withLearner({ map: learnMap({ weightsHash: "f".repeat(64) }) }));
    const learn = out.blocked.filter((x) => x.bookId === "E01#learn");
    expect(learn.length).toBeGreaterThan(0);
    expect(new Set(learn.map((x) => g04(x)?.value))).toEqual(new Set(["map_invalid"]));
    expect(familyRows(out)).toBe(nightOutputJson(plain));
  });

  it("weights above the cluster cap → map_invalid (never silently fixed)", () => {
    const big: ScoreWeights = { cluster: { momentum: 3 } };
    const out = runNight(
      withLearner({
        rule: learnRule({ weights: big }),
        map: learnMap({ weights: big, weightsHash: weightsHash(big) }),
      }),
    );
    const learn = out.blocked.filter((x) => x.bookId === "E01#learn");
    expect(new Set(learn.map((x) => g04(x)?.value))).toEqual(new Set(["map_invalid"]));
  });
});

describe("C.5: the leader swap goes through the same code path", () => {
  const plain = runNight(nightInputs(T));
  // the learner leads: it is the family's rule; the fixed rule is the challenger
  const swapped = runNight(
    nightInputs(T, {
      rules: new Map<Family, FamilyNightRule>([...nightInputs(T).rules, ["F1", learnRule()]]),
      maps: new Map<Family, CortexMap>([...nightInputs(T).maps, ["F1", learnMap()]]),
      challengers: new Map<Family, NightChallenger>([
        ["F1", { rule: ruleFor("F1"), map: mapFor("F1") }],
      ]),
    }),
  );
  const strip = (xs: readonly (Decision | BlockedDecision)[]) =>
    nightOutputJson({
      shadow: xs.map((x) => ({ ...x, bookId: baseBookId(x.bookId), ruleVersion: undefined })),
    } as unknown as NightOutput);

  it("the fixed rule's rows carry #fixed and its rule version", () => {
    const fixed = [...swapped.shadow, ...swapped.blocked].filter((x) =>
      x.bookId.endsWith(FIXED_SUFFIX),
    );
    expect(fixed.length).toBeGreaterThan(0);
    expect(fixed.every((x) => x.bookId === "E01#fixed" && x.ruleVersion === "F1.zz.1")).toBe(true);
  });

  it("the #fixed shadow rows are the fixed rule's own shadow rows of a normal night", () => {
    const normal = plain.shadow.filter((x) => x.bookId === "E01");
    const asChallenger = swapped.shadow.filter((x) => x.bookId === "E01#fixed");
    expect(strip(asChallenger)).toBe(strip(normal));
  });

  it("the learner as the family rule takes the live decision, scored with its weights", () => {
    const live = swapped.decisions.filter((x) => x.bookId === "E01");
    expect(live).toHaveLength(1);
    expect(live[0]!.ruleVersion).toBeUndefined(); // the family rule's version comes from the rules map
    const learnerShadow = runNight(withLearner()).shadow.find((x) => x.bookId === "E01#learn")!;
    expect(live[0]!.s).toBe(learnerShadow.s);
  });
});

describe("challenger edges", () => {
  it("a challenger with a tranche cadence decides only on its entry nights", () => {
    const off = runNight(
      withLearner({ rule: learnRule({ entryEvery: 20, entryAnchor: SESSIONS[T - 1]! }) }),
    );
    expect([...off.shadow, ...off.blocked].filter(isTagged)).toEqual([]);
    const on = runNight(
      withLearner({ rule: learnRule({ entryEvery: 20, entryAnchor: SESSIONS[T]! }) }),
    );
    expect([...on.shadow, ...on.blocked].filter(isTagged).length).toBeGreaterThan(0);
  });

  it("a challenger of a family with no governed book writes nothing", () => {
    const out = runNight(
      nightInputs(T, {
        challengers: new Map<Family, NightChallenger>([
          ["F2", { rule: { ...learnRule(), ruleVersion: "F2.learn" }, map: learnMap() }],
        ]),
      }),
    );
    expect(nightOutputJson(out)).toBe(nightOutputJson(runNight(nightInputs(T))));
  });

  it("a challenger with its own angle list scores its own set (an unknown angle blocks at G04)", () => {
    const out = runNight(withLearner({ rule: learnRule({ angles: ["A-D9-99"] }) }));
    const learn = out.blocked.filter((x) => x.bookId === "E01#learn");
    expect(learn.length).toBeGreaterThan(0);
    expect(learn.every((x) => x.firstFail === "G04_economic")).toBe(true);
  });
});

describe("baseBookId", () => {
  it("strips the challenger suffixes and nothing else", () => {
    expect(baseBookId("E01#learn")).toBe("E01");
    expect(baseBookId("E01#fixed")).toBe("E01");
    expect(baseBookId("E01")).toBe("E01");
    expect(baseBookId("E01#other")).toBe("E01#other");
  });
});
