// @vitest-environment node
// C2/C3 selection and entry sizing (M4 T8; ARN-004, decision 33; FAM-001, ARN-024a). Pure functions.
import { describe, expect, it } from "vitest";
import { controlPlan, controlPool, volDeciles } from "@/lib/agents/controls";
import { planLegs, sizeLeg, type Leg, type SizingContext } from "@/lib/agents/candidates";
import { defaultAgentParams } from "@/lib/agents/params";
import { f1Plan, f2Plan, f3Plan, f6Plan } from "@/lib/agents/families/exits";
import type { Candidate, CodeFacts } from "@/lib/agents/families/types";
import { createPrng, deriveRngSeed, resolveCohortParams } from "@/lib/arena/cohort";
import { makeRational } from "@/lib/money/rational";

const p = defaultAgentParams();

describe("volatility deciles and the control pool", () => {
  const vol = new Map(
    Array.from({ length: 20 }, (_, i) => [`C${String(i).padStart(2, "0")}`, i + 1]),
  );

  it("ranks by (vol20, code) and cuts into ten equal parts", () => {
    const dec = volDeciles(vol);
    expect(dec.get("C00")).toBe(0);
    expect(dec.get("C01")).toBe(0);
    expect(dec.get("C02")).toBe(1);
    expect(dec.get("C19")).toBe(9);
    expect([...dec.values()].filter((x) => x === 4)).toHaveLength(2);
  });

  const tierOf = new Map([...vol.keys()].map((c) => [c, "U1"]));
  const base = { tier: "U1", vol20: vol, tierOf, excluded: new Set<string>(), passes: () => true };

  it("is the same-decile codes of the same tier minus the signal, the excluded and the failing ones", () => {
    expect(controlPool({ ...base, code: "C06" })).toEqual(["C07"]);
    expect(controlPool({ ...base, code: "C06", excluded: new Set(["C07"]) })).toEqual([]);
    expect(controlPool({ ...base, code: "C06", passes: (c) => c !== "C07" })).toEqual([]);
    const mixed = new Map(tierOf);
    mixed.set("C07", "U2");
    expect(controlPool({ ...base, code: "C06", tierOf: mixed })).not.toContain("C07"); // another tier
    expect(controlPool({ ...base, code: "NOPE" })).toEqual([]);
  });

  it("a seeded draw is reproducible and differs between cohorts and sessions", () => {
    const draw = (scope: string): number[] => {
      const prng = createPrng(deriveRngSeed(20_261_011n, scope));
      return Array.from({ length: 6 }, () => Number(prng.below(1000n)));
    };
    const a = "c2:C2-F1#01@2030-01-02:2030-05-02";
    expect(draw(a)).toEqual(draw(a));
    expect(draw(a)).not.toEqual(draw("c2:C2-F1#02@2030-01-02:2030-05-02"));
    expect(draw(a)).not.toEqual(draw("c2:C2-F1#01@2030-01-02:2030-05-03"));
  });
});

const facts = (code: string, close: bigint, atr: bigint | null): CodeFacts =>
  ({
    code,
    tier: "U1",
    bar: { d: "2030-05-02", open: close, high: close, low: close, close, volume: 1n },
    halted: false,
    ind: { atrWarm: atr !== null, atrMicro: atr },
  }) as unknown as CodeFacts;

const candidate = (family: Candidate["family"], plan: Candidate["plan"]): Candidate =>
  ({ family, variant: family, ruleVersion: `${family}.v1`, plan }) as unknown as Candidate;

