// @vitest-environment node
// `fill.rule` of a limit-order entry (M15 C3a; D-307: trade-through → `level` with limit_micro set).
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import { type Bar, type FillEnv, fillEntryLimit } from "@/lib/arena/fills";
import { FILL_RULES } from "@/lib/arena/schema";
import { fillRowRule } from "@/lib/cortex/economics/fillRow";

const LIMIT = 10_800_000n;
const bar = (open: bigint, low: bigint): Bar => ({
  openMicro: open,
  highMicro: 11_000_000n,
  lowMicro: low,
  closeMicro: open,
});
const env = (b: Bar): FillEnv => ({
  bar: b,
  advMicro: 5_000_000_000_000n,
  profile: COST_PROFILES.P5,
});

describe("fillRowRule", () => {
  it("a trade-through at the limit is written as `level`", () => {
    const out = fillEntryLimit(env(bar(10_900_000n, 10_700_000n)), 1n, LIMIT);
    expect(out.status === "filled" && out.fill.rule).toBe("limit");
    expect(fillRowRule(out)).toBe("level");
    if (out.status === "filled") expect(fillRowRule(out.fill)).toBe("level");
  });

  it("an open fill, capped at the limit or not, stays `open`", () => {
    expect(fillRowRule(fillEntryLimit(env(bar(10_000_000n, 9_900_000n)), 1n, LIMIT))).toBe("open");
    expect(fillRowRule(fillEntryLimit(env(bar(10_790_000n, 10_700_000n)), 1n, LIMIT))).toBe("open");
  });

  it("an unfilled order writes no row; a non-entry rule is refused; both values pass the 0007 CHECK", () => {
    expect(() =>
      fillRowRule(fillEntryLimit(env(bar(10_900_000n, 10_850_000n)), 1n, LIMIT)),
    ).toThrow(RangeError);
    const out = fillEntryLimit(env(bar(10_000_000n, 9_900_000n)), 1n, LIMIT);
    if (out.status !== "filled") throw new Error("expected a fill");
    expect(() => fillRowRule({ ...out.fill, rule: "close_signal" })).toThrow(RangeError);
    expect(FILL_RULES).toContain("open");
    expect(FILL_RULES).toContain("level");
  });
});
