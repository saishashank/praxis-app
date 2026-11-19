// The Nifty 50 and India VIX bars (M20 IN1; DAT-243, CXA-002 h, D-1132). The only free robots-permitted source is a
// manual CSV upload (register `in_nse_indices_manual`, enabled): `index_code, d, open, high, low, close`, codes NSEI and
// INDIAVIX (the profile's `benchmark_index`, `regime_index` and `volatility_index`). The index and VIX series were NOT
// PULLED into the extract (Yahoo is refused by robots.txt, D-1132); a night with no index file reads "no index" and
// the Cortex gates that need them stay unmeasured (D-1173). Nothing is ever synthesised.
import { csvObjects, isIsoDate, istToUtcIso, microOfDecimal } from "./parse.mjs";

export const SOURCE = "in_nse_indices_manual";

/**
 * @param {string} text @param {{ market: string, codes: readonly string[], closeLocal: string, latencyMin: number }} o
 * @returns {{ rows: { indexCode: string, d: string, o: bigint, h: bigint, l: bigint, c: bigint, publishedAt: string }[], skipped: number }}
 */
export function parseIndexCsv(text, o) {
  /** @type {any[]} */
  const rows = [];
  let skipped = 0;
  for (const r of csvObjects(text)) {
    const v = [r.open, r.high, r.low, r.close].map((x) => microOfDecimal(x ?? ""));
    if (!o.codes.includes(r.index_code) || !isIsoDate(r.d ?? "") || v.some((x) => x === null)) {
      skipped += 1;
      continue;
    }
    const base = Date.parse(istToUtcIso(r.d, o.closeLocal));
    rows.push({
      indexCode: r.index_code,
      d: r.d,
      o: v[0],
      h: v[1],
      l: v[2],
      c: v[3],
      publishedAt: new Date(base + o.latencyMin * 60_000).toISOString(),
    });
  }
  return { rows, skipped };
}

/** `index_bar` rows in the table's column order. @param {any[]} rows */
export function indexBarRows(rows, o) {
  return rows.map((r) => [
    o.market,
    r.indexCode,
    r.d,
    r.o,
    r.h,
    r.l,
    r.c,
    SOURCE,
    r.publishedAt,
    o.ingestedAt,
  ]);
}
