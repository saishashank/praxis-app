// VAL-112 validation error budget (M14, D-226, D-227; docs/M14_design.md 2.2).
//   alpha_spending (default): Foster-Stine alpha-investing with payout 0 (pure spending). W0 = `w0`
//     (`val_fwer_per_lineage`); after k tests W_k = W0 / 2^k and the level of the next test is
//     alpha_k = W_k / (2 + W_k). A non-rejection costs alpha / (1 - alpha) = W / 2 and a rejection pays
//     nothing, so W_k = W0 / 2^k whatever the outcomes, and sum(alpha_k) < sum(W_k / 2) = W0: the
//     family-wise error per lineage and split version is at most W0 (0.05).
//   fixed: v1's `validationLevel(alpha, m, L)` (stats/gates.ts).
// k (`priorTests`) is the number of validation_access + pattern_test rows already on the lineage's
// split version (a pure function of the trial ledger: no new table). A new split version starts a new
// pool. `bh_fdr` is refused by the config key (D-227), so it is not a mode here.
import { validationLevel } from "./gates";

export type ErrorBudgetMode = "fixed" | "alpha_spending";

export type ValidationLevelInput = {
  readonly mode: ErrorBudgetMode;
  /** Initial wealth W0 (`val_fwer_per_lineage`, 0.05). */
  readonly w0: number;
  /** Validation and pattern tests already spent on this lineage's split version (k). */
  readonly priorTests: number;
  /** The v1 inputs, used by `fixed` mode: alpha, the trial budget m and the active lineages L. */
  readonly legacy: { readonly alpha: number; readonly m: number; readonly lineages: number };
};

/** Wealth left after k tests under zero payout: W0 / 2^k. */
export function wealthAfter(w0: number, tests: number): number {
  return w0 / 2 ** tests;
}

/** Foster-Stine level at wealth W: W / (2 + W). */
export function spendingLevel(wealth: number): number {
  return wealth / (2 + wealth);
}

/** Level of the next VAL-110 (i)/(ii) test. */
export function validationLevelFor(input: ValidationLevelInput): number {
  if (input.mode === "fixed") {
    return validationLevel(input.legacy.alpha, input.legacy.m, input.legacy.lineages);
  }
  if (!Number.isInteger(input.priorTests) || input.priorTests < 0) {
    throw new RangeError("priorTests must be a non-negative integer");
  }
  if (!(input.w0 > 0 && input.w0 < 1)) throw new RangeError("w0 must be in (0, 1)");
  return spendingLevel(wealthAfter(input.w0, input.priorTests));
}
