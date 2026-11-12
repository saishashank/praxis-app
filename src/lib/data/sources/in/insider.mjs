// SEBI insider-trading disclosures (M20 IN1; DAT-243 e, DAT-130): PIT (Prohibition of Insider Trading) and SAST
// (takeover) intimations. Input is a CSV the fetch step builds from the exchange's disclosure listing:
// `symbol, person_category, transaction_type, value_inr, intimation_dt, ref`. A promoter or director BUY or SELL is a
// `director_buy` / `director_sell` notice (the director-trade split is UNBLOCKED for India, D-1115); other transaction
// types (pledge, invocation, revoke, ESOP) are not directional and are skipped. A SAST acquisition or disposal row
// (`person_category` = "Acquirer") is a substantial-holder notice. `value_micro` is rupees x 10^6, NULL when the
// value is not given. `ann_id` is the disclosure's own reference, so a re-run inserts nothing.
import { csvObjects, microOfDecimal, nseDateTime, istToUtcIso } from "./parse.mjs";

export const SOURCE = "in_sebi_pit_sast";
export const PARSER_VERSION = "in-pit-1";

const INSIDER = /promoter|director|key managerial|designated|employee|immediate relative/i;

/** @param {string} text @returns {{ rows: any[], skipped: number }} */
export function parseInsiderNotices(text, o) {
  const rows = [];
  let skipped = 0;
  for (const r of csvObjects(text)) {
    const code = r.symbol;
    const ref = r.ref;
    const when = nseDateTime(r.intimation_dt ?? "");
    if (!code || !ref || when === null) {
      skipped += 1;
      continue;
    }
    const tx = (r.transaction_type ?? "").toLowerCase();
    const who = r.person_category ?? "";
    let kind = null;
    if (/^acquirer$/i.test(who)) {
      kind = /dispos|sell|decrease/.test(tx)
        ? "sh_decrease"
        : /acqui|buy|increase/.test(tx)
          ? "sh_increase"
          : null;
    } else if (INSIDER.test(who)) {
      kind = /^(buy|acquisition|market purchase)/.test(tx)
        ? "director_buy"
        : /^(sell|disposal|market sale)/.test(tx)
          ? "director_sell"
          : null;
    }
    if (kind === null) {
      skipped += 1;
      continue;
    }
    const v = microOfDecimal(r.value_inr ?? "");
    rows.push({
      market: o.market,
      annId: `${SOURCE}:${ref}`,
      code,
      kind,
      valueMicro: v,
      publishedAt: istToUtcIso(when.d, when.time),
    });
  }
  return { rows, skipped };
}

/** `insider_notice` rows in the table's column order. @param {{ annId: string, code: string, kind: string, valueMicro: bigint | null, publishedAt: string, market: string }[]} rows */
export function insiderRows(rows) {
  return rows.map((r) => [
    r.market,
    r.annId,
    r.code,
    r.kind,
    r.valueMicro,
    r.publishedAt,
    PARSER_VERSION,
  ]);
}
