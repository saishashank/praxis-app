// Deflated Sharpe Ratio (Bailey and Lopez de Prado 2014, "The Deflated Sharpe Ratio: Correcting for
// Selection Bias, Backtest Overfitting and Non-Normality"; M4 design 4.8 item 7, decision 27).
import { mean } from "./bootstrap";
import { normalCdf, normalQuantile } from "./normal";

export const EULER_GAMMA = 0.5772156649;

export type ReturnMoments = {
  readonly n: number;
  readonly mean: number;
  /** Per-period Sharpe ratio: mean / SD (SD with the n - 1 denominator); 0 when SD is 0. */
  readonly sharpe: number;
  /** Skewness gamma3 (population central moments). */
  readonly skew: number;
  /** Kurtosis gamma4, NOT excess (a normal sample gives about 3). */
  readonly kurtosis: number;
};

export function returnMoments(returns: readonly number[]): ReturnMoments {
  const n = returns.length;
  if (n < 3) throw new RangeError("at least 3 returns are required");
  const m = mean(returns);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const r of returns) {
    const d = r - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  const pop2 = m2 / n;
  const sd = Math.sqrt(m2 / (n - 1));
  return {
    n,
    mean: m,
    sharpe: sd > 0 ? m / sd : 0,
    skew: pop2 > 0 ? m3 / n / pop2 ** 1.5 : 0,
    kurtosis: pop2 > 0 ? m4 / n / (pop2 * pop2) : 3,
  };
}

/**
 * SR0 = sqrt(V) * ((1 - gammaE) Phi^-1(1 - 1/N) + gammaE Phi^-1(1 - 1/(N e))); N = 1 gives 0
 * (decision 27: there is no selection, and Phi^-1(0) is undefined).
 */
export function expectedMaxSharpe(trials: number, srVariance: number): number {
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError("trials must be >= 1");
  if (trials === 1) return 0;
  return (
    Math.sqrt(srVariance) *
    ((1 - EULER_GAMMA) * normalQuantile(1 - 1 / trials) +
      EULER_GAMMA * normalQuantile(1 - 1 / (trials * Math.E)))
  );
}

export type DsrInput = {
  /** Observed per-period Sharpe ratio of the selected variant. */
  readonly sharpe: number;
  readonly skew: number;
  /** Not excess. */
  readonly kurtosis: number;
  /** Number of return observations T. */
  readonly observations: number;
  /** Lineage trials on this split. */
  readonly trials: number;
  /** Variance of the per-period Sharpe across tested variants (or the frozen default). */
  readonly srVariance: number;
};

export type DsrResult = {
  readonly sr0: number;
  /** DSR = Phi((SR - SR0) sqrt(T - 1) / sqrt(1 - g3 SR + (g4 - 1)/4 SR^2)); null if the denominator is not positive. */
  readonly dsr: number | null;
};

export function deflatedSharpeRatio(input: DsrInput): DsrResult {
  const sr0 = expectedMaxSharpe(input.trials, input.srVariance);
  const sr = input.sharpe;
  const denomSq = 1 - input.skew * sr + ((input.kurtosis - 1) / 4) * sr * sr;
  if (!(denomSq > 0) || input.observations < 2) return { sr0, dsr: null };
  const z = ((sr - sr0) * Math.sqrt(input.observations - 1)) / Math.sqrt(denomSq);
  return { sr0, dsr: normalCdf(z) };
}

/** Probabilistic Sharpe Ratio against a benchmark: DSR with SR0 replaced by `benchmark`. */
export function probabilisticSharpeRatio(
  input: Omit<DsrInput, "trials" | "srVariance">,
  benchmark = 0,
): number | null {
  const denomSq = 1 - input.skew * input.sharpe + ((input.kurtosis - 1) / 4) * input.sharpe ** 2;
  if (!(denomSq > 0) || input.observations < 2) return null;
  return normalCdf(
    ((input.sharpe - benchmark) * Math.sqrt(input.observations - 1)) / Math.sqrt(denomSq),
  );
}
