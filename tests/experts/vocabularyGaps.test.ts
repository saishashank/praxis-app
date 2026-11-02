// @vitest-environment node
import { describe, expect, it } from "vitest";
import { gapReport, gapSentence, normaliseGap } from "@/lib/experts/vocabularyGaps";

const g = (
  claimId: string,
  expertIds: string[],
  text: string | null,
  clusterIds: string[] = [],
) => ({ claimId, expertIds, clusterIds, vocabularyGapText: text });

describe("vocabulary gaps", () => {
  it("normalises to the first phrase, lower case", () => {
    expect(normaliseGap("  Order  Flow imbalance (needs L2 data), more")).toBe(
      "order flow imbalance",
    );
    expect(normaliseGap("Fibonacci retracement. Levels vary")).toBe("fibonacci retracement");
  });

  it("groups by token and counts distinct experts and claims", () => {
    const rows = gapReport([
      g("c1", ["X-1", "X-2"], "Order flow (L2)", ["K-1"]),
      g("c2", ["X-2"], "order flow, tape", ["K-2"]),
      g("c3", ["X-3"], "Gann angles", ["K-1"]),
      g("c4", ["X-4"], null),
      g("c5", ["X-5"], "none"),
      g("c6", ["X-6"], "  "),
    ]);
    expect(rows).toEqual([
      { input: "order flow", experts: 2, claims: 2, clusters: ["K-1", "K-2"] },
      { input: "gann angles", experts: 1, claims: 1, clusters: ["K-1"] },
    ]);
  });

  it("words the line as the spec does", () => {
    expect(gapSentence({ input: "order flow", experts: 3, claims: 4, clusters: [] })).toBe(
      "3 experts rely on order flow (not in Praxis)",
    );
    expect(gapSentence({ input: "gann angles", experts: 1, claims: 1, clusters: [] })).toBe(
      "1 expert relies on gann angles (not in Praxis)",
    );
  });
});
