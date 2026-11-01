// @vitest-environment node
// fitCheck and parkReason (D-514, D-515): hand cases over the family registry.
import { describe, expect, it } from "vitest";
import { FAMILY_PARAM_KEYS, paramBounds } from "@/lib/agents/families/ruleSchema";
import { FAMILIES } from "@/lib/agents/schema";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { fitCheck, parkReason } from "@/lib/experts/fit";

type Def = { default: unknown };
const defaults = (f: (typeof FAMILIES)[number]): Record<string, unknown> =>
  Object.fromEntries(
    FAMILY_PARAM_KEYS[f].map((k) => [
      k,
      (CONFIG_KEYS as unknown as Record<string, Def>)[k]!.default,
    ]),
  );

describe("fitCheck", () => {
  it("accepts the default parameter set of every family F1..F6", () => {
    for (const f of FAMILIES) {
      expect(fitCheck({ family: f, params: defaults(f) }).ok).toBe(true);
    }
  });

  it("accepts a good F1 set with an allowed structural switch", () => {
    const r = fitCheck({
      family: "F1",
      params: { ...defaults("F1"), f1_return_window_sessions: 200 },
    });
    expect(r).toMatchObject({ ok: true, family: "F1" });
  });

  it("refuses a missing key", () => {
    const p = defaults("F1");
    delete p.f1_trail_atr;
    expect(fitCheck({ family: "F1", params: p })).toMatchObject({ ok: false, reason: "key_set" });
  });

  it("refuses an unknown key and a key set of another family", () => {
    expect(fitCheck({ family: "F1", params: { ...defaults("F1"), zz_extra: 1 } })).toMatchObject({
      ok: false,
      reason: "key_set",
    });
    expect(fitCheck({ family: "F2", params: defaults("F1") })).toMatchObject({
      ok: false,
      reason: "key_set",
    });
  });

  it("refuses a value out of bounds, non-finite or not a number", () => {
    const hi = paramBounds("f1_trail_atr")![1];
    for (const v of [hi + 1, Number.NaN, "3" as unknown as number]) {
      expect(
        fitCheck({ family: "F1", params: { ...defaults("F1"), f1_trail_atr: v } }),
      ).toMatchObject({ ok: false, reason: "bounds" });
    }
  });

  it("refuses a bad structural switch", () => {
    expect(
      fitCheck({ family: "F1", params: { ...defaults("F1"), f1_momentum_variant: "no_such" } }),
    ).toMatchObject({ ok: false, reason: "bounds" });
  });

  it("refuses F7 and other unknown families", () => {
    expect(fitCheck({ family: "F7", params: {} })).toMatchObject({
      ok: false,
      reason: "unknown_family",
    });
    expect(fitCheck({ family: 3, params: {} })).toMatchObject({
      ok: false,
      reason: "unknown_family",
    });
  });

  it("refuses shapes that are not { family, params }", () => {
    for (const v of [
      null,
      undefined,
      5,
      "x",
      [],
      {},
      { family: "F1" },
      { family: "F1", params: [] },
    ]) {
      expect(fitCheck(v)).toMatchObject({ ok: false, reason: "invalid_fit" });
    }
  });
});

describe("parkReason", () => {
  const base = {
    testability: "testable_eod",
    closestFamily: null,
    vocabularyGaps: 0,
    familyFit: null,
  } as const;
  it("is null for a valid fit and invalid_fit for a wrong one", () => {
    expect(parkReason({ ...base, familyFit: { family: "F2", params: defaults("F2") } })).toBeNull();
    expect(parkReason({ ...base, familyFit: { family: "F2", params: {} } })).toBe("invalid_fit");
  });
  it("orders reasons: testability first, then fit, overlay, new, gap, default", () => {
    expect(parkReason({ ...base, testability: "not_testable" })).toBe("not_testable");
    expect(parkReason({ ...base, testability: "needs_new_data" })).toBe("needs_new_data");
    expect(parkReason({ ...base, testability: "needs_intraday" })).toBe("needs_new_data");
    expect(parkReason({ ...base, closestFamily: "overlay" })).toBe("overlay_only");
    expect(parkReason({ ...base, closestFamily: "new", vocabularyGaps: 2 })).toBe(
      "needs_new_lineage",
    );
    expect(parkReason({ ...base, closestFamily: "F1", vocabularyGaps: 2 })).toBe("vocabulary_gap");
    expect(parkReason({ ...base, closestFamily: "F1" })).toBe("needs_new_lineage");
  });
});

describe("F6 insider weights (D-550)", () => {
  it("accepts the default object and refuses a bad one", () => {
    const p = defaults("F6") as Record<string, unknown>;
    expect(p.insider_score_weights).toBeDefined();
    const bad = (w: unknown) =>
      fitCheck({ family: "F6", params: { ...p, insider_score_weights: w } });
    expect(bad({ director_net: 0.5, holder_new_or_increase: 0.25, holder_decrease: 0.25 }).ok).toBe(
      true,
    );
    expect(bad({ director_net: 0.5 })).toMatchObject({ ok: false, reason: "bounds" });
    expect(
      bad({ director_net: 2, holder_new_or_increase: 0.25, holder_decrease: 0.25 }),
    ).toMatchObject({ ok: false });
    expect(
      bad({ director_net: 0.5, holder_new_or_increase: 0.25, holder_decrease: 0.25, zz: 1 }),
    ).toMatchObject({ ok: false });
    expect(bad(3)).toMatchObject({ ok: false, reason: "bounds" });
  });
});
