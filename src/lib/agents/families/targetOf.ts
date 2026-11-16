// FAM-010 real target exit (M21 task E1, D-1224, D-1225). A target is a close-signal rule that a
// pre-registered challenger may add through the optional structural keys `f<n>_target_r` (a multiple of
// the initial risk) or `f<n>_target_pct` (a percentage above the entry fill). Absent keys = no target =
// the v1 plan, byte for byte. Exact integer micro arithmetic and rationals only; no float on a money path.
import { divCeil, parseRational, type Rational } from "@/lib/money/rational";
import type { Family } from "../schema";
import type { CsRule, ExitPlan, StopSpec } from "./types";

/** Bounds of the two keys (FAM-010: 1.0 to 5.0 times the initial risk; 5 to 50 percent). */
export const TARGET_R_BOUNDS = [1, 5] as const; // threshold-ok: FAM-010 bounds
export const TARGET_PCT_BOUNDS = [5, 50] as const; // threshold-ok: FAM-010 bounds

export const TARGET_FAMILIES: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];
export const targetRKey = (f: Family): string => `${f.toLowerCase()}_target_r`;
export const targetPctKey = (f: Family): string => `${f.toLowerCase()}_target_pct`;
/** The two target keys of a family, in the order r, pct. */
export const targetKeysOf = (f: Family): readonly string[] => [targetRKey(f), targetPctKey(f)];

/** Exactly one of r and pct is set. */
export type TargetParams = { readonly r: Rational | null; readonly pct: Rational | null };

const isFinite_ = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inBounds = (v: number, b: readonly [number, number]): boolean => v >= b[0] && v <= b[1];

/** Plain decimal text of a finite number (never exponent form). */
function decimalText(n: number): string {
  const text = String(n);
  if (!text.includes("e")) return text;
  const FORMAT_DIGITS = 20; // threshold-ok: text formatting width, not a rule
  return n.toFixed(FORMAT_DIGITS);
}

/** Problems with the target keys of one family in a params_json (absent keys are fine). */
export function checkTargetParams(
  family: Family,
  params: Readonly<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(params, k);
  const rk = targetRKey(family);
  const pk = targetPctKey(family);
  if (has(rk) && has(pk)) errors.push(`params: ${rk} and ${pk} cannot both be set`);
  if (has(rk)) {
    const v = params[rk];
    if (!isFinite_(v) || !inBounds(v, TARGET_R_BOUNDS))
      errors.push(
        `params: ${rk} must be a number from ${TARGET_R_BOUNDS[0]} to ${TARGET_R_BOUNDS[1]}`,
      );
  }
  if (has(pk)) {
    const v = params[pk];
    if (!isFinite_(v) || !inBounds(v, TARGET_PCT_BOUNDS))
      errors.push(
        `params: ${pk} must be a number from ${TARGET_PCT_BOUNDS[0]} to ${TARGET_PCT_BOUNDS[1]}`,
      );
  }
  return errors;
}

/** The family's target from a rule version's params_json, or undefined (no target, or invalid). */
export function targetFromParams(
  family: Family,
  params: Readonly<Record<string, unknown>>,
): TargetParams | undefined {
  if (checkTargetParams(family, params).length > 0) return undefined;
  const r = params[targetRKey(family)];
  const pct = params[targetPctKey(family)];
  if (isFinite_(r)) return { r: parseRational(decimalText(r)), pct: null };
  if (isFinite_(pct)) return { r: null, pct: parseRational(`${decimalText(pct)}%`) };
  return undefined;
}

/**
 * The target price in raw micro: the smallest whole-micro close that triggers the rule.
 *   R:   entry + ceil(R x (entry - stop)); null when the risk is not positive
 *   pct: ceil(entry x (1 + pct))
 */
export function targetLevel(
  t: { readonly r: Rational | null; readonly pct: Rational | null },
  entryMicro: bigint,
  stopMicro: bigint,
): bigint | null {
  if (t.r !== null) {
    const risk = entryMicro - stopMicro;
    if (risk <= 0n) return null;
    return entryMicro + divCeil(t.r.num * risk, t.r.den);
  }
  if (t.pct !== null) return divCeil(entryMicro * (t.pct.den + t.pct.num), t.pct.den);
  return null;
}

/**
 * What the Size column and the card show (task C2, D-1225): the real target of a rule version's
 * params_json for an entry and its initial stop, in raw micro, or null ("No target"). A version with no
 * target key (every seed rule) gives null.
 */
export function targetOf(
  params: Readonly<Record<string, unknown>>,
  entryMicro: bigint,
  initialStopMicro: bigint,
): bigint | null {
  for (const family of TARGET_FAMILIES) {
    const t = targetFromParams(family, params);
    if (t !== undefined) return targetLevel(t, entryMicro, initialStopMicro);
  }
  return null;
}

/** The tightest initial stop of a plan at an entry fill (ARN-021: the highest level of its initial-stop rules). */
export function planInitialStop(
  plan: ExitPlan,
  fillMicro: bigint,
  stopOf: (spec: StopSpec, fill: bigint) => bigint,
): bigint {
  let level = 0n;
  for (const rule of plan.initialStops) {
    const s = stopOf(rule.spec, fillMicro);
    if (s > level) level = s;
  }
  return level < 1n ? 1n : level;
}

/** The plan with the family's target appended LAST, so every existing CS rule keeps its precedence. */
export function withTarget(plan: ExitPlan, target: TargetParams | undefined): ExitPlan {
  if (target === undefined) return plan;
  const rule: CsRule = {
    id: "target",
    via: null,
    kind: "target",
    targetR: target.r,
    targetPct: target.pct,
  };
  return { ...plan, cs: [...plan.cs, rule] };
}
