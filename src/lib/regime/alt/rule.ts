// The alt regime rule (M22 E5, DAT-248, D-1440): pure. The alt reading is the base reading made one step more cautious when an
// outside signal shows stress, and never less cautious. It never produces SHOCK (only the base can) and never touches an
// unknown base. Stress = any tracked prediction-market probability at or above ALT_STRESS_PPM. Macro series are carried in
// the stored reading as context but are not in the rule: a threshold for a level needs its own pre-registration (D-1528).
import type { AltInputs } from "./inputs";

/** One probability at or above this (parts per million, 60 %) of a tracked adverse event is stress. */
export const ALT_STRESS_PPM = 600_000; // threshold-ok: DAT-248 pre-registered stress level (D-1440)

/** Cautiousness order of the four known states: calmer first. */
export const CAUTION_ORDER = ["RISK-ON", "NEUTRAL", "RISK-OFF", "SHOCK"] as const;
/** The most cautious state an outside signal alone may reach. */
const ALT_CEILING = "RISK-OFF";

export const cautionOf = (s: string): number => (CAUTION_ORDER as readonly string[]).indexOf(s);

/** True when the tracked predictions show stress. */
export function stressed(inputs: Pick<AltInputs, "predictions">): boolean {
  return inputs.predictions.some((p) => p.probPpm >= ALT_STRESS_PPM);
}

/** The alt state for a base state and the inputs; equals the base when nothing is readable or nothing shows stress. */
export function altState(base: string, inputs: Pick<AltInputs, "predictions">): string {
  const i = cautionOf(base);
  if (i < 0) return base; // unknown: nothing to add to
  if (!stressed(inputs)) return base;
  if (i >= cautionOf(ALT_CEILING)) return base;
  return CAUTION_ORDER[i + 1]!;
}

/** True when the alt state is more cautious than the base (a "differing session" of D-1440). */
export const moreCautious = (base: string, alt: string): boolean =>
  cautionOf(base) >= 0 && cautionOf(alt) > cautionOf(base);
