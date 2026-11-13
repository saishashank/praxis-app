// India macro series (M20 IN1; DAT-243 macro): the RBI reference rate and policy rate and the MOSPI CPI. The exchange-
// style pages are JavaScript shells (the A3 pass and the extract show no data table in the served HTML), so the fetch
// step reduces a page to a small CSV `series_id, d, value` and this module parses that. Since migration 0037 (D-1147,
// closing D-1171) the rows are STORED in `macro_series` with the source each series belongs to: `RBI_*` -> `rbi`,
// `MOSPI_*` -> `mospi` (the day stage writes them through `writeMacroSeries`, `assertMarketEnabled` first; the 0037
// source guard refuses them while India is off). A series outside the list is counted as skipped, never stored.
import { csvObjects, isIsoDate, microOfDecimal } from "./parse.mjs";

export const SERIES = Object.freeze(["RBI_REPO", "RBI_REF_USDINR", "MOSPI_CPI"]);
/** The `macro_series.source` words of this market (migration 0037). */
export const SOURCES = Object.freeze(["rbi", "mospi"]);

/** The source word of a known series id, or null. @param {string} seriesId */
export function sourceOfSeries(seriesId) {
  if (!SERIES.includes(seriesId)) return null;
  return seriesId.startsWith("MOSPI_") ? "mospi" : "rbi";
}

/** @param {string} text @returns {{ rows: { seriesId: string, d: string, valueMicro: bigint }[], skipped: number }} */
export function parseMacroCsv(text) {
  /** @type {{ seriesId: string, d: string, valueMicro: bigint }[]} */
  const rows = [];
  let skipped = 0;
  for (const r of csvObjects(text)) {
    const v = microOfDecimal(r.value ?? "");
    if (!SERIES.includes(r.series_id) || !isIsoDate(r.d ?? "") || v === null) {
      skipped += 1;
      continue;
    }
    rows.push({ seriesId: r.series_id, d: r.d, valueMicro: v });
  }
  return { rows, skipped };
}

/**
 * The parsed rows with their `macro_series` source word, ready for `writeMacroSeries`.
 * @param {{ seriesId: string, d: string, valueMicro: bigint }[]} rows
 * @returns {{ source: string, seriesId: string, d: string, valueMicro: bigint }[]}
 */
export function macroSeriesRows(rows) {
  const out = [];
  for (const r of rows) {
    const source = sourceOfSeries(r.seriesId);
    if (source === null) continue;
    out.push({ source, seriesId: r.seriesId, d: r.d, valueMicro: r.valueMicro });
  }
  return out;
}
