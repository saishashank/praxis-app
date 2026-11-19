// The US benchmark and volatility index bars (M20 US1; DAT-243, D-1132, D-1188; CXA-002 a). The two series (the
// profile's `regime_index` and `volatility_index`) have no robots-permitted free source either (Yahoo disallows
// automated clients), so they arrive as the manual CSV upload the register row `us_sp_dji_russell_manual` describes:
//   Date,Open,High,Low,Close          (one file per index; levels in index points)
// `parseIndexCsv` validates each row without repair (positive finite levels, a real date, high/low consistent), the
// writer appends to `index_bar` first-seen and append-only (the table refuses an update). `published_at` =
// `ingested_at`: no publication time is known (DAT-001). The known-time rule for another market that reads this index
// stays `D+1 09:00 Melbourne` (CXA-002 a; AU unchanged): that is the reader's, not this file's.
import { assertMarketEnabled } from "../../../market/guard.mjs";

export const INDEX_MANUAL_SOURCE = "us_index_manual";
const MICRO = 1_000_000;
const ROWS_PER_STATEMENT = 100;

/** @param {number} x level -> integer micro */
const toMicro = (x) => Math.round(x * MICRO);

/**
 * @param {string} text @param {string} indexCode the stored code (the profile's index code)
 * @returns {{ rows: { indexCode: string, d: string, o: number, h: number, l: number, c: number }[], rejected: number }}
 */
export function parseIndexCsv(text, indexCode) {
  const rows = [];
  let rejected = 0;
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (line.trim() === "") continue;
    const f = line.trim().split(",");
    const d = f[0] ?? "";
    const n = f.slice(1, 5).map(Number);
    const ok =
      f.length >= 5 &&
      /^\d{4}-\d{2}-\d{2}$/.test(d) &&
      !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
      n.every((x) => Number.isFinite(x) && x > 0) &&
      n[1] >= Math.max(n[0], n[2], n[3]) &&
      n[2] <= Math.min(n[0], n[1], n[3]);
    if (!ok) {
      rejected += 1;
      continue;
    }
    rows.push({
      indexCode,
      d,
      o: toMicro(n[0]),
      h: toMicro(n[1]),
      l: toMicro(n[2]),
      c: toMicro(n[3]),
    });
  }
  return { rows, rejected };
}

/**
 * @param {{ batch: Function }} db @param {string} market
 * @param {{ indexCode: string, d: string, o: number, h: number, l: number, c: number }[]} rows @param {string} now ISO
 * @returns {Promise<number>} rows inserted
 */
export async function writeIndexBars(db, market, rows, now) {
  await assertMarketEnabled(db, market);
  const stmts = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const slice = rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      // rows-ok: at most 100 rows per statement, one per index session, first-seen (ignored when present)
      sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
            VALUES ${slice.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")} ON CONFLICT DO NOTHING`,
      args: slice.flatMap((r) => [
        market,
        r.indexCode,
        r.d,
        r.o,
        r.h,
        r.l,
        r.c,
        INDEX_MANUAL_SOURCE,
        now,
        now,
      ]),
    });
  }
  if (stmts.length === 0) return 0;
  const res = await db.batch(stmts, "write");
  return res.reduce((a, x) => a + x.rowsAffected, 0);
}
