// State `market-built-off` (TST-135 (a), D-967): asserts the PRODUCTION SHAPE of the market set in M18 - AU is
// the only market, and no other market has a `market` row or an entry in the `market_modes` configuration.
// Nothing is written: a seeded e2e database is already in that shape, and the state exists so a lane that
// names it fails loudly if a scenario ever adds a second market. M19 extends it with the `built` rows (IN and
// US built but off, MKT-107) and then asserts those instead; the harness takes the new file, no code change.
export const PRODUCTION_MARKETS = ["AU"];

/** @param {import("@libsql/client").Client} client */
export async function apply(client) {
  const rows = (await client.execute("SELECT code FROM market ORDER BY code")).rows.map((r) =>
    String(r.code),
  );
  if (JSON.stringify(rows) !== JSON.stringify(PRODUCTION_MARKETS)) {
    throw new Error(
      `market-built-off: expected markets ${PRODUCTION_MARKETS.join(",")}, found ${rows.join(",") || "none"}`,
    );
  }
  const modes = await client.execute(
    "SELECT value_json FROM config_version WHERE key = 'market_modes' ORDER BY id DESC LIMIT 1",
  );
  if (modes.rows.length > 0) {
    const keys = Object.keys(JSON.parse(String(modes.rows[0].value_json)) ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(PRODUCTION_MARKETS)) {
      throw new Error(`market-built-off: market_modes names ${keys.join(",")}`);
    }
  }
}
