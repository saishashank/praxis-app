// Wilson score interval, exact (Clopper-Pearson) binomial bounds, binomial tails and acceptance
// regions (M4 design 4.8, 4.9, 4.10, 4.11; ARN-070, ARN-071, ARN-093, AT-17).
import { normalQuantile } from "./normal";

export type Interval = { readonly lower: number; readonly upper: number };

function assertCounts(k: number, n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be a non-negative integer");
  if (!Number.isInteger(k) || k < 0 || k > n)
    throw new RangeError("k must be an integer in [0, n]");
}

/** Wilson score interval for k successes of n at two-sided `confidence` (0.90, 0.95, ...). */
export function wilsonInterval(k: number, n: number, confidence: number): Interval {
  assertCounts(k, n);
  if (n === 0) return { lower: 0, upper: 1 };
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const z2 = z * z;
  const p = k / n;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

// log(i!) table, built by a left-to-right sum so the values are the same on every run.
const LOG_FACT: number[] = [0];
function logFactorial(i: number): number {
  for (let j = LOG_FACT.length; j <= i; j += 1) LOG_FACT.push(LOG_FACT[j - 1]! + Math.log(j));
  return LOG_FACT[i]!;
}

/** log of the binomial pmf, p strictly inside (0, 1). */
function logPmf(k: number, n: number, p: number): number {
  return (
    logFactorial(n) -
    logFactorial(k) -
    logFactorial(n - k) +
    k * Math.log(p) +
    (n - k) * Math.log1p(-p)
  );
}

function sumPmf(from: number, to: number, n: number, p: number): number {
  let s = 0;
  for (let i = from; i <= to; i += 1) s += Math.exp(logPmf(i, n, p));
  return s;
}

/** P(X <= k) for X ~ Binomial(n, p); the smaller tail is summed directly. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be a non-negative integer");
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  if (k + 1 <= n - k) return Math.min(1, sumPmf(0, k, n, p));
  return Math.max(0, 1 - sumPmf(k + 1, n, n, p));
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomialSurvival(k: number, n: number, p: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be a non-negative integer");
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (n - k + 1 <= k) return Math.min(1, sumPmf(k, n, n, p));
  return Math.max(0, 1 - sumPmf(0, k - 1, n, p));
}

/** Lower tail P(X <= k): the exact test that an observed count is too low (ARN-093 criteria 2 and 3). */
export const binomialLowerTail = binomialCdf;

/** Root of f on (0, 1) by 200 fixed bisection steps; f(p) < 0 left of the root, >= 0 right of it. */
function bisect(f: (p: number) => number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Clopper-Pearson interval, two-sided at level 1 - `alpha` (alpha/2 in each tail). k = 0 gives
 * lower 0; k = n gives upper 1.
 */
export function clopperPearson(k: number, n: number, alpha: number): Interval {
  assertCounts(k, n);
  return {
    lower: k === 0 ? 0 : bisect((p) => binomialSurvival(k, n, p) - alpha / 2),
    upper: k === n ? 1 : bisect((p) => alpha / 2 - binomialCdf(k, n, p)),
  };
}

/** One-sided exact upper bound: the p at which P(X <= k | p) = alpha (k = n gives 1). */
export function exactUpperBound(k: number, n: number, alpha: number): number {
  assertCounts(k, n);
  return k === n ? 1 : bisect((p) => alpha - binomialCdf(k, n, p));
}

/** One-sided exact lower bound: the p at which P(X >= k | p) = alpha (k = 0 gives 0). */
export function exactLowerBound(k: number, n: number, alpha: number): number {
  assertCounts(k, n);
  return k === 0 ? 0 : bisect((p) => binomialSurvival(k, n, p) - alpha);
}

/**
 * Two-sided exact acceptance region for a count under H0: p, at level 1 - `alpha`: the integers k
 * with P(X <= k) > alpha/2 and P(X >= k) > alpha/2 (AT-17 size check: p = 0.05 or 0.01, n = 2,000,
 * alpha = 0.01). Returned as [lo, hi]; the region is contiguous.
 */
export function binomialAcceptanceRegion(
  n: number,
  p: number,
  alpha: number,
): { readonly lo: number; readonly hi: number } {
  assertCounts(0, n);
  let lo = 0;
  while (lo < n && binomialCdf(lo, n, p) <= alpha / 2) lo += 1;
  let hi = n;
  while (hi > 0 && binomialSurvival(hi, n, p) <= alpha / 2) hi -= 1;
  return { lo, hi };
}
