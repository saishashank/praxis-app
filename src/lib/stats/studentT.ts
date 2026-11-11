// Student's t distribution (cortex learning loop, weekly findings on overlapping 20-session ICs).
// CDF through the regularised incomplete beta function, evaluated by Lentz's continued fraction
// (Numerical Recipes 6.4) with a Lanczos log-gamma. Real-valued degrees of freedom are allowed (the
// effective sample of an overlapping series is fractional). Pure; known-answer tests in
// tests/stats/studentT.test.ts.

const LANCZOS = [
  76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
  0.1208650973866179e-2, -0.5395239384953e-5,
];
const LANCZOS_SQRT_2PI = 2.5066282746310005;
const CF_MAX_ITER = 300;
const CF_EPS = 3e-14;
const CF_TINY = 1e-300;

/** ln Γ(x) for x > 0 (Lanczos, |error| < 2e-10). */
export function logGamma(x: number): number {
  if (!(x > 0)) throw new RangeError("logGamma needs x > 0");
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of LANCZOS) {
    y += 1;
    ser += c / y;
  }
  return -tmp + Math.log((LANCZOS_SQRT_2PI * ser) / x);
}

function betaCf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < CF_TINY) d = CF_TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= CF_MAX_ITER; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < CF_TINY) d = CF_TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < CF_TINY) c = CF_TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < CF_TINY) d = CF_TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < CF_TINY) c = CF_TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < CF_EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b), a, b > 0, x in [0, 1]. */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new RangeError("a and b must be > 0");
  if (!(x >= 0 && x <= 1)) throw new RangeError("x must be in [0, 1]");
  if (x === 0 || x === 1) return x;
  const lnFront =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) return (front * betaCf(a, b, x)) / a;
  return 1 - (front * betaCf(b, a, 1 - x)) / b;
}

/** P(T ≤ t) for Student's t with `df` > 0 degrees of freedom (real-valued). */
export function studentTCdf(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError("df must be > 0");
  if (Number.isNaN(t)) return Number.NaN;
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Two-sided p-value of a t statistic: P(|T| ≥ |t|). */
export function studentTTwoSided(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError("df must be > 0");
  if (!Number.isFinite(t)) return Number.isNaN(t) ? Number.NaN : 0;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}
