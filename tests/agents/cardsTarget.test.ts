// @vitest-environment node
// M21 C2 (D-1225): the card's exit plan shows the real FAM-010 target at the card's reference close, from the
// tightest initial stop, on the market's tick grid (rounded up). No target rule = the v1 plan, byte for byte.
import { describe, expect, it } from "vitest";
import { buildExitPlan } from "@/lib/agents/cards";
import type { CsRule, ExitPlan, InitialStopRule } from "@/lib/agents/families/types";
import { makeRational, parseRational } from "@/lib/money/rational";
import type { TickBand } from "@/lib/money/tick";

const CLOSE = 10_000_000n; // 10.00
// a 20 % cap: the stop at the reference close is 8.00, so the initial risk is 2.00
const CAP: InitialStopRule = {
  id: "IS-cap",
  via: null,
  spec: { atr_micro: null, k: null, cap: makeRational(1n, 5n), level_micro: null },
};
// a tighter stop from a level at 9.00 (risk 1.00): the tightest stop is the highest one
const LEVEL: InitialStopRule = {
  id: "IS-level",
  via: null,
  spec: { atr_micro: null, k: null, cap: null, level_micro: 9_000_000n },
};
const target = (r: string | null, pct: string | null): CsRule => ({
  id: "target",
  via: null,
  kind: "target",
  targetR: r === null ? null : parseRational(r),
  targetPct: pct === null ? null : parseRational(pct),
});
const plan = (stops: InitialStopRule[], cs: CsRule[]): ExitPlan => ({
  initialStops: stops,
  trails: [],
  cs,
});
const tens: readonly TickBand[] = [{ fromMicro: 0n, tickMicro: 100_000n }]; // a 0.10 grid
const targetRow = (p: ExitPlan, ticks?: readonly TickBand[]) =>
  buildExitPlan(p, CLOSE, ticks).find((e) => e.kind === "target")!;

describe("buildExitPlan: the target rule", () => {
  it("an R target is the close plus R times the risk from the tightest stop", () => {
    // stop 8.00 -> risk 2.00 -> 1.5 R = 3.00 -> 13.00
    expect(targetRow(plan([CAP], [target("1.5", null)]), tens).detail).toMatchObject({
      target_at_close_micro: "13000000",
    });
    // the tighter level stop (9.00) wins: risk 1.00 -> 1.5 R = 1.50 -> 11.50
    expect(targetRow(plan([CAP, LEVEL], [target("1.5", null)]), tens).detail).toMatchObject({
      target_at_close_micro: "11500000",
    });
  });

  it("a percentage target is the close plus the percentage, rounded UP to the tick grid", () => {
    // 12.34 % of 10.00 = 11.234 -> up to 11.30 on a 0.10 grid
    const row = targetRow(plan([CAP], [target(null, "12.34%")]), tens);
    expect(row.detail).toMatchObject({ target_at_close_micro: "11300000" });
    expect(row).toMatchObject({ tag: "CS", kind: "target", rule: "target" });
  });

  it("the default grid is the home market's (a price on it is unchanged)", () => {
    expect(targetRow(plan([CAP], [target(null, "10%")])).detail).toMatchObject({
      target_at_close_micro: "11000000",
    });
  });

  it("an R target with no usable stop shows no price (null), not a wrong one", () => {
    const row = targetRow(plan([], [target("2", null)]), tens);
    expect(row.detail).toMatchObject({ target_at_close_micro: null });
  });

  it("a plan with no target rule carries no target price (the v1 plan)", () => {
    const rows = buildExitPlan(plan([CAP], []), CLOSE);
    expect(rows.every((r) => !("target_at_close_micro" in r.detail))).toBe(true);
    expect(rows.map((r) => r.kind)).toEqual(["initial_stop"]);
  });
});
