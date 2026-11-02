// Offline converter: a downloaded Wikidata export -> the listed-companies CSV that
// src/lib/data/universe/parse.mjs accepts (DAT-236, D-239). Wikidata structured data is CC0.
//   node scripts/data/universe-from-wikidata.mjs <export.json> [--out <universe.csv>]
// It reads a LOCAL file only. There is no fetcher: the Owner runs a query on Wikidata's public
// site, saves the JSON result and uploads the CSV this prints on Configuration, Data files
// (source `manual`, the same parser and shrink guard as the Worker import). The network is never
// touched, in tests or otherwise. No clock, no randomness: the same input gives the same bytes.
//
// Accepted inputs:
//   1. SPARQL JSON results: { results: { bindings: [ { code, name|companyLabel|company|label,
//      industryLabel|industry } ] } } where each field is { value: "..." }. `code` is the ASX code;
//      the industry is optional.
//   2. A plain array of { code, name, industry? }.
// Rows with an invalid code or name are skipped and counted; the first row of a code wins (input
// order), then rows are sorted by code. Output: header "Company name,ASX code,GICS industry
// group", one row per company. That last column then holds the Wikidata industry label (a proxy,
// D-218); a blank is allowed.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HEADER = "Company name,ASX code,GICS industry group";
export const MAX_NAME = 200;
export const MAX_INDUSTRY = 100;
const CODE_RE = /^[A-Z0-9]{2,6}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const val = (/** @type {any} */ v) => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.value === "string") return v.value;
  return "";
};

/** @param {unknown} json @returns {{ code: string, name: string, industry: string }[] | null} */
export function extractRecords(json) {
  /** @type {unknown[] | null} */
  let list = null;
  if (Array.isArray(json)) list = json;
  else if (json && typeof json === "object") {
    const b = /** @type {any} */ (json).results?.bindings;
    if (Array.isArray(b)) list = b;
  }
  if (!list) return null;
  return list.map((r) => {
    const o = /** @type {any} */ (r && typeof r === "object" ? r : {});
    return {
      code: val(o.code).trim(),
      name: (val(o.name) || val(o.companyLabel) || val(o.company) || val(o.label)).trim(),
      industry: (val(o.industryLabel) || val(o.industry)).trim(),
    };
  });
}

/** CSV-quote a field when it holds a comma, quote or line break. */
const q = (/** @type {string} */ s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * @param {unknown} json parsed Wikidata export
 * @returns {{ ok: true, csv: string, stats: { input: number, written: number, skipped: number, duplicates: number } } | { ok: false, error: "unrecognised_format" }}
 */
export function convert(json) {
  const recs = extractRecords(json);
  if (!recs) return { ok: false, error: "unrecognised_format" };
  /** @type {Map<string, { code: string, name: string, industry: string }>} */
  const byCode = new Map();
  let skipped = 0;
  let duplicates = 0;
  for (const r of recs) {
    const okName = r.name.length > 0 && r.name.length <= MAX_NAME && !CONTROL_RE.test(r.name);
    const okInd = r.industry.length <= MAX_INDUSTRY && !CONTROL_RE.test(r.industry);
    if (!CODE_RE.test(r.code) || !okName || !okInd) {
      skipped += 1;
      continue;
    }
    if (byCode.has(r.code)) {
      duplicates += 1;
      continue;
    }
    byCode.set(r.code, r);
  }
  const rows = [...byCode.values()].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  const lines = [HEADER, ...rows.map((r) => `${q(r.name)},${r.code},${q(r.industry)}`)];
  return {
    ok: true,
    csv: `${lines.join("\n")}\n`,
    stats: { input: recs.length, written: rows.length, skipped, duplicates },
  };
}

/** @param {string[]} argv @param {(s: string) => void} out */
export function main(argv = process.argv.slice(2), out = console.log) {
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const input = argv.find((a, i) => !a.startsWith("--") && i !== outIdx + 1);
  if (!input || (outIdx >= 0 && !outPath)) {
    out("usage: node scripts/data/universe-from-wikidata.mjs <export.json> [--out <universe.csv>]");
    return 1;
  }
  let json;
  try {
    json = JSON.parse(readFileSync(input, "utf8"));
  } catch {
    out("universe-from-wikidata: cannot read the file as JSON");
    return 1;
  }
  const r = convert(json);
  if (!r.ok) {
    out("universe-from-wikidata: unrecognised export shape");
    return 1;
  }
  if (outPath) {
    writeFileSync(outPath, r.csv, "utf8");
    out(
      `universe-from-wikidata: wrote ${r.stats.written} rows (${r.stats.skipped} skipped, ${r.stats.duplicates} duplicates)`,
    );
  } else {
    process.stdout.write(r.csv);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
