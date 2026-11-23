// D-1860 (Owner, 23 Nov 2026): TRIAL angles. An angle whose passport is not yet proven (`measured` or
// `candidate`) but that the registry can compute with live readers is scored beside the proven ones, for
// the scorecard only, so the learning Cortex has context from day one. Trial is observation, never a
// decision: a trial angle is never in S, a family's status, a map, a weight, a leader, a switch or a
// "Chance of a net gain". Its values are stored in `cortex_feature_daily.features_json` under the key
// `trial:<angle id>` (no migration) and its scorecard rows in `cortex_angle_day` under the angle id
// `trial:<angle id>`, so nothing that looks an angle up by its own id (the weights, the map, the
// checkpoint, the probes) can ever read one by accident. Pure; imports only the registry types.
import { canActivate } from "./registry";
import type { AngleDef, AngleStatus } from "./types";

/** The marker on a trial angle's key in a feature night and on its id in the scorecard. */
export const TRIAL_PREFIX = "trial:";
/** The marker on the manifest id of a trial row (feature nights and scorecard rows written for trial). */
export const TRIAL_MANIFEST_PREFIX = "trial:";

export const trialId = (id: string): string => `${TRIAL_PREFIX}${id}`;
export const isTrialId = (id: string): boolean => id.startsWith(TRIAL_PREFIX);
/** The registry id of a trial key (an id without the marker is returned as it is). */
export const baseIdOf = (id: string): string =>
  isTrialId(id) ? id.slice(TRIAL_PREFIX.length) : id;

/** The statuses that are trial: not yet proven, not retired. */
export const TRIAL_STATUSES: readonly AngleStatus[] = ["measured", "candidate"];

/**
 * The angles a night scores as trial: score angles, not exclusive, that the registry can compute with
 * live readers (`canActivate`), whose passport says `measured` or `candidate` (an angle with no passport
 * is not trial), and that are not in the night's scored set. Registry order.
 */
export function trialDefsOf(
  angles: readonly AngleDef[],
  scoredDefs: readonly AngleDef[],
  passports: ReadonlyMap<string, AngleStatus>,
): AngleDef[] {
  const scored = new Set(scoredDefs.map((a) => a.id));
  return angles.filter((a) => {
    if (a.kind !== "score" || a.exclusive === true || scored.has(a.id)) return false;
    const s = passports.get(a.id);
    return s !== undefined && TRIAL_STATUSES.includes(s) && canActivate(a).ok;
  });
}
