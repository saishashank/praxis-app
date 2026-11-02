// @vitest-environment node
// VAL-112 k from one function (M14 review fix 4, D-283).
import { describe, expect, it } from "vitest";
import { spentTestsBefore, type TrialKind } from "../../src/lib/stats/splits";

const row = (id: string, d: string, kind: TrialKind, split = 1, lineage = "ASX:F1") => ({
  id,
  d,
  kind,
  split_version: split,
  lineage_id: lineage,
});
const L = [
  row("a", "2030-01-01", "validation_access"),
  row("b", "2030-01-02", "pattern_test"),
  row("c", "2030-01-02", "pattern_test"),
  row("d", "2030-01-03", "holdout_access"),
  row("e", "2030-01-04", "challenger"),
  row("f", "2030-01-05", "validation_access", 2),
  row("g", "2030-01-05", "validation_access", 1, "ASX:F2"),
];

describe("spentTestsBefore", () => {
  it("counts validation and pattern tests of the lineage and split version only", () => {
    expect(spentTestsBefore(L, "ASX:F1", 1)).toBe(3);
    expect(spentTestsBefore(L, "ASX:F1", 2)).toBe(1);
  });
  it("with an access, only those strictly before it in (d, id) order", () => {
    expect(spentTestsBefore(L, "ASX:F1", 1, { d: "2030-01-02", id: "b" })).toBe(1);
    expect(spentTestsBefore(L, "ASX:F1", 1, { d: "2030-01-02", id: "c" })).toBe(2);
    expect(spentTestsBefore(L, "ASX:F1", 1, { d: "2030-01-01", id: "a" })).toBe(0);
  });
});
