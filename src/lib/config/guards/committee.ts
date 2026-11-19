// The Committee switch guard (M21 A1, D-1213, moved here unchanged by M22 A2, D-1445) and the freeze of the four trial keys
// (D-1420). The Committee (AGT-145, D-938) can be switched on only when the stored steelman health shows ten qualifying
// nights at the case-writing check of 98 % or better (BLD-041). While a Committee trial runs (a pre-registration row and no
// final verdict yet) the four keys the pre-registration freezes refuse every edit. Read-only: bounded keyset reads, nothing
// is written. A failed read refuses (fails closed), except that a database without the trial tables has no trial.
import type { Client } from "@libsql/client";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import { NIGHTS_NEEDED, steelmanHealthOf } from "@/lib/health/steelman";
import { readNights } from "@/lib/steelman/store";
import type { Guard } from "../switchGuards";

/** The refusal text of the Committee switch for `qualifying` nights of the ten needed. */
export const committeeRefusal = (qualifying: number): string =>
  `The Committee can be switched on after ${NIGHTS_NEEDED} nights with the case-writing check at 98 % or better (${qualifying} of ${NIGHTS_NEEDED} so far)`;

/** The refusal text of a frozen trial key (D-1420). */
export const FROZEN_TRIAL_REFUSAL =
  "The Committee trial is running: its settings are frozen until it ends";

/** The keys the pre-registration freezes (D-1420): horizon, trial length, smallest sample and the permutation count. */
export const FROZEN_TRIAL_KEYS = [
  "committee_horizon_sessions",
  "committee_trial_sessions",
  "committee_min_settled",
  "committee_permutations",
] as const;

/** Null when `value` may be set now, else the refusal text; "off" and every other value pass. */
export const committeeGuard: Guard = async (db, value) => {
  if (value !== "on") return null;
  try {
    // rows-ok: steelman_night primary key (market, d) read newest-first, LIMIT 10
    const health = steelmanHealthOf(await readNights(db, HOME_MARKET, NIGHTS_NEEDED));
    return health.qualifying >= NIGHTS_NEEDED ? null : committeeRefusal(health.qualifying);
  } catch {
    return committeeRefusal(0);
  }
};

/** True when a trial has a pre-registration in the home market and no final verdict; a database without the tables has none. */
async function trialRunning(db: Pick<Client, "execute">): Promise<boolean> {
  try {
    // rows-ok: committee_prereg primary key (trial_id, version), the final-row probe is on the primary key of committee_trial_result, LIMIT 1
    const r = await db.execute({
      sql: `SELECT 1 FROM committee_prereg p WHERE p.market = ?
              AND NOT EXISTS (SELECT 1 FROM committee_trial_result f
                              WHERE f.trial_id = p.trial_id AND f.market = p.market AND f.kind = 'final')
            LIMIT 1`,
      args: [HOME_MARKET],
    });
    return r.rows.length > 0;
  } catch (e) {
    // The tables come with migration 0042: before it there is no trial. Any other failure refuses (fails closed).
    if (e instanceof Error && /no such table/i.test(e.message)) return false;
    return true;
  }
}

/** The guard of the four frozen trial keys: refused, whatever the value, while a trial runs. */
export const frozenTrialGuard: Guard = async (db) =>
  (await trialRunning(db)) ? FROZEN_TRIAL_REFUSAL : null;
