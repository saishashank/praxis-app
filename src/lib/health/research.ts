// System Health: the research line (M23 M4, D-1643, D-1764). One plain line: how many of the eight risk monitors have an open
// alarm in their newest reading and how many second looks at a finished test were refused. Read only; a failed read is an
// attention line, never a throw. An alarm is an Owner item on its own path, so open alarms do not turn the line to attention.
import type { Client } from "@libsql/client";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";

export type ResearchHealth = { state: "ok" | "attention"; line: string };

const PREFIX = "Research tests and risk monitors";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Pure: the line from the two counts. */
export function researchHealthOf(x: { alarms: number; refusals: number }): ResearchHealth {
  const alarms = x.alarms === 0 ? "no open alarm" : plural(x.alarms, "open alarm", "open alarms");
  const refused =
    x.refusals === 0
      ? "no second look refused"
      : `${plural(x.refusals, "second look", "second looks")} refused`;
  return { state: "ok", line: `${PREFIX}: ${alarms}, ${refused}` };
}

/** Reads the newest reading of each monitor and the refusal count of the home market. */
export async function loadResearchHealth(db: Pick<Client, "execute">): Promise<ResearchHealth> {
  try {
    // rows-ok: one statement, two counts: residual_monitor by primary key (each monitor's newest quarterly row, at most 8 alarms)
    // and holdout_look_refusal, append-only and tiny (a row only per refused repeat look)
    const r = await db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM residual_monitor r
                WHERE r.market = ?1 AND r.alarm = 1
                  AND (r.period GLOB 'cal-*' OR r.period = (SELECT MAX(x.period) FROM residual_monitor x
                        WHERE x.market = r.market AND x.monitor = r.monitor AND x.period GLOB '[0-9]*'))) AS alarms,
              (SELECT COUNT(*) FROM holdout_look_refusal WHERE market = ?1) AS refusals`,
      args: [HOME_MARKET],
    });
    return researchHealthOf({
      alarms: Number(r.rows[0]?.alarms ?? 0),
      refusals: Number(r.rows[0]?.refusals ?? 0),
    });
  } catch {
    return { state: "attention", line: `${PREFIX}: their state could not be read` };
  }
}
