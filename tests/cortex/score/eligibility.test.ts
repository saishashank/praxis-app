// @vitest-environment node
// Eligibility (M15 C3a; CTX-012 "any undefined angle → ineligible, shown as warming up"; CTX-055).
import { describe, expect, it } from "vitest";
import { eligibility, WARMING_UP_LABEL } from "@/lib/cortex/score/eligibility";
import type { AngleValue, ScoredAngle } from "@/lib/cortex/score/types";

const scored: readonly ScoredAngle[] = [
  { id: "A-D1-01", version: 1, cluster: "momentum" },
  { id: "A-D1-02", version: 1, cluster: "momentum" },
  { id: "A-D2-01", version: 1, cluster: "liquidity" },
];
const feats = (entries: [string, AngleValue][]) => new Map<string, AngleValue>(entries);

describe("eligibility", () => {
  it("every scored angle defined → eligible; flags and buckets count as defined", () => {
    const f = feats([
      ["A-D1-01", 0.5],
      ["A-D1-02", { flag: "at_high" }],
      ["A-D2-01", { bucket: "U2" }],
    ]);
    expect(eligibility(f, scored)).toEqual({ eligible: true });
  });

  it("one undefined angle → ineligible with the warming-up label and the missing ids sorted", () => {
    const f = feats([
      ["A-D2-01", 0.1],
      ["A-D1-01", undefined],
    ]);
    const e = eligibility(f, scored);
    expect(e.eligible).toBe(false);
    if (e.eligible) return;
    expect(e.reason).toBe("warming_up");
    expect(e.missing).toEqual(["A-D1-01", "A-D1-02"]);
    expect(e.label).toBe(WARMING_UP_LABEL);
    expect(e.label).toContain("warming up");
  });

  it("angles outside the scored set do not matter; an empty scored set is eligible", () => {
    expect(eligibility(feats([["A-D9-01", undefined]]), [])).toEqual({ eligible: true });
    expect(
      eligibility(
        feats([
          ["A-D1-01", 0],
          ["A-D1-02", 0],
          ["A-D2-01", 0],
          ["A-D9-01", undefined],
        ]),
        scored,
      ),
    ).toEqual({ eligible: true });
  });
});
