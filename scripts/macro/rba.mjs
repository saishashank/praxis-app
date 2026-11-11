// RBA statistical table F1 (daily interest rates) -> macro_series (DAT-251 c, D-973).
//   node scripts/macro/rba.mjs        env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, MACRO_USER_AGENT (optional)
// Source: Reserve Bank of Australia (RBA copyright notice: financial data may be reused with attribution
// "Source: RBA"; it does not address automated download, checked 2026-11-11; the Friday step is gated by
// the MACRO_FETCH variable so the Owner accepts that first, D-973). Layout verified 2026-11-11: a UTF-8
// BOM, a title row, "Title,<series names>", description / frequency / type / units rows, two blank rows,
// "Source", "Publication date", "Series ID,<ids>", then data rows "DD-Mon-YYYY,v1,v2,...".
import { fileURLToPath } from "node:url";
import { csvLine, csvLines, rbaDate, runMacro, toMicro } from "./lib.mjs";

export const RBA_URL = "https://www.rba.gov.au/statistics/tables/csv/f1-data.csv";
/** The series kept: the cash rate target and the interbank overnight cash rate (ids as in the file's Series ID row). */
export const RBA_SERIES = ["FIRMMCRTD", "FIRMMCCRT"];
/** Only this many days back from the newest row are kept (the table starts in 2011). */
export const RBA_KEEP_DAYS = 400; // threshold-ok: about 16 months, a small weekly write

/** @returns {{source: "rba", series_id: string, d: string, value_micro: number}[] | null} null = not the table */
export function parseRba(csv, { series = RBA_SERIES, keepDays = RBA_KEEP_DAYS } = {}) {
  const lines = csvLines(csv);
  const idRow = lines.findIndex((l) => csvLine(l)[0] === "Series ID");
  if (idRow < 0) return null;
  const ids = csvLine(lines[idRow]);
  const cols = series.map((s) => [s, ids.indexOf(s)]).filter(([, i]) => i > 0);
  if (cols.length === 0) return null;
  const rows = [];
  for (let i = idRow + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    const f = csvLine(lines[i]);
    const d = rbaDate(f[0]);
    if (d === null) continue;
    for (const [s, c] of cols) {
      const v = toMicro(f[c]);
      if (v !== null) rows.push({ source: "rba", series_id: s, d, value_micro: v });
    }
  }
  if (rows.length === 0) return null;
  const newest = rows.reduce((m, r) => (r.d > m ? r.d : m), "0000-00-00");
  const from = new Date(Date.parse(`${newest}T00:00:00Z`) - keepDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return rows.filter((r) => r.d >= from);
}

export const run = (env, deps) =>
  runMacro({ source: "rba", url: RBA_URL, accept: "text/csv", parse: (b) => parseRba(b) }, env, deps);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.env));
}
