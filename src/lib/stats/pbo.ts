// Probability of Backtest Overfitting by combinatorially symmetric cross-validation
// (Bailey, Borwein, Lopez de Prado, Zhu 2015; M4 design 4.8 item 6, decision 27).
//
// returns[t][n]: weekly return of variant n in week t. The T weeks are cut into S contiguous blocks
// of floor(T / S) weeks (the last block takes the remainder). For each of the C(S, S/2) splits
// (lexicographic order) the in-sample half picks the variant with the best Sharpe (ties: lowest
// index); lambda = logit(omega), omega = relative out-of-sample rank of that variant, rank/(N + 1)
// with ties sharing the average rank. PBO = share of splits with lambda <= 0.
import { mean, sampleSd } from "./bootstrap";

export type PboResult =
  | { readonly status: "n/a"; readonly reason: string }
  | {
      readonly status: "ok";
      readonly pbo: number;
      readonly splits: number;
      readonly variants: number;
      readonly logits: readonly number[];
    };

export const PBO_BLOCKS = 10;
export const PBO_MIN_VARIANTS = 5;

function sharpe(xs: number[]): number {
  const sd = sampleSd(xs);
  return sd > 0 ? mean(xs) / sd : 0;
}

/** All k-subsets of 0..n-1 in lexicographic order. */
export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number): void => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i <= n - (k - cur.length); i += 1) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

export function probabilityOfBacktestOverfitting(
  returns: readonly (readonly number[])[],
  options: { readonly blocks?: number; readonly minVariants?: number } = {},
): PboResult {
  const S = options.blocks ?? PBO_BLOCKS;
  const minVariants = options.minVariants ?? PBO_MIN_VARIANTS;
  if (S < 2 || S % 2 !== 0) throw new RangeError("blocks must be an even number >= 2");
  const T = returns.length;
  const N = T === 0 ? 0 : returns[0]!.length;
  if (N < minVariants) return { status: "n/a", reason: `fewer than ${minVariants} variants` };
  if (T < 2 * S) return { status: "n/a", reason: `fewer than ${2 * S} weeks` };
  for (const row of returns) {
    if (row.length !== N) throw new RangeError("ragged returns matrix");
  }
  const size = Math.floor(T / S);
  const blockRows = (b: number): [number, number] => [b * size, b === S - 1 ? T : (b + 1) * size];
  const splits = combinations(S, S / 2);
  const logits: number[] = [];
  let nonPositive = 0;
  for (const chosen of splits) {
    const inSet = new Set(chosen);
    const isIdx: number[] = [];
    const oosIdx: number[] = [];
    for (let b = 0; b < S; b += 1) {
      const [from, to] = blockRows(b);
      for (let t = from; t < to; t += 1) (inSet.has(b) ? isIdx : oosIdx).push(t);
    }
    const isSr: number[] = [];
    const oosSr: number[] = [];
    for (let n = 0; n < N; n += 1) {
      isSr.push(sharpe(isIdx.map((t) => returns[t]![n]!)));
      oosSr.push(sharpe(oosIdx.map((t) => returns[t]![n]!)));
    }
    let best = 0;
    for (let n = 1; n < N; n += 1) if (isSr[n]! > isSr[best]!) best = n;
    let less = 0;
    let equal = 0;
    for (let n = 0; n < N; n += 1) {
      if (n === best) continue;
      if (oosSr[n]! < oosSr[best]!) less += 1;
      else if (oosSr[n]! === oosSr[best]!) equal += 1;
    }
    const rank = 1 + less + equal / 2;
    const omega = rank / (N + 1);
    const lambda = Math.log(omega / (1 - omega));
    logits.push(lambda);
    if (lambda <= 0) nonPositive += 1;
  }
  return {
    status: "ok",
    pbo: nonPositive / splits.length,
    splits: splits.length,
    variants: N,
    logits,
  };
}
