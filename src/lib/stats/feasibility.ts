// Cost feasibility flag (M4 design 4.10; ARN-094; decision 29). Exact rational arithmetic.
//
// Round-trip cost of a fixed-notional trade = 2 x P5 brokerage at the notional (the caller supplies the
// round-trip brokerage in micro, e.g. from replay/returns.ts roundTripBrokerage) + 2 x the median
// modelled one-side slippage (bps) of the family's development rows x the notional.
// Flag when development gross mean per-trade return x notional < cost_feasibility_ratio x cost.
// It is a flag shown beside the label, not a label; it blocks PASSED-BACKTEST through VAL-110 (iv-b).
import type { StatsParams } from "../agents/params";
import { addRat, cmpRat, divRat, makeRational, mulRat, type Rational } from "../money/rational";

export type FeasibilityRow = {
  /** Gross return (before brokerage and slippage) as an exact fraction. */
  readonly gross: Rational;
  /** Modelled one-side slippage in basis points (exact). */
  readonly slippageBps: Rational;
};

export type FeasibilityInput = {
  readonly rows: readonly FeasibilityRow[];
  readonly notionalMicro: bigint;
  /** 2 x P5 brokerage at the notional, micro. */
  readonly roundTripBrokerageMicro: bigint;
  readonly params: StatsParams;
};

export type FeasibilityResult = {
  /** False when there are no development rows to judge. */
  readonly evaluable: boolean;
  readonly costInfeasible: boolean;
  readonly n: number;
  readonly grossMean: Rational | null;
  /** Gross mean x notional, micro. */
  readonly grossPerTradeMicro: Rational | null;
  readonly medianSlippageBps: Rational | null;
  /** Round-trip cost, micro. */
  readonly roundTripCostMicro: Rational;
  /** ratio x cost, micro: the bar the gross per-trade return must reach. */
  readonly requiredMicro: Rational;
};

const BPS_DEN = 10_000n;

/** Median of exact rationals (mean of the two middle values for an even count). */
export function medianRational(values: readonly Rational[]): Rational | null {
  if (values.length === 0) return null;
  const s = [...values].sort(cmpRat);
  const mid = s.length >> 1;
  if (s.length % 2 === 1) return s[mid]!;
  return mulRat(addRat(s[mid - 1]!, s[mid]!), makeRational(1n, 2n));
}

export function costFeasibility(input: FeasibilityInput): FeasibilityResult {
  const { rows, params } = input;
  const notional = makeRational(input.notionalMicro);
  const median = medianRational(rows.map((r) => r.slippageBps));
  const slip =
    median === null
      ? makeRational(0n)
      : mulRat(mulRat(median, makeRational(1n, BPS_DEN)), notional);
  const cost = addRat(makeRational(input.roundTripBrokerageMicro), mulRat(makeRational(2n), slip));
  const required = mulRat(params.costFeasibilityRatio, cost);
  if (rows.length === 0) {
    return {
      evaluable: false,
      costInfeasible: false,
      n: 0,
      grossMean: null,
      grossPerTradeMicro: null,
      medianSlippageBps: median,
      roundTripCostMicro: cost,
      requiredMicro: required,
    };
  }
  let sum = makeRational(0n);
  for (const r of rows) sum = addRat(sum, r.gross);
  const grossMean = divRat(sum, makeRational(BigInt(rows.length)));
  const perTrade = mulRat(grossMean, notional);
  return {
    evaluable: true,
    costInfeasible: cmpRat(perTrade, required) < 0,
    n: rows.length,
    grossMean,
    grossPerTradeMicro: perTrade,
    medianSlippageBps: median,
    roundTripCostMicro: cost,
    requiredMicro: required,
  };
}
