// Levels, replication counts, minimum detectable effect and gate predicates (M4 design 4.8 items 3-5,
// 4.10; decisions 24, 25, 27; ARN-081, ARN-082, ARN-084, ARN-086, ARN-093, VAL-110).
import { normalQuantile } from "./normal";

export const ALPHA = 0.05;
export const MIN_ROWS = 100;
export const MIN_BLOCKS = 15;
export const POWER = 0.8;

/** Level of VAL-110 (i)/(ii) and ARN-084: alpha / (m * L). Default 0.05 / (20 * 6) = 0.000416667. */
export function validationLevel(alpha: number, m: number, lineages: number): number {
  return alpha / (m * Math.max(6, lineages));
}

/** Holdout confirmation level: alpha / L, with L = max(6, active lineages). */
export function holdoutLevel(alpha: number, lineages: number): number {
  return alpha / Math.max(6, lineages);
}

/** Forward look k level (ARN-086): (0.10 / L) / 2^k. */
export function forwardLookLevel(k: number, lineages: number, total = 0.1): number {
  return total / Math.max(6, lineages) / 2 ** k;
}

/** Kill-switch look k level (ARN-093): (0.05 / 3) / 2^k. */
export function killSwitchLevel(k: number, total = 0.05): number {
  return total / 3 / 2 ** k;
}

/** B = max(1,000, ceil(20 / level)); a relative 1e-9 guard stops 20/level = 48,000.0000000001 giving 48,001. */
export function bootstrapReplications(level: number, floor = 1000): number {
  return Math.max(floor, Math.ceil(20 / level - 1e-9));
}

/** B for the AT-17 size checks (decision 24): fixed. */
export const SIZE_CHECK_REPLICATES = 2000;

/** Minimum detectable effect at `level` with 80 % power: (z_{1-level} + z_{0.80}) * se (normal approximation). */
export function minimumDetectableEffect(level: number, se: number, power = POWER): number {
  return (normalQuantile(1 - level) + normalQuantile(power)) * se;
}

/** Absolute gate (ARN-081): the one-sided 90 % lower bound of mean net return under P5 is > 0. */
export function absoluteGatePasses(lower90: number): boolean {
  return lower90 > 0;
}

/** "Insufficient evidence" (ARN-082): fewer than 100 rows or fewer than 15 independent blocks. */
export function insufficientEvidence(rows: number, blocks: number): boolean {
  return rows < MIN_ROWS || blocks < MIN_BLOCKS;
}

/** VAL-110 (i): p <= level and the absolute gate. */
export function validationGateI(p: number, level: number, lower90: number): boolean {
  return p <= level && absoluteGatePasses(lower90);
}

/** FAILED (ARN-086): the upper end of the two-sided 90 % interval of mean excess is below the useful edge. */
export function excessFailed(upper95: number, usefulEdgeMin: number): boolean {
  return upper95 < usefulEdgeMin;
}

/** VAL-110 (iv): stress-profile point estimate of mean net return is > 0. */
export function stressGatePasses(stressMean: number): boolean {
  return stressMean > 0;
}

/**
 * Trial budget at a roll (ARN-085, decision 26): m - ceil(accessesOld * overlap), overlap = shared
 * sessions / new validation sessions (capped at 1), never below 0.
 */
export function rolledTrialBudget(
  m: number,
  accessesOld: number,
  sharedSessions: number,
  newValidationSessions: number,
): number {
  const overlap = Math.min(1, sharedSessions / newValidationSessions);
  return Math.max(0, m - Math.ceil(accessesOld * overlap - 1e-9));
}