describe("the control's exits are the family's rules mapped (ARN-004, TST101-042)", () => {
  const sig = facts("SIG", 2_000_000n, 50_000n);
  const ctl = facts("CTL", 3_000_000n, 90_000n);

  it("an ATR stop is rebuilt from the control's own ATR; indicator and time rules are unchanged", () => {
    const m = controlPlan({
      family: "F1",
      matched: candidate("F1", f1Plan(p, 50_000n)),
      signalFacts: sig,
      controlFacts: ctl,
    });
    if ("skip" in m) throw new Error(m.skip);
    expect(m.plan.initialStops[0]!.spec).toMatchObject({
      atr_micro: 90_000n,
      k: makeRational(2n),
    });
    expect(m.plan.trails).toEqual(f1Plan(p, 50_000n).trails);
    expect(m.plan.cs.map((r) => r.id)).toEqual(["time_stop", "max_hold"]);
    expect(m.rel).toEqual([]);
  });

  it("an event-anchored level becomes an ATR multiple of the matched signal (F3: close - day-0 low)", () => {
    const m = controlPlan({
      family: "F3",
      matched: candidate("F3", f3Plan(p, 50_000n, 1_900_000n)),
      signalFacts: sig,
      controlFacts: ctl,
    });
    if ("skip" in m) throw new Error(m.skip);
    // (2,000,000 - 1,900,000) / 50,000 = 2 ATR, rebuilt from the control's 90,000
    expect(m.plan.initialStops[0]!.spec).toMatchObject({ k: makeRational(2n), level_micro: null });
  });

  it("an event-dependent CS rule is replaced by the family's time stop; F2's event low goes relative", () => {
    const m = controlPlan({
      family: "F2",
      matched: candidate("F2", f2Plan(p, 50_000n, 1_950_000n)),
      signalFacts: sig,
      controlFacts: ctl,
    });
    if ("skip" in m) throw new Error(m.skip);
    expect(m.plan.cs.map((r) => r.kind)).toEqual(["time_stop"]);
    expect(m.plan.cs[0]).toMatchObject({ sessions: 60 });
    expect(m.rel).toEqual([{ id: "below_event_low", k: makeRational(1n), atrMicro: 90_000n }]);
  });

  it("F6 keeps its own rules only (the contributing families' exits are event-dependent)", () => {
    const m = controlPlan({
      family: "F6",
      matched: candidate("F6", f6Plan(p, 50_000n, [{ family: "F1", plan: f1Plan(p, 50_000n) }])),
      signalFacts: sig,
      controlFacts: ctl,
    });
    if ("skip" in m) throw new Error(m.skip);
    expect(m.plan.initialStops).toHaveLength(1);
    expect(m.plan.trails).toEqual([]);
    expect(m.plan.cs.map((r) => r.id)).toEqual(["time_stop"]);
  });

  it("skips (never invents) when the control has no usable ATR or the level cannot be mapped", () => {
    const f1 = candidate("F1", f1Plan(p, 50_000n));
    expect(
      controlPlan({
        family: "F1",
        matched: f1,
        signalFacts: sig,
        controlFacts: facts("X", 1n, null),
      }),
    ).toEqual({ skip: "no_atr" });
    const f3 = candidate("F3", f3Plan(p, 50_000n, 1_900_000n));
    expect(
      controlPlan({
        family: "F3",
        matched: f3,
        signalFacts: facts("S", 2_000_000n, null),
        controlFacts: ctl,
      }),
    ).toEqual({ skip: "unmappable" });
  });
});

describe("FAM-001 legs through the M3 sizing engine", () => {
  const params = resolveCohortParams({});
  const ctx = (cashMicro: bigint, navMicro = cashMicro): SizingContext => ({
    params,
    cashMicro,
    navMicro,
    sleeveReserveMicro: 0n,
  });
  const leg = (key: string, price: bigint, halfSize = false): Leg => ({
    key,
    halfSize,
    sleeve: false,
    env: {
      code: key,
      tier: "U1",
      refPriceMicro: price,
      advValueMicro: 5_000_000_000_000n,
      adv20Shares: 10_000_000n,
    },
  });

  it("one slot or one candidate: the top-ranked at full size", () => {
    const r = planLegs(ctx(600_000_000n), [leg("A", 2_000_000n), leg("B", 2_000_000n)], 1);
    expect(r.map((x) => x.leg.key)).toEqual(["A"]);
    expect(r[0]!.sizing.accepted).toBe(true);
  });

  it("two slots, two candidates, A$600: each half is below the A$500 parcel, so only the top is bought", () => {
    const r = planLegs(ctx(600_000_000n), [leg("A", 2_000_000n), leg("B", 2_000_000n)], 2);
    expect(r.map((x) => x.leg.key)).toEqual(["A"]);
    expect(r[0]!.sizing.orderValueMicro).toBeGreaterThanOrEqual(500_000_000n);
  });

  it("two slots, two candidates, enough cash: both legs at half the cash each", () => {
    const r = planLegs(ctx(5_000_000_000n), [leg("A", 2_000_000n), leg("B", 3_000_000n)], 2);
    expect(r.map((x) => x.leg.key)).toEqual(["A", "B"]);
    expect(r.every((x) => x.sizing.accepted)).toBe(true);
    for (const x of r) expect(x.sizing.orderValueMicro).toBeLessThanOrEqual(2_500_000_000n);
  });

  it("half size (F4 in SHOCK) must still meet the parcel, else a rejection with its reasons", () => {
    const ok = sizeLeg(ctx(1_200_000_000n), leg("A", 2_000_000n, true), 1);
    expect(ok.accepted).toBe(true);
    expect(ok.orderValueMicro).toBeLessThanOrEqual(600_000_000n);
    const no = sizeLeg(ctx(600_000_000n), leg("A", 2_000_000n, true), 1);
    expect(no.accepted).toBe(false);
    expect(no.reasons).toContain("parcel");
  });

  it("no candidates or no slot: nothing", () => {
    expect(planLegs(ctx(600_000_000n), [], 2)).toEqual([]);
    expect(planLegs(ctx(600_000_000n), [leg("A", 2_000_000n)], 0)).toEqual([]);
  });
});
