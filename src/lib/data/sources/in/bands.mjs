// The NSE daily price-band file (M20 IN1; DAT-243 f, ARN-117): one CSV per session, `Symbol, Series, Security Name,
// Band, Remarks`. `Band` is the whole-percent limit (2, 5, 10, 20) or "No Band" for the F&O stocks (band_pct NULL).
// The file carries no limit prices; the limits are computed from the previous close on the tick grid when the fill
// model asks (cortex/states/bands.ts), so lower/upper stay NULL here.
import { csvObjects } from "./parse.mjs";

export const SOURCE = "in_nse_bands";

/**
 * @param {string} text
 * @returns {{ rows: { code: string, series: string, bandPct: number | null }[], rejected: number }}
 */
export function parseBands(text) {
  /** @type {{ code: string, series: string, bandPct: number | null }[]} */
  const rows = [];
  let rejected = 0;
  const seen = new Set();
  for (const r of csvObjects(text)) {
    const code = r.Symbol;
    if (code === undefined || code === "") {
      rejected += 1;
      continue;
    }
    const band = (r.Band ?? "").trim();
    /** @type {number | null} */
    let pct = null;
    if (/^\d{1,3}$/.test(band)) {
      pct = Number.parseInt(band, 10);
      if (pct < 1 || pct > 100) {
        rejected += 1;
        continue;
      }
    } else if (!/^no band$/i.test(band)) {
      rejected += 1;
      continue;
    }
    if (seen.has(code)) continue; // the file lists a code once per series; the first wins
    seen.add(code);
    rows.push({ code, series: r.Series ?? "", bandPct: pct });
  }
  return { rows, rejected };
}

/**
 * `price_band` rows in the table's column order.
 * @param {{ code: string, bandPct: number | null }[]} rows @param {{ market: string, d: string }} o
 */
export function priceBandRows(rows, o) {
  return rows.map((r) => [o.market, r.code, o.d, r.bandPct, null, null, SOURCE]);
}
