// The source register rows of a market, written when the market leaves `off` (M20 A3; D-1096, D-1128).
// India and the US define their rows in src/lib/market/seed/{in,us}/sources.mjs; no migration inserts them (the AT-32
// baseline hashes source_register, its history and source_status, so a row in production would move AU's own
// hashes, and production keeps the AU register only while IN and US are off). The switch-on writer (task S1) calls
// `ensureMarketSources(db, market)` in the same batch window as the `market` update; development mode and the
// `recorded-day-dev` job call it in their setup. AU has no rows here: the call writes nothing for it.
//
//   - one `source_register` row per source, `INSERT OR IGNORE`: a row that exists (the Owner may have changed its
//     status) is never touched, so a second call, or a call after a switch-off and on again, writes nothing;
//   - the register's AFTER INSERT trigger writes the `source_register_history` row (op `insert`), so a row and its
//     history row appear together;
//   - one `source_status` row per source, mode `on`, `INSERT OR IGNORE`.
// No network, no secret, no contact value.
import { marketSourcesOf } from "../../market/seed/sourceSites.mjs";

/**
 * @param {{ execute: Function, batch: Function }} db
 * @param {string} market a market code; one without source rows (AU) writes nothing
 * @param {{ now?: () => Date }} [o]
 * @returns {Promise<{ market: string, sources: number, inserted: number, existing: number }>}
 */
export async function ensureMarketSources(db, market, o = {}) {
  const rows = marketSourcesOf(market);
  if (rows.length === 0) return { market, sources: 0, inserted: 0, existing: 0 };
  const since = (o.now?.() ?? new Date()).toISOString();
  const marks = rows.map(() => "?").join(", ");
  // rows-ok: at most 25 primary-key lookups of this market's own register ids
  const have = await db.execute({
    sql: `SELECT source FROM source_register WHERE source IN (${marks})`,
    args: rows.map((r) => r.id),
  });
  const present = new Set(have.rows.map((r) => String(r.source)));
  const fresh = rows.filter((r) => !present.has(r.id));
  /** @type {{ sql: string, args: (string | number | null)[] }[]} */
  const stmts = [];
  for (const r of fresh) {
    stmts.push({
      // rows-ok: one insert per source of the market (at most 25), ignored when the row exists
      sql: `INSERT OR IGNORE INTO source_register
              (source, terms_url, permitted_use, rate_limits, last_checked, risk, status, owner_ref,
               summarisation_permitted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        r.id,
        r.terms_url,
        r.permitted_use,
        r.rate_limits,
        r.last_checked,
        r.risk,
        r.status,
        r.owner_ref,
        r.summarisation_permitted,
      ],
    });
  }
  for (const r of rows) {
    stmts.push({
      // rows-ok: one insert per source of the market (at most 25), ignored when the row exists
      sql: "INSERT OR IGNORE INTO source_status (source, mode, since) VALUES (?, 'on', ?)",
      args: [r.id, since],
    });
  }
  await db.batch(stmts, "write");
  return { market, sources: rows.length, inserted: fresh.length, existing: present.size };
}
