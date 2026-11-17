// Switch guards (M21 A1, D-1213; a registry since M22 A2, D-1445): a key-specific refusal of an Owner edit, called by
// `updateConfig` right after the Lane-B lock. One file per guarded key under `guards/`, each owned by one task; this file
// only registers them. A guard is read-only and fails closed: a failed read refuses. Every key without a guard, and every
// value a guard does not refuse, passes.
import type { Client } from "@libsql/client";
import type { ConfigKey } from "./keys";
import { committeeGuard, frozenTrialGuard, FROZEN_TRIAL_KEYS } from "./guards/committee";
import { liveRolesGuard } from "./guards/liveRoles";
import { minilmGuard } from "./guards/minilm";
import { regimeAltGuard } from "./guards/regimeAlt";
import { sweepGuard } from "./guards/sweep";

export { committeeRefusal } from "./guards/committee";

/** Null when `value` may be set now, else the refusal text. */
export type Guard = (db: Pick<Client, "execute">, value: unknown) => Promise<string | null>;

/** The registry: the guarded keys and their guards (an absent key has none). */
export const GUARDS: Readonly<Partial<Record<ConfigKey, Guard>>> = {
  committee_enabled: committeeGuard,
  ...Object.fromEntries(FROZEN_TRIAL_KEYS.map((k) => [k, frozenTrialGuard])),
  llm_live_roles: liveRolesGuard,
  minilm_enabled: minilmGuard,
  regime_altinputs_enabled: regimeAltGuard,
  intraday_sweep_enabled: sweepGuard,
};

/** Null when `key` may take `value` now, else the refusal text. A failed read refuses (fails closed). */
export async function switchRefusal(
  db: Pick<Client, "execute">,
  key: string,
  value: unknown,
): Promise<string | null> {
  const guard = Object.prototype.hasOwnProperty.call(GUARDS, key)
    ? GUARDS[key as ConfigKey]
    : undefined;
  return guard === undefined ? null : guard(db, value);
}
