// Lane-B keys are read-only after the v1 seed (M6 decision 45 / D-110): once a rule version exists,
// the B keys of ch.15 §15.3 are no longer edited in the configuration editor. A change is a new
// version (an Owner edit becomes an `owner`-origin version that enters Lane B, KB-050), so a config
// edit cannot change live rules silently. The lock lives here, apart from ./ruleVersions.ts, so the
// config store can import it without the rule table.
import type { Client } from "@libsql/client";
import { CONFIG_KEYS } from "@/lib/config/keys";

/** True once any rule version exists: from then on the B keys change only as new versions. */
export async function ruleVersionsSeeded(db: Client): Promise<boolean> {
  try {
    const r = await db.execute("SELECT 1 FROM rule_version LIMIT 1");
    return r.rows.length > 0;
  } catch {
    return false; // a database without migration 0010: nothing is seeded
  }
}

export const B_KEY_LOCKED_MESSAGE =
  "This setting now changes only as a new rule version (Lane B); a configuration edit would change live rules silently.";

/** The Lane-B keys (ch.15 §15.3), the ones the lock covers. */
export function isLaneBKey(key: string): boolean {
  return (CONFIG_KEYS as Record<string, { editable: string }>)[key]?.editable === "B";
}

/** Null when the key may be edited now, else the refusal text (D-110 decision 45). */
export async function configEditRefusal(db: Client, key: string): Promise<string | null> {
  if (!isLaneBKey(key)) return null;
  return (await ruleVersionsSeeded(db)) ? B_KEY_LOCKED_MESSAGE : null;
}
