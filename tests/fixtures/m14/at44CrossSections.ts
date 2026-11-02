// AT-44 fixture (docs/M14_design.md 5): synthetic daily cross-sections for the VAL-114 rank-IC check.
// 500 sessions x 60 ZZ codes from the statistics library's seeded PRNG (no Math.random, no clock).
// Each day every code gets a latent draw; its rank z-score is the "family score" and the next-day
// excess return is edge x z + noise. `edge` = 0.002 plants the edge; 0 is the null twin. Nothing here
// is market data (SEC-110).
import { normalQuantile } from "@/lib/stats/normal";
import { scopedPrng, uniform01, type Prng } from "@/lib/stats/rng";

export const AT44_SESSIONS = 500;
export const AT44_CODES = 60;
/** Daily noise standard deviation of the excess return (2 %). */
export const AT44_NOISE_SD = 0.02;
/** The planted edge: next-day excess = AT44_EDGE x rank z-score + noise. */
export const AT44_EDGE = 0.002;

export const AT44_CODE_LIST: readonly string[] = Array.from(
  { length: AT44_CODES },
  (_, i) => `ZZ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
);

export type CrossSection = {
  readonly d: number;
  readonly scores: readonly { readonly code: string; readonly score: number }[];
  /** Next-day excess return per code (close(D+1) -> close(D+2) minus the market, already excess). */
  readonly forward: ReadonlyMap<string, number>;
};

/** Standard normal draw (Box-Muller, polar form rejected: the plain form keeps the stream order fixed). */
export function normalDraw(rng: Prng): number {
  let u = uniform01(rng);
  if (u === 0) u = Number.EPSILON;
  const v = uniform01(rng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Rank z-scores: the rank of each value (1..n, ties by index) mapped through Z^-1((rank - 0.5) / n). */
export function rankZScores(values: readonly number[]): number[] {
  const n = values.length;
  const idx = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]! || a - b);
  const z = new Array<number>(n).fill(0);
  idx.forEach((i, rank) => {
    z[i] = normalQuantile((rank + 0.5) / n);
  });
  return z;
}

/**
 * The daily cross-sections. The latent draws and the noise come from one seeded stream per `scope`,
 * so the planted world and its null twin differ only in `edge`.
 */
export function crossSections(edge: number, scope: string): CrossSection[] {
  const rng = scopedPrng(scope);
  const out: CrossSection[] = [];
  for (let d = 0; d < AT44_SESSIONS; d += 1) {
    const latent = AT44_CODE_LIST.map(() => normalDraw(rng));
    const z = rankZScores(latent);
    const forward = new Map<string, number>();
    const scores = AT44_CODE_LIST.map((code, i) => {
      forward.set(code, edge * z[i]! + AT44_NOISE_SD * normalDraw(rng));
      return { code, score: z[i]! };
    });
    out.push({ d, scores, forward });
  }
  return out;
}
