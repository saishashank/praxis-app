// The NSE daily bhavcopy, "UDiFF" common format (M20 IN1; DAT-243 a, D-1132): the India price source. One CSV per
// session on the exchange's archive host. Rows are the cash segment's equity series only (EQ, BE, BZ, SM, ST); gold
// bonds, gilts and debt series are not bars of this universe. Prices are decimal text converted to REAL exactly as the
// AU feed stores them; volume is a whole number of shares. `published_at` is the session close plus the profile's bar
// latency (known_time_rules.bars = close_plus_latency), never the fetch time.
import { csvObjects, isIsoDate, istToUtcIso, microOfDecimal } from "./parse.mjs";

export const SOURCE = "in_nse_bhavcopy";
/** The equity series of the cash segment (BE = trade-for-trade, BZ = surveillance trade-for-trade, SM/ST = SME). */
export const EQUITY_SERIES = Object.freeze(["EQ", "BE", "BZ", "SM", "ST"]);

/**
 * @typedef {{ code: string, series: string, isin: string, name: string, open: number, high: number, low: number,
 *   close: number, prevClose: number | null, volume: number, tradedValue: number | null }} BhavRow
 */

const num = (/** @type {string} */ s) => {
  const m = microOfDecimal(s);
  return m === null ? null : Number(m) / 1_000_000; // money-float-ok: vendor decimal to the REAL price column
};

/**
 * Parse one bhavcopy CSV for session `d`.
 * @param {string} text @param {{ d: string }} o
 * @returns {{ rows: BhavRow[], rejected: { code: string, reason: string }[], total: number }}
 */
export function parseBhavcopy(text, o) {
  if (!isIsoDate(o.d)) throw new RangeError("bhavcopy: d must be YYYY-MM-DD");
  const raw = csvObjects(text);
  /** @type {BhavRow[]} */
  const rows = [];
  /** @type {{ code: string, reason: string }[]} */
  const rejected = [];
  const seen = new Set();
  let total = 0;
  for (const r of raw) {
    if (r.Sgmt !== "CM" || r.FinInstrmTp !== "STK") continue;
    if (!EQUITY_SERIES.includes(r.SctySrs)) continue;
    total += 1;
    const code = r.TckrSymb;
    if (r.TradDt !== o.d) {
      rejected.push({ code, reason: "other_date" });
      continue;
    }
    const open = num(r.OpnPric);
    const high = num(r.HghPric);
    const low = num(r.LwPric);
    const close = num(r.ClsPric);
    const vol = Number.parseInt(r.TtlTradgVol, 10);
    if (
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      !Number.isSafeInteger(vol)
    ) {
      rejected.push({ code, reason: "unreadable" });
      continue;
    }
    if (close <= 0 || open <= 0) {
      rejected.push({ code, reason: "no_trade" }); // a code that did not trade prints zeros
      continue;
    }
    if (seen.has(code)) {
      rejected.push({ code, reason: "duplicate" }); // the first series of a code wins
      continue;
    }
    seen.add(code);
    rows.push({
      code,
      series: r.SctySrs,
      isin: r.ISIN,
      name: r.FinInstrmNm,
      open,
      high,
      low,
      close,
      prevClose: num(r.PrvsClsgPric),
      volume: vol,
      tradedValue: num(r.TtlTrfVal),
    });
  }
  return { rows, rejected, total };
}

/**
 * The `price_bar` rows (column order of the table) for a parsed day.
 * @param {BhavRow[]} rows
 * @param {{ market: string, d: string, publishedAt: string, ingestedAt: string }} o
 */
export function priceBarRows(rows, o) {
  return rows.map((r) => [
    o.market,
    r.code,
    o.d,
    r.open,
    r.high,
    r.low,
    r.close,
    r.volume,
    SOURCE,
    o.publishedAt,
    o.ingestedAt,
  ]);
}

/**
 * The instant a bar is known: the session close (local IST) plus the latency, as a UTC ISO instant.
 * @param {string} d @param {string} closeLocal HH:MM @param {number} latencyMin
 */
export function barPublishedAt(d, closeLocal, latencyMin) {
  const base = Date.parse(istToUtcIso(d, closeLocal));
  return new Date(base + latencyMin * 60_000).toISOString();
}
