// @vitest-environment node
// M5 T6 (AGT-115, EML-020, UXN-251; D-101): alert tier assignment, alert keys, the exact weight
// comparison and the regime transition rule. Pure functions, no database.
import { describe, expect, it } from "vitest";
import {
  alertKeyKind,
  alertKeys,
  heaviest,
  meetsWeight,
  neverSuppressed,
  regimeTransition,
  thresholdPpm,
  tierForAnnouncement,
  weightPpm,
  type Holder,
  type TierInput,
} from "@/lib/alerts/tiers";

const THR = thresholdPpm(0.1);
const h = (id: string, value: number, nav: number): Holder => ({
  executionId: id,
  label: "F1 U",
  valueMicro: BigInt(value),
  navMicro: BigInt(nav),
});
const base: TierInput = {
  kind: "announcement",
  category: "other",
  materiality: 3,
  held: true,
  watch: false,
  holders: [h("E01", 100, 1000)], // exactly 10 %
  thresholdPpm: THR,
};
const tier = (o: Partial<TierInput>) => tierForAnnouncement({ ...base, ...o })?.tier ?? null;

describe("weight (exact rational, never a float)", () => {
  it("meets the threshold at exactly 10 % and not at 9.9999 %", () => {
    expect(meetsWeight(h("E", 100, 1000), THR)).toBe(true);
    expect(meetsWeight(h("E", 99_999, 1_000_000), THR)).toBe(false);
    expect(meetsWeight(h("E", 1, 0), THR)).toBe(false); // no NAV: never met
  });
  it("floors the display figure and picks the heaviest holder", () => {
    expect(weightPpm(h("E", 1, 3))).toBe(333_333);
    expect(weightPpm(h("E", 0, 5))).toBe(0);
    expect(heaviest([h("A", 1, 10), h("B", 3, 10), h("C", 2, 10)])?.executionId).toBe("B");
    expect(heaviest([])).toBeNull();
  });
  it("converts alert_p0_weight to ppm", () => {
    expect(thresholdPpm(0.1)).toBe(100_000);
    expect(thresholdPpm(0.07)).toBe(70_000);
  });
});

describe("tier assignment (design 2.2)", () => {
  it("P0: held, weight >= 10 % of NAV and materiality 3", () => {
    expect(tier({})).toBe("P0");
  });
  it("P0: a halt or suspension of a held code at any weight", () => {
    const d = tierForAnnouncement({
      ...base,
      category: "halt_suspension",
      materiality: 3,
      holders: [h("E01", 1, 1000)],
    });
    expect(d).toMatchObject({ tier: "P0", kind: "halt", rule: "p0:held_halt" });
    expect(tier({ category: "halt_suspension", holders: [] })).toBe("P0");
  });
  it("the highest tier across executions wins and the heaviest is shown", () => {
    const d = tierForAnnouncement({
      ...base,
      holders: [h("E01", 10, 1000), h("E02", 150, 1000), h("E03", 90, 1000)],
    });
    expect(d).toMatchObject({ tier: "P0", weightPpm: 150_000 });
    expect(d?.holder?.executionId).toBe("E02");
  });
  it("P1: held below the weight with materiality >= 2", () => {
    expect(tier({ holders: [h("E01", 99, 1000)] })).toBe("P1");
    expect(tier({ holders: [h("E01", 500, 1000)], materiality: 2 })).toBe("P1");
  });
  it("P1: watch-list with materiality 3, not held", () => {
    expect(tier({ held: false, watch: true, holders: [] })).toBe("P1");
  });
  it("P2: everything else with materiality >= 1; held materiality 1 is P2", () => {
    expect(tier({ held: false, watch: true, materiality: 2, holders: [] })).toBe("P2");
    expect(tier({ held: false, materiality: 1, holders: [] })).toBe("P2");
    expect(tier({ materiality: 1 })).toBe("P2");
  });
  it("materiality 0 raises no alert (unless it is a held halt)", () => {
    expect(tier({ materiality: 0, held: false, holders: [] })).toBeNull();
    expect(tier({ materiality: 0, held: false, watch: true, holders: [] })).toBeNull();
  });
  it("a held code without a NAV snapshot yet is below the weight, not P0 (unless halted)", () => {
    expect(tier({ holders: [h("E01", 0, 0)] })).toBe("P1");
  });
});

describe("alert keys", () => {
  it("builds the five documented shapes and recognises them", () => {
    expect(alertKeys.announcement("AU", "asx_announcements", "ab12")).toBe(
      "ann:AU:asx_announcements:ab12",
    );
    expect(alertKeys.thesisBreaker("T1", "TB-NEG", "2026-10-19")).toBe("tb:T1:TB-NEG:2026-10-19");
    expect(alertKeys.regime("AU", "2026-10-19")).toBe("regime:AU:2026-10-19");
    expect(alertKeys.preopen("AU", "2026-10-19")).toBe("preopen:AU:2026-10-19");
    expect(alertKeys.proxy("AU", "ZZAA", "2026-10-19")).toBe("proxy:AU:ZZAA:2026-10-19");
    expect(alertKeyKind("ann:AU:asx_announcements:ab12")).toBe("announcement");
    expect(alertKeyKind("tb:T1:TB-NEG:2026-10-19")).toBe("thesis_breaker");
    expect(alertKeyKind("regime:AU:2026-10-19")).toBe("regime_shift");
    expect(alertKeyKind("preopen:AU:2026-10-19")).toBe("preopen_failure");
    expect(alertKeyKind("proxy:AU:ZZAA:2026-10-19")).toBe("halt_proxy");
  });
  it("refuses anything else", () => {
    for (const bad of ["", "p0:x", "regime:AU:2026-10", "ann:AU:asx", "x y", "ann:AU:a b:c"]) {
      expect(alertKeyKind(bad), bad).toBeNull();
    }
  });
  it("is deterministic: the same inputs give the same key", () => {
    expect(alertKeys.announcement("AU", "s", "1")).toBe(alertKeys.announcement("AU", "s", "1"));
  });
});

describe("regime transition (UXN-251)", () => {
  it("a change between two known states is a transition", () => {
    expect(regimeTransition("RISK-ON", "RISK-OFF")).toEqual({ from: "RISK-ON", to: "RISK-OFF" });
    expect(regimeTransition("NEUTRAL", "SHOCK")).toEqual({ from: "NEUTRAL", to: "SHOCK" });
  });
  it("no change, an unknown (warm-up) side or missing data is not", () => {
    expect(regimeTransition("NEUTRAL", "NEUTRAL")).toBeNull();
    expect(regimeTransition("unknown", "NEUTRAL")).toBeNull();
    expect(regimeTransition("NEUTRAL", "unknown")).toBeNull();
    expect(regimeTransition(null, "NEUTRAL")).toBeNull();
    expect(regimeTransition("NEUTRAL", "bogus")).toBeNull();
  });
});

describe("never suppressed (UXN-160)", () => {
  it("P0 and the regime P1 only", () => {
    expect(neverSuppressed("P0", "announcement")).toBe(true);
    expect(neverSuppressed("P1", "regime_shift")).toBe(true);
    expect(neverSuppressed("P1", "announcement")).toBe(false);
    expect(neverSuppressed("P2", "announcement")).toBe(false);
  });
});
