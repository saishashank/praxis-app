// The incident of a refused write for a market that is not enabled (M20 A2, D-1123; D-995): ONE definition of its
// statement and its once-per-market-per-day key, shared by the script client (src/lib/db/scriptClient.mjs), the
// app's `mainDb()` reporter and the Worker's Turso pipeline (worker/src/db.ts). Pure, no client import, so the
// Worker bundle can take it. The row is the record of `notifyIncident` without e-mail (S2, one open incident per
// kind): the guarded INSERT leaves an unresolved incident alone.

export const REFUSAL_KIND = "market_not_enabled";
export const REFUSAL_SEVERITY = "S2";

/**
 * The guarded INSERT of the incident.
 * @param {Date} at
 * @param {string} market
 * @param {string | null} table
 * @returns {{ sql: string, args: (string | number | null)[] }}
 */
export function refusalIncidentStatement(at, market, table) {
  return {
    // rows-ok: one guarded insert, no read of a data table
    sql:
      "INSERT INTO incident (at, severity, kind, detail_json) SELECT ?, ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM incident WHERE kind = ? AND resolved_at IS NULL)",
    args: [
      at.toISOString(),
      REFUSAL_SEVERITY,
      REFUSAL_KIND,
      JSON.stringify({ market, table }),
      REFUSAL_KIND,
    ],
  };
}

/** The once-per-market-per-day memory key. */
export function refusalKey(at, market) {
  return `${market}|${at.toISOString().slice(0, 10)}`;
}
