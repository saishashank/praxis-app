// The NSE ASM and GSM lists (M20 IN1; DAT-243 g, D-1109 trigger 3): two JSON files fetched on the session, each the
// membership as of that day. ASM: `{ longterm: { data: [...] }, shortterm: { data: [...] } }`, each row with
// `symbol`, `survCode` (e.g. "LTASM - I (13)"). GSM: an array of rows with `symbol` and `survCode`
// (e.g. "GSM - VI (6)"). The stage stored is the number in the parentheses of `survCode` (the exchange's own stage
// code), NULL when absent. A code on both lists keeps one row per list.
export const SOURCE = "in_nse_asm_gsm";

/** @param {unknown} survCode */
const stageOf = (survCode) => {
  const m = /\((\d{1,3})\)\s*$/.exec(String(survCode ?? ""));
  return m === null ? null : Number.parseInt(m[1], 10);
};

/** @param {any[]} data @returns {{ code: string, stage: number | null }[]} */
function dedupe(data) {
  /** @type {Map<string, { code: string, stage: number | null }>} */
  const out = new Map();
  for (const r of data) {
    const code = typeof r?.symbol === "string" ? r.symbol.trim() : "";
    if (code === "" || out.has(code)) continue;
    out.set(code, { code, stage: stageOf(r.survCode) });
  }
  return [...out.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
}

/** @param {unknown} json @returns {{ code: string, stage: number | null }[]} */
export function parseAsm(json) {
  const o = /** @type {any} */ (json);
  return dedupe([...(o?.longterm?.data ?? []), ...(o?.shortterm?.data ?? [])]);
}

/** @param {unknown} json @returns {{ code: string, stage: number | null }[]} */
export function parseGsm(json) {
  return dedupe(Array.isArray(json) ? json : []);
}

/**
 * `surveillance_list` rows in the table's column order.
 * @param {{ asm: { code: string, stage: number | null }[], gsm: { code: string, stage: number | null }[] }} lists
 * @param {{ market: string, d: string }} o
 */
export function surveillanceRows(lists, o) {
  return [
    ...lists.asm.map((r) => [o.market, r.code, o.d, "ASM", r.stage, SOURCE]),
    ...lists.gsm.map((r) => [o.market, r.code, o.d, "GSM", r.stage, SOURCE]),
  ];
}
