// VAL-112 validation error budget (M14, D-226, D-227; docs/M14_design.md 2.2). WP0 SIGNATURE STUB: WP4
// fills it in. Until then every call returns the v1 level, so nothing changes.
//
// WP4 contract:
//   alpha_spending (default): Foster-Stine with payout 0. W0 = `w0` (`val_fwer_per_lineage`); after k
//     tests W_k = W0 / 2^k and the level of the next test is alpha_k = W_k / (2 + W_k), so the levels
//     sum to at most W0 (family-wise error per lineage and split version <= 0.05).
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

/** Level of the next VAL-110 (i)/(ii) test. STUB: returns the v1 fixed level in every mode. */
export function validationLevelFor(input: ValidationLevelInput): number {
  return validationLevel(input.legacy.alpha, input.legacy.m, input.legacy.lineages);
}
