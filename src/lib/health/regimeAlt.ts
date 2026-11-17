// System Health: the shadow regime reading with outside signals (M22 E5, DAT-248, D-1441). Owner only, plain words, read only.
// Lines:
//   "Outside signals on the market mood: off"
//   "Outside signals on the market mood: on, no reading stored yet"
//   "Outside signals on the market mood: on, no outside signals available yet (none of the sources is accepted)"
//   "Outside signals on the market mood: on, the reading differs from the base on 3 of the last 20 sessions"
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import { moreCautious } from "@/lib/regime/alt/rule";
import { latestAltReading } from "@/lib/regime/alt/shadow";

export type RegimeAltHealth = { state: "ok" | "attention"; line: string };

const PREFIX = "Outside signals on the market mood";
const WINDOW = 20; // threshold-ok: sessions counted in the health line

/** Pure: the line from the switch, the newest reading's input status and the differing count over the window. */
export function regimeAltHealthOf(x: {
  enabled: boolean;
  latest: { inputsStatus: "ok" | "partial" | "unavailable" } | null;
  differing: number;
  sessions: number;
}): RegimeAltHealth {
  if (!x.enabled) return { state: "ok", line: `${PREFIX}: off` };
  if (x.latest === null) return { state: "ok", line: `${PREFIX}: on, no reading stored yet` };
  if (x.latest.inputsStatus === "unavailable")
    return {
      state: "ok",
      line: `${PREFIX}: on, no outside signals available yet (none of the sources is accepted)`,
    };
  const n = x.sessions === 1 ? "session" : "sessions";
  return {
    state: "ok",
    line: `${PREFIX}: on, the reading differs from the base on ${x.differing} of the last ${x.sessions} ${n}`,
  };
}

/** Reads the switch and the newest sessions; a failed read is an attention line, never a throw. */
export async function loadRegimeAltHealth(db: Pick<Client, "execute">): Promise<RegimeAltHealth> {
  try {
    const enabled = (await getConfig(db, "regime_altinputs_enabled")) === "on";
    if (!enabled) return regimeAltHealthOf({ enabled, latest: null, differing: 0, sessions: 0 });
    const latest = await latestAltReading(db, HOME_MARKET);
    // rows-ok: regime_alt_reading primary key (market, d), newest first, LIMIT 20
    const r = await db.execute({
      sql: "SELECT base_state, alt_state FROM regime_alt_reading WHERE market = ? ORDER BY d DESC LIMIT ?",
      args: [HOME_MARKET, WINDOW],
    });
    const differing = r.rows.filter((x) =>
      moreCautious(String(x.base_state), String(x.alt_state)),
    ).length;
    return regimeAltHealthOf({ enabled, latest, differing, sessions: r.rows.length });
  } catch {
    return { state: "attention", line: `${PREFIX}: its state could not be read` };
  }
}
