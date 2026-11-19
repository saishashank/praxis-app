// The shadow short switch (M21 R1; VAL-121, D-1228, D-1295). OFF unless a market's row says "on". The value is read from the
// versioned config table by key, per market scope; it is not a registered Owner setting (the nine M21 keys are fixed), so
// nothing on the Settings page can turn it on and a fresh database has no row. A market with no short-sale rules is off.
import type { Client } from "@libsql/client";
import { hasShortRules } from "@/lib/market/seed/shortRules.mjs";

export const SHORT_SHADOW_KEY = "short_shadow_enabled";

export async function shortShadowEnabled(db: Client, market: string): Promise<boolean> {
  if (!hasShortRules(market)) return false;
  // rows-ok: one key probe on (key, scope), newest row first
  const rs = await db.execute({
    sql: "SELECT value_json FROM config_version WHERE key = ? AND scope = ? ORDER BY id DESC LIMIT 1",
    args: [SHORT_SHADOW_KEY, market],
  });
  if (rs.rows.length === 0) return false;
  try {
    return JSON.parse(String(rs.rows[0]!.value_json)) === "on";
  } catch {
    return false;
  }
}
