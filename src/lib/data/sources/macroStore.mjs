// Macro-series storage for a built market (M20 integration; D-1147, closes the hand-offs of D-1171 and D-1189).
// `macro_series` is keyed by (source, series_id, d) and has no `market` column: migration 0037 widened its `source`
// list to the India sources (`rbi`, `mospi`) and the US one (`fred`) and guards them with two source triggers
// (`rbi`/`mospi` need IN enabled, `fred` needs US enabled; `MarketNotEnabled macro_series`). This writer is the ONE
// path the India day stage and the US day stage use:
//   - `assertMarketEnabled(db, market)` FIRST (MKT-110 a): under the production seed it throws before any statement;
//   - the home macro convention (scripts/macro/lib.mjs): an upsert that changes a stored row only when its value
//     differs (statistics are revised; a re-run with the same numbers writes nothing), never `source`;
//   - bounded: at most 100 rows per statement, no OFFSET, counts only in the return value.
// The caller names the source per row (the India module derives it from the series id; the US module stores `fred`).
import { assertMarketEnabled } from "../../market/guard.mjs";

const ROWS_PER_STATEMENT = 100;
const SERIES_RE = /^[A-Za-z0-9_]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @typedef {{ source: string, seriesId: string, d: string, valueMicro: bigint }} MacroRow */

/**
 * The rows that can be stored: a known source word, a series id of the table's shape, an ISO day, a bigint value.
 * Anything else is counted, never guessed.
 * @param {readonly MacroRow[]} rows @param {readonly string[]} sources the source words this caller may write
 * @returns {{ rows: MacroRow[], skipped: number }}
 */
export function storableMacroRows(rows, sources) {
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    if (
      !sources.includes(r.source) ||
      typeof r.seriesId !== "string" ||
      !SERIES_RE.test(r.seriesId) ||
      typeof r.d !== "string" ||
      !DATE_RE.test(r.d) ||
      typeof r.valueMicro !== "bigint"
    ) {
      skipped += 1;
      continue;
    }
    out.push({ source: r.source, seriesId: r.seriesId, d: r.d, valueMicro: r.valueMicro });
  }
  return { rows: out, skipped };
}

/**
 * Store the rows of a market's macro sources. Returns the number of rows inserted or revised.
 * @param {{ execute: Function, batch: Function }} db
 * @param {string} market the market the sources belong to (the guard's code)
 * @param {readonly MacroRow[]} rows
 * @param {string} fetchedAt ISO instant
 */
export async function writeMacroSeries(db, market, rows, fetchedAt) {
  await assertMarketEnabled(db, market);
  if (rows.length === 0) return 0;
  const stmts = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const slice = rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      // rows-ok: at most 100 keyed upserts per statement (a market's macro day is a few dozen rows); a stored row changes
      // only when its value differs, as the home macro writer does; `source` is never updated (the 0037 guard holds)
      sql:
        "INSERT INTO macro_series (source, series_id, d, value_micro, fetched_at) VALUES " +
        slice.map(() => "(?, ?, ?, ?, ?)").join(", ") +
        " ON CONFLICT (source, series_id, d) DO UPDATE SET value_micro = excluded.value_micro, " +
        "fetched_at = excluded.fetched_at WHERE macro_series.value_micro <> excluded.value_micro",
      args: slice.flatMap((r) => [r.source, r.seriesId, r.d, r.valueMicro, fetchedAt]),
    });
  }
  const res = await db.batch(stmts, "write");
  return res.reduce((a, r) => a + r.rowsAffected, 0);
}
