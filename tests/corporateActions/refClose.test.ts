// @vitest-environment node
// M14 fix B10: the reference close of a price factor is parsed from its decimal text, not by float
// multiplication (DAT-233). Synthetic numbers.
import { describe, expect, it } from "vitest";
import { microOfDollars } from "@/lib/data/corporateActions/engine.mjs";
import { isQuantityType } from "@/lib/data/corporateActions/rules.mjs";

describe("microOfDollars", () => {
  it("reads shortest decimal text exactly", () => {
    expect(microOfDollars(0.285)).toBe(285_000);
    expect(microOfDollars(10)).toBe(10_000_000);
    expect(microOfDollars("1.005")).toBe(1_005_000);
    expect(microOfDollars(0.000001)).toBe(1);
    expect(microOfDollars(123456.789012)).toBe(123_456_789_012);
  });

  it("rounds a seventh decimal half away from zero once, on the digits ", () => {
    expect(microOfDollars(1.0000005)).toBe(1_000_001);
    expect(microOfDollars(2.4999994)).toBe(2_499_999);
  });

  it("is null for a value that is not a finite number", () => {
    expect(microOfDollars(Number.NaN)).toBeNull();
    expect(microOfDollars("x")).toBeNull();
  });
});

describe("isQuantityType", () => {
  it("is true for the quantity-changing actions", () => {
    expect(["split", "consolidation", "bonus_issue"].every(isQuantityType)).toBe(true);
    expect(isQuantityType("dividend")).toBe(false);
  });
});
