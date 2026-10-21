// One-sample Kolmogorov-Smirnov test against U(0,1) (AT-17 uniformity check, M4 design 4.9, decision 27).
//
// Exact p-value for n <= 140 by the Marsaglia-Tsang-Wang (2003, J. Stat. Software 8(18)) matrix
// method; beyond that, the Kolmogorov limit with Stephens' (1970) finite-n correction.

/** D_n = sup |F_n(x) - x| for a sample on [0, 1]. Sorts a copy; the input is not changed. */
export function ksStatistic(sample: readonly number[]): number {
  const n = sample.length;
  if (n === 0) throw new RangeError("sample must not be empty");
  const xs = Float64Array.from(sample).sort();
  let d = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i]!;
    d = Math.max(d, (i + 1) / n - x, x - i / n);
  }
  return d;
}

type Scaled = { readonly m: Float64Array; readonly e: number };

function multiply(a: Float64Array, b: Float64Array, size: number): Float64Array {
  const c = new Float64Array(size * size);
  for (let i = 0; i < size; i += 1) {
    for (let k = 0; k < size; k += 1) {
      const aik = a[i * size + k]!;
      if (aik === 0) continue;
      for (let j = 0; j < size; j += 1) c[i * size + j]! += aik * b[k * size + j]!;
    }
  }
  return c;
}

function power(a: Float64Array, size: number, n: number): Scaled {
  if (n === 1) return { m: a, e: 0 };
  const half = power(a, size, Math.floor(n / 2));
  const sq = multiply(half.m, half.m, size);
  let m = sq;
  let e = 2 * half.e;
  if (n % 2 === 1) m = multiply(a, sq, size);
  const mid = Math.floor(size / 2) * size + Math.floor(size / 2);
  if (m[mid]! > 1e140) {
    for (let i = 0; i < m.length; i += 1) m[i]! *= 1e-140;
    e += 140;
  }
  return { m, e };
}

/** P(D_n < d) exactly (Marsaglia-Tsang-Wang). */
function ksCdfExact(n: number, d: number): number {
  const k = Math.floor(n * d) + 1;
  const size = 2 * k - 1;
  const h = k - n * d;
  const H = new Float64Array(size * size);
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) H[i * size + j] = i - j + 1 < 0 ? 0 : 1;
  }
  for (let i = 0; i < size; i += 1) {
    H[i * size]! -= h ** (i + 1);
    H[(size - 1) * size + i]! -= h ** (size - i);
  }
  H[(size - 1) * size]! += 2 * h - 1 > 0 ? (2 * h - 1) ** size : 0;
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      if (i - j + 1 > 0) {
        for (let g = 1; g <= i - j + 1; g += 1) H[i * size + j]! /= g;
      }
    }
  }
  const q = power(H, size, n);
  let s = q.m[(k - 1) * size + (k - 1)]!;
  let e = q.e;
  for (let i = 1; i <= n; i += 1) {
    s = (s * i) / n;
    if (s < 1e-140) {
      s *= 1e140;
      e -= 140;
    }
  }
  return s * 10 ** e;
}

/** Kolmogorov limit survival Q(lambda) = 2 sum_{j>=1} (-1)^(j-1) exp(-2 j^2 lambda^2). */
function kolmogorovSurvival(lambda: number): number {
  if (lambda < 0.2) return 1;
  let sum = 0;
  for (let j = 1; j <= 100; j += 1) {
    const term = Math.exp(-2 * j * j * lambda * lambda);
    sum += (j % 2 === 1 ? 1 : -1) * term;
    if (term < 1e-18) break;
  }
  return Math.min(1, Math.max(0, 2 * sum));
}

export const KS_EXACT_MAX_N = 140;

/** P(D_n >= d) under H0 (continuous, fully specified null). */
export function ksPValue(n: number, d: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  if (d <= 0) return 1;
  if (d >= 1) return 0;
  if (n <= KS_EXACT_MAX_N) return Math.min(1, Math.max(0, 1 - ksCdfExact(n, d)));
  const rn = Math.sqrt(n);
  return kolmogorovSurvival((rn + 0.12 + 0.11 / rn) * d);
}

/** KS test of a sample against U(0,1): statistic, n and p-value. */
export function ksUniformityTest(sample: readonly number[]): {
  readonly n: number;
  readonly d: number;
  readonly p: number;
} {
  const d = ksStatistic(sample);
  return { n: sample.length, d, p: ksPValue(sample.length, d) };
}
