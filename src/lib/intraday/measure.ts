// M17 WP9 (VAL-118, D-399, D-462..D-464): the nightly measurement of intraday candidates. For each
// candidate whose horizon has completed, the 1, 3 and 5-session excess return against the market
// total-return index, both from the next session's open ("open", what a person could trade) and from
// the price at `found_at` ("found"). Everything is SHADOW (D-391): nothing here is shown as a result
// of trading, and nothing is fed back to the Cortex or to an order.
// Writes only the follow-up columns of `intraday_candidate` (the 0020 guard trigger aborts the rest),
// each only while it is still NULL, so a second run writes nothing.
import type { Client } from "@libsql/client";
import { addDays } from "@/lib/data/calendar";
import { loadTotalReturnSeries } from "@/lib/picks/benchmark";

/** Index code of the market benchmark series (D-462: no sector index is stored). */
export const BENCH_INDEX_CODE = "AXJO";
const HORIZONS = [1, 3, 5] as const;
const PPM = 1_000_000; // threshold-ok: parts per million
/** Candidates older than this many days are not re-looked at (a 5-session horizon is 7 days). */
const LOOKBACK_DAYS = 120; // threshold-ok: bounds the nightly scan

type Bar = { d: string; o: number; c: number };

const ppmOf = (exit: number, entry: number): number => Math.round((exit / entry - 1) * PPM); // money-float-ok: a ratio in ppm, measurement only

/** Excess ppm of a stock leg against an index leg (simple difference of the two returns). */
export function excessPpm(
  stockEntry: number,
  stockExit: number,
  idxEntry: number,
  idxExit: number,
): number | null {
  if (!(stockEntry > 0) || !(idxEntry > 0)) return null;
  return ppmOf(stockExit, stockEntry) - ppmOf(idxExit, idxEntry);
}

export async function measureCandidates(
  db: Client,
  market: string,
  d: string,
): Promise<{ updated: number }> {
  const cands = await db.execute({
    sql: `SELECT session_d, code, move_ppm, excess_open_1_ppm, excess_open_3_ppm, excess_open_5_ppm,
            excess_found_1_ppm, excess_found_3_ppm, excess_found_5_ppm
          FROM intraday_candidate
          WHERE market = ? AND session_d < ? AND session_d >= ? AND measured_at IS NULL
          ORDER BY session_d, code`,
    args: [market, d, addDays(d, -LOOKBACK_DAYS)],
  });
  if (cands.rows.length === 0) return { updated: 0 };
  const first = cands.rows.reduce((m, r) => (String(r.session_d) < m ? String(r.session_d) : m), d);
  const { series } = await loadTotalReturnSeries(db, market, BENCH_INDEX_CODE, first, d);
  const level = new Map(series.map((p) => [p.d, Number(p.levelMicro)]));
  let updated = 0;
  for (const c of cands.rows) {
    const sd = String(c.session_d);
    const code = String(c.code);
    const bars = (
      await db.execute({
        sql: `SELECT d, o, c FROM price_bar WHERE market = ? AND code = ? AND d > ? AND d <= ?
              ORDER BY d LIMIT 5`,
        args: [market, code, sd, d],
      })
    ).rows.map((r): Bar => ({ d: String(r.d), o: Number(r.o), c: Number(r.c) }));
    if (bars.length === 0) continue;
    const prev = (
      await db.execute({
        sql: `SELECT c FROM price_bar WHERE market = ? AND code = ? AND d < ? ORDER BY d DESC LIMIT 1`,
        args: [market, code, sd],
      })
    ).rows[0];
    const idxEntry = level.get(sd);
    if (idxEntry === undefined) continue; // no index level for the session: nothing to compare with
    const foundEntry = prev === undefined ? null : Number(prev.c) * (1 + Number(c.move_ppm) / PPM); // money-float-ok
    const openEntry = bars[0]!.o;
    const vals: Record<string, number | null> = {};
    for (const h of HORIZONS) {
      const bar = bars[h - 1];
      const idxExit = bar === undefined ? undefined : level.get(bar.d);
      if (bar === undefined || idxExit === undefined) {
        vals[`excess_open_${h}_ppm`] = null;
        vals[`excess_found_${h}_ppm`] = null;
        continue;
      }
      vals[`excess_open_${h}_ppm`] = excessPpm(openEntry, bar.c, idxEntry, idxExit);
      vals[`excess_found_${h}_ppm`] =
        foundEntry === null ? null : excessPpm(foundEntry, bar.c, idxEntry, idxExit);
    }
    const cur = (k: string): number | null => (c[k] === null ? null : Number(c[k]));
    const fresh = Object.keys(vals).some((k) => cur(k) === null && vals[k] !== null);
    if (!fresh) continue;
    const v = (k: string): number | null => vals[k] ?? null;
    const done = cur("excess_open_5_ppm") !== null || v("excess_open_5_ppm") !== null;
    const r = await db.execute({
      sql: `UPDATE intraday_candidate SET
              excess_open_1_ppm = COALESCE(excess_open_1_ppm, ?),
              excess_open_3_ppm = COALESCE(excess_open_3_ppm, ?),
              excess_open_5_ppm = COALESCE(excess_open_5_ppm, ?),
              excess_found_1_ppm = COALESCE(excess_found_1_ppm, ?),
              excess_found_3_ppm = COALESCE(excess_found_3_ppm, ?),
              excess_found_5_ppm = COALESCE(excess_found_5_ppm, ?),
              measured_at = ?
            WHERE market = ? AND session_d = ? AND code = ? AND measured_at IS NULL`,
      args: [
        v("excess_open_1_ppm"),
        v("excess_open_3_ppm"),
        v("excess_open_5_ppm"),
        v("excess_found_1_ppm"),
        v("excess_found_3_ppm"),
        v("excess_found_5_ppm"),
        done ? `${bars[Math.min(4, bars.length - 1)]!.d}T00:00:00.000Z` : null,
        market,
        sd,
        code,
      ],
    });
    if (r.rowsAffected > 0) updated += 1;
  }
  return { updated };
}
