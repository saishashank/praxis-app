// The database client of every Actions script and command line (M20 A2, D-1123; closes D-1020 and D-1086): a libsql
// client wrapped with the write guard's error mapping (src/lib/market/guard.mjs `wrapClient`) and the refusal
// reporter, so a script write for a market that is not enabled surfaces as the typed `MarketNotEnabled` and opens
// ONE S2 `market_not_enabled` incident, exactly as the app's `mainDb()` does. Plain ESM (no alias, no TypeScript):
// the scripts run under plain `node`, and the TypeScript command lines (arena, replay, picks) import it too.
//
//   scriptDb({ url, token, intMode })   the wrapped client. `token` may be absent for a file: or :memory: URL.
//   marketRefusalReporter(raw, now)     the `onRefusal` hook (best effort, never throws)
//   resetMarketRefusalReports()         test hook: forget the once-per-market-per-day memory
//
// The incident is written through the RAW client (the `incident` table has no market column, the guard is not in
// its way) with the same guarded INSERT as `notifyIncident` (one open incident per kind). A script sends no
// e-mail (no e-mail environment), so the incident row is the record, which System Health shows.
import { createClient } from "@libsql/client";
import { wrapClient } from "../market/guard.mjs";
import {
  REFUSAL_KIND,
  REFUSAL_SEVERITY,
  refusalIncidentStatement,
  refusalKey,
} from "../market/refusalIncident.mjs";

export { REFUSAL_KIND, REFUSAL_SEVERITY };

const reported = new Set();

/**
 * The incident writer for a refused write: at most once per market per process-day here (the incident itself opens
 * once while unresolved), best effort, never throws.
 * @param {{ execute: (s: any) => Promise<unknown> }} raw
 * @param {() => Date} [now]
 */
export function marketRefusalReporter(raw, now = () => new Date()) {
  /** @param {{ market: string }} err @param {{ table: string | null }} info */
  return async (err, info) => {
    try {
      const at = now();
      const key = refusalKey(at, err.market);
      if (reported.has(key)) return;
      reported.add(key);
      await raw.execute(refusalIncidentStatement(at, err.market, info.table));
    } catch {
      /* best effort */
    }
  };
}

/** Test hook: forget which refusals were reported. */
export function resetMarketRefusalReports() {
  reported.clear();
}

/**
 * The wrapped client of a script. Throws a fixed-word error (never the URL or the token) when no URL is given or a
 * remote URL has no token.
 * @param {{ url: string | undefined, token?: string | undefined, intMode?: "bigint" }} o
 */
export function scriptDb(o) {
  const url = typeof o?.url === "string" ? o.url.trim() : "";
  const token = typeof o?.token === "string" && o.token.trim() !== "" ? o.token : undefined;
  if (url === "") throw new Error("database not configured");
  const raw = createClient({
    url,
    ...(token !== undefined ? { authToken: token } : {}),
    ...(o.intMode ? { intMode: o.intMode } : {}),
  });
  return wrapClient(raw, marketRefusalReporter(raw));
}
