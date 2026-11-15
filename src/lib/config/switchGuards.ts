// Switch guards (M21 A1, D-1213): a key-specific refusal of an Owner edit, called by `updateConfig` right after the
// Lane-B lock. The Committee switch (AGT-145, D-938) can be turned on only when the stored steelman health shows ten
// qualifying nights at the case-writing check of 98 % or better (BLD-041); every other key and value passes. Read-only:
// one bounded keyset read of the newest ten night rows (the read the health line uses), nothing is written.
import type { Client } from "@libsql/client";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import { NIGHTS_NEEDED, steelmanHealthOf } from "@/lib/health/steelman";
import { readNights } from "@/lib/steelman/store";

/** The refusal text of the Committee switch for `qualifying` nights of the ten needed. */
export const committeeRefusal = (qualifying: number): string =>
  `The Committee can be switched on after ${NIGHTS_NEEDED} nights with the case-writing check at 98 % or better (${qualifying} of ${NIGHTS_NEEDED} so far)`;

/** Null when `key` may take `value` now, else the refusal text. A failed read refuses (fails closed). */
export async function switchRefusal(
  db: Pick<Client, "execute">,
  key: string,
  value: unknown,
): Promise<string | null> {
  if (key !== "committee_enabled" || value !== "on") return null;
  try {
    // rows-ok: steelman_night primary key (market, d) read newest-first, LIMIT 10
    const health = steelmanHealthOf(await readNights(db, HOME_MARKET, NIGHTS_NEEDED));
    return health.qualifying >= NIGHTS_NEEDED ? null : committeeRefusal(health.qualifying);
  } catch {
    return committeeRefusal(0);
  }
}
