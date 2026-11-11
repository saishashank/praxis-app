// D-951 "My portfolio" strategy split (Owner 2026-11-11): how a practice portfolio shares its money
// between the strategies whose picks it draws from. Pure and deterministic: the same records give the
// same split.
//
//   1. Evidence. A strategy's finished picks (their net results after costs, pick tracking) give its
//      record: n results with mean m. The record share T is the strategy's positive mean over the sum
//      of the positive means of the strategies in play (equal when none is positive). It is shrunk
//      toward an equal share while the record is short, with the empirical-Bayes weight
//      lambda = n / (n + n0): e = lambda * T + (1 - lambda) / K. A larger n0 trusts a record later.
//   2. Risk. Each share is divided by the strategy's risk to the power of the profile's tilt
//      (inverse volatility, risk parity at tilt 1): risk = lambda * sd(results) + (1 - lambda) *
//      mean stop distance of its picks, so a strategy without a record is judged by its stop-losses.
//   3. Caps and cash. Shares are scaled to add up to 100 %, then each is capped at the strategy cap;
//      a strategy whose shrunk mean result is a loss keeps the profile's weak share of its money in
//      cash. What the caps and the weak rule free stays cash (never handed to another strategy).
//
// Only the strategies "in play" (a holding or a pick on the night) share the money: a strategy
// without anything to buy cannot use a share, so its money is not set aside for it.

/** The families F1 to F6 and the nightly shortlist (rule SL.v1), each its own strategy. */
export const STRATEGIES = ["F1", "F2", "F3", "F4", "F5", "F6", "SL"] as const;
export type StrategyKey = (typeof STRATEGIES)[number];

/** Rule versions of candidate-measure picks start with this; they are never in the portfolio. */
export const CANDIDATE_RULE_PREFIX = "CAND";
const SHORTLIST_PREFIX = "SL";

/** The strategy of a pick, or null for a candidate-measure pick (or an unknown family). */
export function strategyOf(family: string, ruleVersion: string): StrategyKey | null {
  if (ruleVersion.startsWith(CANDIDATE_RULE_PREFIX)) return null;
  if (ruleVersion.startsWith(SHORTLIST_PREFIX)) return "SL";
  return (STRATEGIES as readonly string[]).includes(family) && family !== "SL"
    ? (family as StrategyKey)
    : null;
}

export const PPM = 1_000_000; // threshold-ok: parts per million
const RISK_FLOOR = 0.01; // threshold-ok: D-951 risk floor (1 %), so a near-zero volatility never takes everything

export type StrategyRecord = {
  /** Finished picks. */
  readonly n: number;
  /** Mean net result, as a fraction (0.02 = +2 %). */
  readonly mean: number;
  /** Standard deviation of the results (fraction); 0 with fewer than two. */
  readonly sd: number;
};

export type AllocationProfile = {
  /** Shrinkage strength: results a record needs to count as much as the equal share. */
  readonly shrinkN: number;
  /** Risk tilt: 0 ignores risk, 1 is inverse volatility, above 1 leans further to calm strategies. */
  readonly volTilt: number;
  /** Share of a losing strategy's money kept in cash (0 to 1). */
  readonly weakCash: number;
};

export type AllocationInput = {
  readonly inPlay: readonly StrategyKey[];
  readonly records: ReadonlyMap<StrategyKey, StrategyRecord>;
  /** Mean stop distance of each strategy's picks so far (fraction of the price). */
  readonly stopDistance: ReadonlyMap<StrategyKey, number>;
  /** Most of the money one strategy may have (fraction). */
  readonly strategyCap: number;
};

export type StrategyShare = {
  readonly strategy: StrategyKey;
  /** Target share of the portfolio, ppm. */
  readonly targetPpm: number;
  readonly n: number;
  /** Mean result of its finished picks (fraction). */
  readonly mean: number;
  /** Shrunk mean result (fraction). */
  readonly shrunkMean: number;
  readonly weight: number;
  readonly risk: number;
  readonly capped: boolean;
  readonly weak: boolean;
};

export type Allocation = {
  /** By target share, largest first, then by strategy. */
  readonly shares: StrategyShare[];
  readonly cashPpm: number;
};

const order = (a: StrategyKey, b: StrategyKey): number =>
  STRATEGIES.indexOf(a) - STRATEGIES.indexOf(b);

/** Mean and standard deviation (sample) of results; sd 0 with fewer than two. */
export function recordOf(results: readonly number[]): StrategyRecord {
  const n = results.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0 };
  let s = 0;
  for (const x of results) s += x;
  const mean = s / n;
  if (n < 2) return { n, mean, sd: 0 };
  let q = 0;
  for (const x of results) q += (x - mean) * (x - mean);
  return { n, mean, sd: Math.sqrt(q / (n - 1)) };
}

export function allocate(input: AllocationInput, p: AllocationProfile): Allocation {
  const inPlay = [...new Set(input.inPlay)].sort(order);
  const k = inPlay.length;
  if (k === 0) return { shares: [], cashPpm: PPM };
  // pooled mean of every finished pick (the shrinkage target of the mean)
  let pooledN = 0;
  let pooledSum = 0;
  for (const r of input.records.values()) {
    pooledN += r.n;
    pooledSum += r.mean * r.n;
  }
  const pooled = pooledN > 0 ? pooledSum / pooledN : 0;
  const rec = (s: StrategyKey): StrategyRecord => input.records.get(s) ?? { n: 0, mean: 0, sd: 0 };
  const lambda = (s: StrategyKey): number => {
    const n = rec(s).n;
    return n + p.shrinkN > 0 ? n / (n + p.shrinkN) : 0;
  };
  let positive = 0;
  for (const s of inPlay) positive += Math.max(0, rec(s).mean);
  const rows = inPlay.map((s) => {
    const r = rec(s);
    const l = lambda(s);
    const record = positive > 0 ? Math.max(0, r.mean) / positive : 1 / k;
    const evidence = l * record + (1 - l) / k;
    const stop = input.stopDistance.get(s) ?? 0;
    const risk = Math.max(RISK_FLOOR, l * (r.n >= 2 ? r.sd : stop) + (1 - l) * stop);
    const weight = evidence / Math.pow(risk, p.volTilt);
    return { s, n: r.n, mean: r.mean, shrunkMean: l * r.mean + (1 - l) * pooled, weight, risk };
  });
  let total = 0;
  for (const r of rows) total += r.weight;
  const shares: StrategyShare[] = rows.map((r) => {
    let w = total > 0 ? r.weight / total : 1 / k;
    const capped = w > input.strategyCap;
    if (capped) w = input.strategyCap;
    const weak = r.shrunkMean < 0;
    if (weak) w *= 1 - p.weakCash;
    return {
      strategy: r.s,
      targetPpm: Math.floor(w * PPM),
      n: r.n,
      mean: r.mean,
      shrunkMean: r.shrunkMean,
      weight: r.weight,
      risk: r.risk,
      capped,
      weak,
    };
  });
  shares.sort((a, b) => b.targetPpm - a.targetPpm || order(a.strategy, b.strategy));
  let used = 0;
  for (const x of shares) used += x.targetPpm;
  return { shares, cashPpm: PPM - used };
}
