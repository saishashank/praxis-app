// Development lanes only (M19 E2, D-994, D-1077, UXN-312): `PRAXIS_MARKETS_ENABLED=AU,IN,US` enables every built market
// in the throwaway e2e database, so the header switcher and the Markets table can be seen with more than one market.
// It is NOT one of the production-shape states of `E2E_STATES=all` (it contradicts `market-built-off`, which fails
// when a second market is enabled); e2e/prepare-db.mjs applies it after the states, and only when the variable is
// set. The mode stays `off` (a freshly enabled market collects nothing until the Owner switches it on, M20). M20 A3
// (D-1097, D-1128): enabling a market writes what production writes when the Owner leaves `off`: its source register
// rows and two years of provisional calendar rows (`ensureMarketSources`, `ensureCalendarYears`); AU has no source
// rows here and its calendar is seeded by migration, so nothing is added for it. Idempotent. Never run against a real database: the e2e files are local.
import { ensureCalendarYears } from "../../../src/lib/data/calendarEnable.mjs";
import { ensureMarketSources } from "../../../src/lib/data/sources/marketSources.mjs";
import { marketsEnabledDefault } from "../../../src/lib/market/profileCore.mjs";

/**
 * The markets the variable asks for (a built code, AU always); unset or empty = ["AU"], the production default.
 * @param {Record<string, string | undefined>} [env]
 */
export function marketsFromEnv(env = process.env) {
  return marketsEnabledDefault(env);
}

/**
 * @param {import("@libsql/client").Client} client
 * @param {string} [_nowIso]
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<string[]>} the codes enabled after the call
 */
export async function apply(client, nowIso, env = process.env) {
  const wanted = marketsFromEnv(env);
  for (const code of wanted) {
    await client.execute({ sql: "UPDATE market SET enabled = 1 WHERE code = ?", args: [code] });
    const now = () => (nowIso === undefined ? new Date() : new Date(nowIso));
    await ensureMarketSources(client, code, { now });
    // The AU calendar is migration-seeded (its years are left alone); a market with no calendar row at all gets two years.
    const has = await client.execute({
      sql: "SELECT 1 FROM trading_calendar WHERE market = ? LIMIT 1",
      args: [code],
    });
    if (has.rows.length === 0) await ensureCalendarYears(client, code, undefined, { now });
  }
  const rows = await client.execute("SELECT code FROM market WHERE enabled = 1 ORDER BY code");
  return rows.rows.map((r) => String(r.code));
}
