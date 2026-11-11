// State `market-built-off` (TST-135 (a), D-967, MKT-107): asserts the PRODUCTION SHAPE of the market set -
// AU is the only ENABLED market; IN and US are built (they have `market` rows since migration 0034) but are
// not enabled and their mode is `off`; no other market has a row, and `market_modes` names no mode but `off`
// for a market that is not enabled. Nothing is written: a seeded e2e database is already in that shape, and
// the state exists so a lane that names it fails loudly if a scenario ever enables or adds a market.
export const PRODUCTION_MARKETS = ["AU"];
export const BUILT_MARKETS = ["AU", "IN", "US"];

/** @param {import("@libsql/client").Client} client */
export async function apply(client) {
  const rows = (await client.execute("SELECT code, enabled, mode FROM market ORDER BY code")).rows;
  const codes = rows.map((r) => String(r.code));
  if (JSON.stringify(codes) !== JSON.stringify(BUILT_MARKETS)) {
    throw new Error(
      `market-built-off: expected markets ${BUILT_MARKETS.join(",")}, found ${codes.join(",") || "none"}`,
    );
  }
  const enabled = rows.filter((r) => Number(r.enabled) === 1).map((r) => String(r.code));
  if (JSON.stringify(enabled) !== JSON.stringify(PRODUCTION_MARKETS)) {
    throw new Error(
      `market-built-off: expected markets ${PRODUCTION_MARKETS.join(",")} enabled, found ${enabled.join(",") || "none"}`,
    );
  }
  for (const r of rows) {
    if (Number(r.enabled) !== 1 && String(r.mode) !== "off") {
      throw new Error(
        `market-built-off: ${String(r.code)} is not enabled but its mode is ${String(r.mode)}`,
      );
    }
  }
  const modes = await client.execute(
    "SELECT value_json FROM config_version WHERE key = 'market_modes' ORDER BY id DESC LIMIT 1",
  );
  if (modes.rows.length > 0) {
    const map = JSON.parse(String(modes.rows[0].value_json)) ?? {};
    for (const [code, mode] of Object.entries(map)) {
      if (!PRODUCTION_MARKETS.includes(code) && mode !== "off") {
        throw new Error(`market-built-off: market_modes sets ${code} to ${String(mode)}`);
      }
    }
  }
}
