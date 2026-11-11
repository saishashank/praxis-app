// ABS Data API (SDMX-CSV) -> macro_series (DAT-251 c, D-973).
//   node scripts/macro/abs.mjs        env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, MACRO_USER_AGENT (optional)
// Source: Australian Bureau of Statistics (CC BY 4.0, credit the ABS: abs.gov.au privacy, copyright and
// disclaimer page, checked 2026-11-11). Host and shape verified 2026-11-11: GET
// https://data.api.abs.gov.au/rest/data/ABS,CPI,2.0.0/1.10001.10.50.Q?startPeriod=2025-Q1 with
// Accept: application/vnd.sdmx.data+csv gives "DATAFLOW,MEASURE,INDEX,TSEST,REGION,FREQ,TIME_PERIOD,OBS_VALUE,..."
// rows in no fixed order. (The user guide names api.data.abs.gov.au, which did not resolve; the host above does.)
import { fileURLToPath } from "node:url";
import { absDate, csvLine, csvLines, runMacro, toMicro } from "./lib.mjs";

/** One series per entry: a stored id, the dataflow, the SDMX key and how far back to ask. */
export const ABS_SERIES = [
  {
    id: "CPI_ALL_GROUPS_AUS_Q", // Consumer Price Index, all groups, Australia, quarterly index (key verified)
    flow: "ABS,CPI,2.0.0",
    key: "1.10001.10.50.Q",
    startPeriod: "2024-Q1",
  },
];
export const absUrl = (s) =>
  `https://data.api.abs.gov.au/rest/data/${s.flow}/${s.key}?startPeriod=${s.startPeriod}`;

/** @returns {{source: "abs", series_id: string, d: string, value_micro: number}[] | null} null = not SDMX-CSV */
export function parseAbs(csv, seriesId) {
  const lines = csvLines(csv);
  const head = csvLine(lines[0] ?? "");
  const t = head.indexOf("TIME_PERIOD");
  const v = head.indexOf("OBS_VALUE");
  if (t < 0 || v < 0) return null;
  const byDay = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    const f = csvLine(lines[i]);
    const d = absDate(f[t]);
    const m = toMicro(f[v]);
    if (d !== null && m !== null) byDay.set(d, m); // the file repeats nothing; the last one wins if it does
  }
  if (byDay.size === 0) return null;
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([d, value_micro]) => ({ source: "abs", series_id: seriesId, d, value_micro }));
}

/** One request per series; the first (and today only) series carries the conditional header state. */
export async function run(env, deps) {
  let code = 0;
  for (const s of ABS_SERIES) {
    const c = await runMacro(
      {
        source: "abs",
        url: absUrl(s),
        accept: "application/vnd.sdmx.data+csv",
        parse: (b) => parseAbs(b, s.id),
      },
      env,
      deps,
    );
    if (c !== 0) code = c;
  }
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.env));
}
