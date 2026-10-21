// Standard normal CDF and quantile, accurate to well under 1e-9 (M4 design 4.8 item 7).
//
// Phi: erfc through a positive-term power series for |x|/sqrt(2) < 2.5 and a fixed-depth continued
// fraction beyond (relative accuracy in the tails). Phi^-1: Acklam's rational start, then three
// Halley steps against Phi. Fixed iteration counts, so results are byte-identical across runs.

const SQRT_PI = 1.7724538509055160273;
const SQRT2 = 1.4142135623730950488;
const SQRT_2PI = 2.5066282746310005024;

/** erf(t) for 0 <= t < 2.5: (2/sqrt(pi)) e^(-t^2) sum_{n>=0} 2^n t^(2n+1) / (1*3*...*(2n+1)). */
function erfSmall(t: number): number {
  const t2 = t * t;
  let term = t;
  let sum = t;
  for (let n = 1; n < 200; n += 1) {
    term *= (2 * t2) / (2 * n + 1);
    sum += term;
    if (term < sum * 1e-18) break;
  }
  return (2 / SQRT_PI) * Math.exp(-t2) * sum;
}

/** erfc(t) for t >= 2.5 by the continued fraction e^(-t^2)/sqrt(pi) / (t + (1/2)/(t + 1/(t + (3/2)/(t + ...)))). */
function erfcLarge(t: number): number {
  let frac = t;
  for (let k = 80; k >= 1; k -= 1) frac = t + k / 2 / frac;
  return Math.exp(-t * t) / SQRT_PI / frac;
}

/** Complementary error function, erfc(t), any real t. */
export function erfc(t: number): number {
  if (Number.isNaN(t)) return Number.NaN;
  if (t < 0) return 2 - erfc(-t);
  if (t < 2.5) return 1 - erfSmall(t);
  if (t > 27) return 0;
  return erfcLarge(t);
}

/** Standard normal CDF. */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  return 0.5 * erfc(-x / SQRT2);
}

/** Standard normal density. */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

/** Acklam's initial approximation for 0 < p <= 0.5 (relative error about 1e-9). */
function acklamLower(p: number): number {
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) /
    (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1)
  );
}

/** Standard normal quantile Phi^-1(p); -Infinity at 0, +Infinity at 1, NaN outside [0, 1]. */
export function normalQuantile(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return Number.NaN;
  if (p === 0) return Number.NEGATIVE_INFINITY;
  if (p === 1) return Number.POSITIVE_INFINITY;
  if (p === 0.5) return 0;
  const lower = p < 0.5;
  const pl = lower ? p : 1 - p;
  let x = acklamLower(pl);
  for (let i = 0; i < 3; i += 1) {
    const e = normalCdf(x) - pl;
    const u = e * SQRT_2PI * Math.exp((x * x) / 2);
    x -= u / (1 + (x * u) / 2);
  }
  return lower ? x : -x;
}
