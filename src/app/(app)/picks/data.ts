// Reads of the Picks pages that are not in the loader: two config keys. A failed read falls back to
// the documented default so the page still renders (the key itself is never hard-coded as a limit).
import { getConfig } from "@/lib/config/store";
import type { Db } from "@/lib/ui/loaders/shell";

export const PICKS_MAX_PER_FAMILY_DEFAULT = 10; // threshold-ok: O-76 (10 = no cap), used only if the read fails

export async function maxPerFamily(db: Db): Promise<number> {
  try {
    const v = await getConfig(db, "picks_max_per_family");
    return typeof v === "number" && Number.isInteger(v) && v >= 1
      ? v
      : PICKS_MAX_PER_FAMILY_DEFAULT;
  } catch {
    return PICKS_MAX_PER_FAMILY_DEFAULT;
  }
}

export async function pickProfilesConfig(db: Db): Promise<unknown> {
  try {
    return await getConfig(db, "pick_profiles");
  } catch {
    return null;
  }
}
