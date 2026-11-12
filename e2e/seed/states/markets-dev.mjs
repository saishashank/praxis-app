// Development lanes only (M19 E2, D-994, D-1077, UXN-312): `PRAXIS_MARKETS_ENABLED=AU,IN,US` enables every built market
// in the throwaway e2e database, so the header switcher and the Markets table can be seen with more than one market.
// It is NOT one of the production-shape states of `E2E_STATES=all` (it contradicts `market-built-off`, which fails
// when a second market is enabled); e2e/prepare-db.mjs applies it after the states, and only when the variable is
// set. The mode stays `off` (a freshly enabled market collects nothing until the Owner switches it on, M20), so no
// row of IN or US is written. Idempotent. Never run against a real database: the e2e files are local.
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
export async function apply(client, _nowIso, env = process.env) {
  const wanted = marketsFromEnv(env);
  for (const code of wanted) {
    await client.execute({ sql: "UPDATE market SET enabled = 1 WHERE code = ?", args: [code] });
  }
  const rows = await client.execute("SELECT code FROM market WHERE enabled = 1 ORDER BY code");
  return rows.rows.map((r) => String(r.code));
}
