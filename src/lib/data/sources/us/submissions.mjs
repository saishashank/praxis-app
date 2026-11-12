// EDGAR submissions (M20 US1; DAT-243, D-1112, D-1160): per company, the SIC code (the industry classification of the
// `sic_2digit` scheme) and the list of recent filings with their ACCEPTANCE time and 8-K item numbers (the known time
// of a filing is its acceptance instant, `known_time_rules.filings = edgar_acceptance_time`). Pure parsing plus two
// writers behind `assertMarketEnabled`; no network (the fetch is edgar.mjs, driven by scripts/ingest/us/fetch.mjs).
import { assertMarketEnabled } from "../../../market/guard.mjs";

/**
 * @typedef {{ accession: string, form: string, filedDate: string, acceptedAt: string | null, items: string[], itemsDropped: number,
 *             description: string | null, primaryDocument: string | null }} Filing
 * @typedef {{ cik: string, name: string | null, sic: string | null, tickers: string[], filings: Filing[] }} Submissions
 */

const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;
const ITEM_RE = /^\d\.\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** EDGAR acceptance text `2026-02-20T16:05:11.000Z` (or without millis) -> ISO UTC, else null. @param {unknown} v */
export function acceptanceInstant(v) {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(t).toISOString() : null;
}

/**
 * The submissions JSON of one company. `recent` is the column-oriented block the SEC publishes; a row without an
 * accession number, a form or a filing date is skipped (nothing is guessed).
 * @param {any} json @returns {Submissions}
 */
export function parseSubmissions(json) {
  const cik = String(json?.cik ?? "").replace(/\D/g, "");
  const sicRaw = json?.sic === undefined || json?.sic === null ? "" : String(json.sic).trim();
  const recent = json?.filings?.recent ?? {};
  const col = (k) => (Array.isArray(recent[k]) ? recent[k] : []);
  const acc = col("accessionNumber");
  const forms = col("form");
  const filed = col("filingDate");
  const accepted = col("acceptanceDateTime");
  const items = col("items");
  const desc = col("primaryDocDescription");
  const primary = col("primaryDocument");
  /** @type {Filing[]} */
  const filings = [];
  for (let i = 0; i < acc.length; i += 1) {
    const accession = String(acc[i] ?? "");
    const form = String(forms[i] ?? "").trim();
    const filedDate = String(filed[i] ?? "");
    const rawItems = String(items[i] ?? "")
      .split(",")
      .map((s) => s.trim());
    if (!ACCESSION_RE.test(accession) || form === "" || !DATE_RE.test(filedDate)) continue;
    filings.push({
      accession,
      form,
      filedDate,
      acceptedAt: acceptanceInstant(accepted[i]),
      items: rawItems.filter((s) => ITEM_RE.test(s)),
      // an item that does not match the number format is dropped, and counted (the filing stays)
      itemsDropped: rawItems.filter((s) => s !== "" && !ITEM_RE.test(s)).length,
      description: typeof desc[i] === "string" && desc[i].trim() !== "" ? desc[i].trim() : null,
      primaryDocument: typeof primary[i] === "string" && primary[i] !== "" ? primary[i] : null,
    });
  }
  return {
    cik,
    name: typeof json?.name === "string" ? json.name : null,
    sic: /^\d{1,4}$/.test(sicRaw) ? sicRaw.padStart(4, "0") : null,
    tickers: Array.isArray(json?.tickers) ? json.tickers.map(String) : [],
    filings,
  };
}

/** The acceptance instant by accession, the `acceptance` option of `parseCompanyFacts` (D-1160). @param {Submissions} s */
export function acceptanceByAccession(s) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const f of s.filings) if (f.acceptedAt !== null) out[f.accession] = f.acceptedAt;
  return out;
}

/** The two-digit SIC group (the first two digits of the four-digit code), or null. @param {string | null} sic */
export function sicGroup(sic) {
  return sic !== null && /^\d{4}$/.test(sic) ? sic.slice(0, 2) : null;
}

/**
 * Write the two-digit SIC group into `instrument.industry` of a code (D-1182: the `sic_2digit` reader reads it back
 * and the NAV cap groups by it). One key probe, one update only when the value changes. Returns whether it changed.
 * @param {{ execute: Function }} db @param {string} market @param {string} code @param {string | null} sic
 */
export async function writeSicGroup(db, market, code, sic) {
  await assertMarketEnabled(db, market);
  const group = sicGroup(sic);
  if (group === null) return false;
  // rows-ok: primary-key probe of one instrument row (unique market, code)
  const cur = await db.execute({
    sql: "SELECT industry FROM instrument WHERE market = ? AND code = ?",
    args: [market, code],
  });
  if (cur.rows.length === 0 || cur.rows[0].industry === group) return false;
  await db.execute({
    // rows-ok: one update of one instrument row, by the unique (market, code)
    sql: "UPDATE instrument SET industry = ? WHERE market = ? AND code = ?",
    args: [group, market, code],
  });
  return true;
}
