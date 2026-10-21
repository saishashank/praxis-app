// @vitest-environment node
// Cost-feasibility flag (M4 T13; ARN-094; decision 29).
import { describe, expect, it } from "vitest";
import { makeRational, parseRational, type Rational } from "../../src/lib/money/rational";
import { costFeasibility, medianRational } from "../../src/lib/stats/feasibility";
import { PARAMS } from "../fixtures/stats/t13";

const NOTIONAL = 600_000_000n; // A$600 in micro
const BROKERAGE = 10_000_000n; // 2 x A$5 (P5 brokerage each side)

const rows = (gross: string, bps: string, n = 5) =>
  Array.from({ length: n }, () => ({
    gross: parseRational(gross),
    slippageBps: parseRational(bps),
  }));
const run = (r: ReturnType<typeof rows>) =>
  costFeasibility({
    rows: r,
    notionalMicro: NOTIONAL,
    roundTripBrokerageMicro: BROKERAGE,
    params: PARAMS,
  });

describe("round-trip cost and the 2x bar (ARN-094, decision 29)", () => {
  it("cost = brokerage + 2 x median slippage x notional; bar = ratio x cost", () => {
    const r = run(rows("0.04", "10"));
    // 10 bps = 0.001 x A$600 = A$0.60 a side -> A$10 + A$1.20 = A$11.20.
    expect(r.roundTripCostMicro).toEqual(makeRational(11_200_000n));
    expect(r.requiredMicro).toEqual(makeRational(22_400_000n)); // ratio 2
    expect(r.medianSlippageBps).toEqual(makeRational(10n));
  });
  it("flags when gross mean x A$600 is below 2 x cost; clears above", () => {
    // Bar = A$22.40 -> 3.7333...% of A$600.
    expect(run(rows("0.03", "10")).costInfeasible).toBe(true);
    expect(run(rows("0.04", "10")).costInfeasible).toBe(false);
    expect(run(rows("0.04", "10")).grossPerTradeMicro).toEqual(makeRational(24_000_000n));
  });
  it("exactly at the bar is not infeasible (strictly below only)", () => {
    // gross 22.4 / 600 = 14/375
    const exact = costFeasibility({
      rows: [{ gross: makeRational(14n, 375n), slippageBps: makeRational(10n) }],
      notionalMicro: NOTIONAL,
      roundTripBrokerageMicro: BROKERAGE,
      params: PARAMS,
    });
    expect(exact.grossPerTradeMicro).toEqual(exact.requiredMicro);
    expect(exact.costInfeasible).toBe(false);
  });
  it("brokerage alone (decision 29 option B) would not flag a 3 % edge, slippage does", () => {
    // Brokerage-only bar: 2 x A$10 = A$20 -> 3.33 % of A$600; 3.5 % clears it but not the slippage-aware bar.
    const r = run(rows("0.035", "10"));
    expect(r.costInfeasible).toBe(true);
    const noSlip = run(rows("0.035", "0"));
    expect(noSlip.costInfeasible).toBe(false);
  });
  it("uses the gross mean over rows, not the median", () => {
    const mixed = [
      ...rows("0.00", "10", 4),
      { gross: parseRational("0.20"), slippageBps: parseRational("10") },
    ];
    const r = run(mixed);
    expect(r.grossMean).toEqual(makeRational(1n, 25n)); // 0.04
    expect(r.costInfeasible).toBe(false);
  });
  it("a negative gross mean is infeasible", () => {
    expect(run(rows("-0.01", "5")).costInfeasible).toBe(true);
  });
  it("no development rows: not evaluable and not flagged (it cannot block)", () => {
    const r = run([]);
    expect(r).toMatchObject({ evaluable: false, costInfeasible: false, n: 0, grossMean: null });
  });
  it("the ratio comes from the parameter", () => {
    const strict = { ...PARAMS, costFeasibilityRatio: makeRational(3n) };
    const r = costFeasibility({
      rows: rows("0.04", "10"),
      notionalMicro: NOTIONAL,
      roundTripBrokerageMicro: BROKERAGE,
      params: strict,
    });
    expect(r.costInfeasible).toBe(true); // 24.0 < 3 x 11.2 = 33.6
  });
  it("is deterministic", () => {
    const j = (x: unknown) =>
      JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(j(run(rows("0.03", "10")))).toBe(j(run(rows("0.03", "10"))));
  });
});

describe("medianRational", () => {
  const r = (n: bigint): Rational => makeRational(n);
  it("odd, even and empty", () => {
    expect(medianRational([r(3n), r(1n), r(2n)])).toEqual(r(2n));
    expect(medianRational([r(4n), r(1n), r(2n), r(3n)])).toEqual(makeRational(5n, 2n));
    expect(medianRational([])).toBeNull();
  });
});
