// VAL-113 power arithmetic (M14, D-229; docs/M14_design.md 2.2). Rows needed to detect `effect` at
// `level` (one-sided) with the stated power, from the normal approximation also used by
// `minimumDetectableEffect` (stats/gates.ts):
//   n = max(100, ceil(((z_{1-level} + z_power) * sd / effect)^2 / neffRatio))
// `neffRatio` is effective N over row count (<= 1): correlated rows need proportionally more.
import { normalQuantile } from "./normal";

/** VAL-113 floor: never plan below the ARN-082 minimum of 100 rows. */
export const MIN_PLANNED_ROWS = 100;
export const PLANNING_POWER = 0.8;

export type RequiredRowsInput = {
  /** Mean effect to detect, in the same unit as `sd` (> 0). */
  readonly effect: number;
  /** Standard deviation of one row. */
  readonly sd: number;
  /** One-sided test level (from `validationLevelFor`). */
  readonly level: number;
  readonly power?: number;
  /** Effective N / N in (0, 1]; default 1. */
  readonly neffRatio?: number;
};

export function requiredRows(input: RequiredRowsInput): number {
  const power = input.power ?? PLANNING_POWER;
  const ratio = input.neffRatio ?? 1;
  if (!(input.effect > 0)) throw new RangeError("effect must be positive");
  if (!(input.sd >= 0)) throw new RangeError("sd must not be negative");
  if (!(input.level > 0 && input.level < 1)) throw new RangeError("level must be in (0, 1)");
  if (!(power > 0 && power < 1)) throw new RangeError("power must be in (0, 1)");
  if (!(ratio > 0 && ratio <= 1)) throw new RangeError("neffRatio must be in (0, 1]");
  const z = normalQuantile(1 - input.level) + normalQuantile(power);
  const n = Math.ceil(((z * input.sd) / input.effect) ** 2 / ratio - 1e-9);
  return Math.max(MIN_PLANNED_ROWS, n);
}
