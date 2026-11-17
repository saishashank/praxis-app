// The shadow regime reading (M22 E5, DAT-248, D-1440, D-1441): one row per market and session in `regime_alt_reading`, written
// by the one call batch 3 makes. It reads the day's base state (regime_daily, written by batch 2b) and the alt inputs, applies
// the pure rule and stores both states. It writes that one table only and returns nothing the gate reads: the base state, the
// regime row and every score input are untouched (tests/regime/alt/shadow.test.ts proves it byte for byte). Append-only, insert
// once per day; a re-run changes nothing. With no readable input the status is `unavailable` and the alt state equals the base.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { regimeLabel } from "@/lib/view/terms";
import { readAltInputs, type AltInputs } from "./inputs";
import { altState } from "./rule";

type Exec = Pick<Client, "execute">;

const JSON_MAX = 4000; // threshold-ok: regime_alt_reading.inputs_json CHECK length
const ENTRIES_MAX = 12; // threshold-ok: entries per kind kept in the stored text so it fits the column

export type AltNightResult =
  | { status: "written"; base: string; alt: string; inputs: AltInputs["status"] }
  | { status: "already_done" }
  | { status: "no_base" };

/** The stored text of the inputs: the newest points, capped to fit the column. */
export function inputsJson(i: AltInputs): string {
  let n = ENTRIES_MAX;
  for (;;) {
    const text = JSON.stringify({
      predictions: i.predictions.slice(0, n).map((p) => [p.source, p.eventKey, p.d, p.probPpm]),
      macro: i.macro.slice(0, n).map((m) => [m.source, m.seriesId, m.d, m.valueMicro]),
      accepted: i.enabledPrediction,
    });
    if (text.length <= JSON_MAX || n === 0) return text.length <= JSON_MAX ? text : "{}";
    n -= 1;
  }
}

/** The base state of the session: the newest rule version's regime_daily row of the day, or null. */
export async function baseStateOf(db: Exec, market: string, d: string): Promise<string | null> {
  // rows-ok: regime_daily primary key (market, d, version) prefix, newest version, LIMIT 1
  const r = await db.execute({
    sql: "SELECT state FROM regime_daily WHERE market = ? AND d = ? ORDER BY version DESC LIMIT 1",
    args: [market, d],
  });
  return r.rows[0] === undefined ? null : String(r.rows[0].state);
}

/** The one call of batch 3: writes the session's reading. Idempotent on (market, d). */
export async function altRegimeNight(
  db: Exec,
  o: { market: string; d: string; now: string },
): Promise<AltNightResult> {
  const base = await baseStateOf(db, o.market, o.d);
  if (base === null) return { status: "no_base" };
  const inputs = await readAltInputs(db, { market: o.market, d: o.d });
  const alt = altState(base, inputs);
  // rows-ok: one insert, primary key (market, d); a repeat is ignored
  const w = await db.execute({
    sql: `INSERT INTO regime_alt_reading (market, d, base_state, alt_state, inputs_status, inputs_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [o.market, o.d, base, alt, inputs.status, inputsJson(inputs), o.now],
  });
  return w.rowsAffected === 0
    ? { status: "already_done" }
    : { status: "written", base, alt, inputs: inputs.status };
}

export type AltReading = {
  d: string;
  base: string;
  alt: string;
  inputsStatus: "ok" | "partial" | "unavailable";
};

/** The newest stored reading of a market, or null. */
export async function latestAltReading(db: Exec, market: string): Promise<AltReading | null> {
  // rows-ok: regime_alt_reading primary key (market, d), newest first, LIMIT 1
  const r = await db.execute({
    sql: `SELECT d, base_state, alt_state, inputs_status FROM regime_alt_reading
           WHERE market = ? ORDER BY d DESC LIMIT 1`,
    args: [market],
  });
  const x = r.rows[0];
  if (x === undefined) return null;
  return {
    d: String(x.d),
    base: String(x.base_state),
    alt: String(x.alt_state),
    inputsStatus: String(x.inputs_status) as AltReading["inputsStatus"],
  };
}

/** The plain-words line of the Cortex page (D-1441), from a reading. */
export function regimeLineOf(r: AltReading): string {
  return `Regime: ${regimeLabel(r.base).shown}; with outside signals: ${regimeLabel(r.alt).shown} (shadow)`;
}

/** The page's line: null while the switch is not "on" or while no reading is stored. A failed read is null, never a throw. */
export async function loadRegimeLine(db: Exec, market: string): Promise<string | null> {
  try {
    if ((await getConfig(db as Client, "regime_altinputs_enabled")) !== "on") return null;
    const r = await latestAltReading(db, market);
    return r === null ? null : regimeLineOf(r);
  } catch {
    return null;
  }
}
