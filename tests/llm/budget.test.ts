// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { allowance, estimateTokens, fits, scaledCap } from "@/lib/llm/budget";
import { makeRational } from "@/lib/money/rational";

const p = defaultAgentParams().llm;
const zero = { roleDay: 0, totalDay: 0, marketNight: 0 };

describe("budget accounting (LLM-050, stricter cap wins)", () => {
  it("uses the role cap when it is the tighter one", () => {
    const a = allowance(p, "R5", "AU", false, zero);
    expect(a).toEqual({ allowed: p.roleDailyTokens.R5, binding: "role" });
  });

  it("uses the total cap when it is tighter than the role cap", () => {
    const a = allowance(p, "R1", "AU", false, { ...zero, totalDay: p.dailyTotal - 100 });
    expect(a).toEqual({ allowed: 100, binding: "total" });
  });

  it("nightly cap wins when stricter than the role cap", () => {
    const night = p.nightlyTokensPerMarket - 50;
    const a = allowance(p, "R1", "AU", true, { ...zero, marketNight: night });
    expect(a).toEqual({ allowed: 50, binding: "nightly" });
    // Not a nightly call: the nightly cap does not apply.
    const full = { ...zero, marketNight: p.nightlyTokensPerMarket };
    expect(allowance(p, "R1", "AU", false, full).binding).toBe("role");
  });

  it("scales by the market share exactly and denies unknown markets", () => {
    const half = { ...p, marketShare: { AU: makeRational(1n, 2n) } };
    expect(allowance(half, "R2", "AU", false, zero).allowed).toBe(p.roleDailyTokens.R2 / 2);
    expect(allowance(half, "R2", "US", false, zero).allowed).toBe(0);
    expect(scaledCap(10, makeRational(1n, 3n))).toBe(3);
  });

  it("never goes negative and fits() compares the projection", () => {
    const a = allowance(p, "R2", "AU", false, { ...zero, roleDay: p.roleDailyTokens.R2 + 5 });
    expect(a.allowed).toBe(0);
    expect(fits({ allowed: 10, binding: "role" }, 10)).toBe(true);
    expect(fits({ allowed: 10, binding: "role" }, 11)).toBe(false);
    expect(estimateTokens("abcdefghi")).toBe(3);
  });
});
