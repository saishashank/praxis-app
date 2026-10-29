// VAL-115 minimum backtest length (M14, D-230; docs/M14_design.md 2.2). Bailey, Borwein, Lopez de
// Prado and Zhu (2014), "Pseudo-mathematics and financial charlatanism", the MinBTL bound:
//   MinBTL(N, SR*) = [ (1 - g) * Z^-1(1 - 1/N) + g * Z^-1(1 - 1/(N e)) ]^2 / SR*^2   (years)
// with g the Euler-Mascheroni constant, N independent trials and SR* the annualised Sharpe ratio
// that a pure-noise search would find. MinBTL(1) = 0 (one trial cannot be selected from). Known
// answer (the paper's example): N = 45, SR* = 1 gives about 5 years.
import { normalQuantile } from "./normal";

export const EULER_MASCHERONI = 0.5772156649015329;
export const SESSIONS_PER_YEAR_BTL = 252; // threshold-ok: trading sessions per year (D-230)

export function minBacktestYears(trials: number, targetSharpe: number): number {
  if (!Number.isInteger(trials) || trials < 0)
    throw new RangeError("trials must be an integer >= 0");
  if (!(targetSharpe > 0)) throw new RangeError("targetSharpe must be positive");
  if (trials <= 1) return 0;
  const g = EULER_MASCHERONI;
  const z =
    (1 - g) * normalQuantile(1 - 1 / trials) + g * normalQuantile(1 - 1 / (trials * Math.E));
  return (z * z) / (targetSharpe * targetSharpe);
}

export type MinBtlLabel = "too short" | "long enough";

/** Length available = development sessions / 252; "too short" until it reaches MinBTL. */
export function minBtlLabel(
  trials: number,
  targetSharpe: number,
  developmentSessions: number,
): { readonly minYears: number; readonly availableYears: number; readonly label: MinBtlLabel } {
  const minYears = minBacktestYears(trials, targetSharpe);
  const availableYears = developmentSessions / SESSIONS_PER_YEAR_BTL;
  return {
    minYears,
    availableYears,
    label: availableYears >= minYears ? "long enough" : "too short",
  };
}
