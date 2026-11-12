// India macro series (M20 IN1; DAT-243 macro): the RBI reference rate and policy rate and the MOSPI CPI. The exchange-
// style pages are JavaScript shells (the A3 pass and the extract show no data table in the served HTML), so the fetch
// step reduces a page to a small CSV `series_id, d, value` and this module parses that. The rows are PARSED and
// COUNTED but NOT STORED: `macro_series.source` is CHECK-limited to ('rba','abs') (migration 0033) and widening it is a
// schema change outside IN1 (D-1171). The day stage reports `not_stored` with the count, never a made-up source name.
import { csvObjects, isIsoDate, microOfDecimal } from "./parse.mjs";

export const SERIES = Object.freeze(["RBI_REPO", "RBI_REF_USDINR", "MOSPI_CPI"]);

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
