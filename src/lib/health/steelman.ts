// BLD-041 / D-493: the steelman's evidence line for System Health. The M12 gate needs 10 nights with
// claim validity of at least 98 %; production has no R6 model wired (D-480), so the line reads
// "pending production" until the Owner wires a live router after the bake-off. Read-only over
// `steelman_night`; one line, no LLM, nothing here can change a card, an order or a rule.
import { readNights, type Exec, type NightRow } from "@/lib/steelman/store";

export const NIGHTS_NEEDED = 10; // threshold-ok: BLD-041 "10 nights"
export const VALIDITY_MIN_PPM = 980_000; // threshold-ok: BLD-041 "claim validity at least 98 %"

export type SteelmanHealth = {
  /** "attention" only when the table cannot be read; a missing model is expected, not a fault. */
  state: "ok" | "attention";
  /** Nights stored, the last NIGHTS_NEEDED counted. */
  nights: number;
  qualifying: number;
  text: string;
};

/** Pure: the line from the stored night rows (newest first). */
export function steelmanHealthOf(rows: readonly NightRow[]): SteelmanHealth {
  const window = rows.slice(0, NIGHTS_NEEDED);
  const qualifying = window.filter(
    (r) => r.written > 0 && r.claimsTotal > 0 && r.validityPpm >= VALIDITY_MIN_PPM,
  ).length;
  // `rows` is the window only (readNights limits it), so the count is "over these nights", not ever.
  const written = window.reduce((n, r) => n + r.written, 0);
  const base = `Steelman: ${qualifying} ${qualifying === 1 ? "night" : "nights"} at 98 % or better, ${NIGHTS_NEEDED} needed`;
  if (qualifying >= NIGHTS_NEEDED) {
    return { state: "ok", nights: rows.length, qualifying, text: `${base}; evidence complete.` };
  }
  const why =
    rows.length === 0
      ? "no night recorded yet"
      : written === 0
        ? "no model wired, none written"
        : `${written} written over the last ${window.length} ${window.length === 1 ? "night" : "nights"}`;
  return {
    state: "ok",
    nights: rows.length,
    qualifying,
    text: `${base}, pending production (${why}).`,
  };
}

/** The line for a market; a failed read says so instead of throwing. */
export async function loadSteelmanHealth(db: Exec, market: string): Promise<SteelmanHealth> {
  try {
    return steelmanHealthOf(await readNights(db, market, NIGHTS_NEEDED));
  } catch {
    return {
      state: "attention",
      nights: 0,
      qualifying: 0,
      text: "Steelman: night counters could not be read.",
    };
  }
}
