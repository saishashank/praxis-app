// India's short-interest PROXY (M20 IN1; DAT-243 b, DAT-125a): India publishes no daily aggregate short positions like
// the ASIC's, so the proxy is the securities-lending (SLB) open quantity as a share of the issued shares, from the
// exchange's F&O / SLB open-interest file: `symbol, slb_open_qty, issued_qty, as_of`. `short_ppm` is the share in parts
// per million, rounded half up, clamped to the table's 0..1,000,000. The `short_interest` table has no kind column, so
// the proxy is identified by its `source` (`in_nse_fo_oi`): no consumer treats it as a reported short position
// (`short_data_kind` = fo_open_interest_slb_proxy in the profile). `published_at` is the file's own time (end of the
// as-of day, IST).
import { csvObjects, isIsoDate, istToUtcIso } from "./parse.mjs";

export const SOURCE = "in_nse_fo_oi";

/** @param {string} text @param {{ market: string }} o */
export function parseFoOi(text, o) {
  const rows = [];
  let skipped = 0;
  for (const r of csvObjects(text)) {
    const slb = /^\d+$/.test(r.slb_open_qty ?? "") ? BigInt(r.slb_open_qty) : null;
    const issued = /^\d+$/.test(r.issued_qty ?? "") ? BigInt(r.issued_qty) : null;
    if (
      !r.symbol ||
      slb === null ||
      issued === null ||
      issued === 0n ||
      !isIsoDate(r.as_of ?? "")
    ) {
      skipped += 1;
      continue;
    }
    // round half up of slb x 10^6 / issued, in integers
    let ppm = Number((slb * 1_000_000n * 2n + issued) / (issued * 2n));
    if (ppm > 1_000_000) ppm = 1_000_000;
    rows.push({
      market: o.market,
      code: r.symbol,
      asOf: r.as_of,
      shortPpm: ppm,
      publishedAt: istToUtcIso(r.as_of, "23:59:59"),
    });
  }
  return { rows, skipped };
}

/** `short_interest` rows in the table's column order. @param {any[]} rows @param {string} ingestedAt */
export function shortInterestRows(rows, ingestedAt) {
  return rows.map((r) => [
    r.market,
    r.code,
    r.asOf,
    r.shortPpm,
    r.publishedAt,
    ingestedAt,
    0,
    SOURCE,
  ]);
}
