// D-1078: the two constants that identify warm-start output (see ./warmStart.ts). Kept apart so the
// Cortex page loader can read them without importing the replay machinery.
/** The marker on every warm-start row's manifest_id. */
export const WARM_PREFIX = "warmstart:";
/** Seq of the run's event on its last night (nightly seqs are 0..99, the scorecard takes 0). */
export const WARM_EVENT_SEQ = 99; // threshold-ok: event seq layout (hooks.ts header)
/** D-1860: seq of a trial run's event (it never counts as a warm start for the Cortex page). */
export const WARM_TRIAL_EVENT_SEQ = 98; // threshold-ok: event seq layout (hooks.ts header)
