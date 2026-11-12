// FINRA short data -> `short_interest` (M20 US1; DAT-243, D-1186). Two public files:
//   - the daily short-sale volume file `Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market`, published after
//     the close of each session: per code, short volume over total volume. It is stored as `short_ppm` = round(short
//     volume x 1,000,000 / total volume), the share of the DAY'S VOLUME sold short (not of the issued capital, which
//     is what the AU ASIC figure is: the unit differs and the source id says so), `as_of` = the trade date,
//     `published_at` = the start of the next UTC day (a conservative known time: the file is out by that evening, US
//     time) with `assumed_time` 1;
//   - the twice-monthly short-interest file (settlement date, short position, average daily volume, days to cover):
//     parsed for the code that wants it, NOT stored: the table holds parts per million of the issued capital and the
//     file carries no shares outstanding (they come from the company facts, a later task).
// Rows with a zero or unreadable volume, a symbol that does not look like a ticker, or a short volume above the total
// are rejected and counted, never repaired. No contact is needed (public files, polite client, one request a second).
import { assertMarketEnabled } from "../../../market/guard.mjs";

export const FINRA_SOURCE = "us_finra_short";
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

/** `YYYYMMDD` or `YYYY-MM-DD` -> `YYYY-MM-DD`, or null. @param {string} s */
function isoDate(s) {
  const t = s.trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(t);
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? null : d;
}

/** The day after a date. @param {string} d */
export function nextDay(d) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * @param {string} text the daily short-sale volume file
 * @returns {{ rows: { code: string, d: string, shortPpm: number, shortVolume: number, totalVolume: number }[], rejected: number }}
 */
export function parseDailyShortVolume(text) {
  const rows = [];
  let rejected = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "" || (i === 0 && /^date\|/i.test(line))) continue;
    const f = line.split("|");
    const d = f.length >= 5 ? isoDate(f[0]) : null;
    const code = (f[1] ?? "").trim().toUpperCase();
    const sv = /^\d+$/.test((f[2] ?? "").trim()) ? Number(f[2]) : NaN;
    const tv = /^\d+$/.test((f[4] ?? "").trim()) ? Number(f[4]) : NaN;
    if (
      d === null ||
      !TICKER_RE.test(code) ||
      !Number.isSafeInteger(sv) ||
      !Number.isSafeInteger(tv) ||
      tv <= 0 ||
      sv > tv
    ) {
      rejected += 1;
      continue;
    }
    rows.push({
      code,
      d,
      shortPpm: Math.round((sv * 1_000_000) / tv),
      shortVolume: sv,
      totalVolume: tv,
    });
  }
  return { rows, rejected };
}

/**
 * @param {string} text the twice-monthly short-interest file (pipe separated, with its header)
 * @returns {{ rows: { code: string, settlementDate: string, shortShares: number, avgDailyVolume: number | null, daysToCover: number | null }[], rejected: number }}
 */
export function parseShortInterest(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], rejected: 0 };
  const head = lines[0].split("|").map((h) => h.trim());
  const ix = (n) => head.indexOf(n);
  const [iSym, iPos, iAdv, iDtc, iSettle] = [
    ix("symbolCode"),
    ix("currentShortPositionQuantity"),
    ix("averageDailyVolumeQuantity"),
    ix("daysToCoverQuantity"),
    ix("settlementDate"),
  ];
  const rows = [];
  let rejected = 0;
  if ([iSym, iPos, iSettle].includes(-1)) return { rows, rejected: lines.length - 1 };
  for (const line of lines.slice(1)) {
    const f = line.split("|");
    const code = (f[iSym] ?? "").trim().toUpperCase();
    const settlementDate = isoDate(f[iSettle] ?? "");
    const pos = /^\d+$/.test((f[iPos] ?? "").trim()) ? Number(f[iPos]) : NaN;
    if (!TICKER_RE.test(code) || settlementDate === null || !Number.isSafeInteger(pos)) {
      rejected += 1;
      continue;
    }
    const adv = /^\d+$/.test((f[iAdv] ?? "").trim()) ? Number(f[iAdv]) : null;
    const dtc = /^\d+(\.\d+)?$/.test((f[iDtc] ?? "").trim()) ? Number(f[iDtc]) : null;
    rows.push({ code, settlementDate, shortShares: pos, avgDailyVolume: adv, daysToCover: dtc });
  }
  return { rows, rejected };
}

/**
 * Append the daily rows of codes the market covers. `covered` is the set of instrument codes (a row for any other
 * code is not written: the table is the universe's, not FINRA's).
 * @param {{ batch: Function }} db @param {string} market
 * @param {{ code: string, d: string, shortPpm: number }[]} rows @param {ReadonlySet<string>} covered @param {string} now ISO
 * @returns {Promise<{ inserted: number, notCovered: number }>}
 */
export async function writeShortInterest(db, market, rows, covered, now) {
  await assertMarketEnabled(db, market);
  const keep = rows.filter((r) => covered.has(r.code));
  const stmts = [];
  for (let i = 0; i < keep.length; i += 100) {
    const slice = keep.slice(i, i + 100);
    stmts.push({
      // rows-ok: at most 100 rows per statement, one insert per covered code of the day, ignored when present
      sql: `INSERT INTO short_interest (market, code, as_of, short_ppm, published_at, ingested_at, assumed_time, source)
            VALUES ${slice.map(() => "(?, ?, ?, ?, ?, ?, 1, ?)").join(",")} ON CONFLICT DO NOTHING`,
      args: slice.flatMap((r) => [
        market,
        r.code,
        r.d,
        r.shortPpm,
        `${nextDay(r.d)}T00:00:00.000Z`,
        now,
        FINRA_SOURCE,
      ]),
    });
  }
  if (stmts.length === 0) return { inserted: 0, notCovered: rows.length };
  const res = await db.batch(stmts, "write");
  return {
    inserted: res.reduce((a, x) => a + x.rowsAffected, 0),
    notCovered: rows.length - keep.length,
  };
}
