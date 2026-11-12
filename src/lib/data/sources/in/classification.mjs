// The NSE industry classification (M20 IN1; DAT-243 d, D-1112): a monthly CSV `Company Name, Industry, Symbol, Series,
// ISIN Code`. The "Industry" is the NSE industry group the NAV cap groups by (`nse_level2`); it is written to
// `instrument.industry`. A blank or "-" industry is skipped (never a guess).
import { csvObjects } from "./parse.mjs";

export const SOURCE = "in_nse_classification";

/** @param {string} text @returns {{ code: string, industry: string, name: string }[]} */
export function parseClassification(text) {
  /** @type {Map<string, { code: string, industry: string, name: string }>} */
  const out = new Map();
  for (const r of csvObjects(text)) {
    const code = r.Symbol;
    const industry = (r.Industry ?? "").trim();
    if (!code || industry === "" || industry === "-" || out.has(code)) continue;
    out.set(code, { code, industry, name: r["Company Name"] ?? code });
  }
  return [...out.values()];
}
