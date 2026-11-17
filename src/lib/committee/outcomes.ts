// Committee trial outcomes (M22 C2; ARN-105, VAL-111, D-1422). The engine writes no outcome: the net result of a rated signal
// is read from the forward signal ledger (`ledger_row`) at the family exit, provided that exit came within
// `committee_horizon_sessions` sessions of the rating day (the horizon is frozen in the pre-registration). A signal without a
// closed forward ledger row is unsettled and left out; one that closed after the horizon is counted as `lateExit` and also
// left out (the ledger holds no mark at the horizon, and none is invented here). Read-only, one bounded statement for the
// ratings and one for the calendar. Money is exact (bigint micro amounts); only the final ppm integer leaves.
import { sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import type { Exec } from "./store";

export type RatedOutcome = {
  d: string;
  signalId: string;
  rating: "approve" | "neutral" | "reject";
  judgeModel: string | null;
  /** The net result of the ledger row, parts per million of the cost basis (an integer). */
  netPpm: number;
};

export type OutcomeRead = {
  /** Settled signals in (d, signal id) order. */
  settled: RatedOutcome[];
  /** Rated signals with no closed forward ledger row yet. */
  unsettled: number;
  /** Rated signals whose family exit came after the horizon. */
  lateExit: number;
};

const PPM = 1_000_000n; // threshold-ok: parts per million
const READ_LIMIT = 3000; // threshold-ok: at most 252 sessions x 5 shortlisted signals x a few ledger rows, bounded
const CALENDAR_LIMIT = 3000; // threshold-ok: about eight years of calendar rows, bounded

const big = (v: unknown): bigint => BigInt(String(v));

/** The net of a closed ledger row in ppm of its cost basis, half away from zero (exact bigint arithmetic). */
export function netPpmOf(r: {
  qty: unknown;
  qty_out: unknown;
  fill_in_micro: unknown;
  fill_out_micro: unknown;
  brok_in_micro: unknown;
  brok_out_micro: unknown;
  dividend_micro: unknown;
}): number {
  const cost = big(r.qty) * big(r.fill_in_micro) + big(r.brok_in_micro);
  const proceeds =
    big(r.qty_out) * big(r.fill_out_micro) - big(r.brok_out_micro) + big(r.dividend_micro);
  if (cost <= 0n) throw new RangeError("a ledger row needs a positive cost basis");
  const num = (proceeds - cost) * PPM;
  const half = cost / 2n;
  return Number(num >= 0n ? (num + half) / cost : -((-num + half) / cost));
}

/** Sessions after the rating day up to and including the exit day (the weekday calendar minus the stored holidays). */
export function sessionsToExit(d: string, exitD: string, calendar: readonly CalendarRow[]): number {
  return Math.max(0, sessionsBetween(d, exitD, calendar).length - 1);
}

async function readCalendar(db: Exec, market: string, from: string): Promise<CalendarRow[]> {
  // rows-ok: trading_calendar primary key (market, d) range from the first rated day, LIMIT 3000
  const r = await db.execute({
    sql: `SELECT d, kind, close_time, confirmed FROM trading_calendar
           WHERE market = ? AND d >= ? ORDER BY d LIMIT ?`,
    args: [market, from, CALENDAR_LIMIT],
  });
  return r.rows.map((x) => ({
    d: String(x.d),
    kind: String(x.kind) as CalendarRow["kind"],
    close_time: x.close_time === null ? null : String(x.close_time),
    confirmed: Number(x.confirmed) === 1 ? 1 : 0,
  }));
}

/**
 * The settled outcomes of a trial (D-1422). One row per rated signal: the first closed forward ledger row of the signal
 * (a signal has one row per execution; the smallest id is taken so the choice is fixed).
 */
export async function readOutcomes(
  db: Exec,
  o: { market: string; trialId: string; horizonSessions: number },
): Promise<OutcomeRead> {
  // rows-ok: committee_rating index (trial_id, d) joined to ledger_row index (signal_id), LIMIT 3000, no paging
  const r = await db.execute({
    sql: `SELECT c.d AS d, c.signal_id AS signal_id, c.rating AS rating, c.judge_model AS judge_model,
                 l.id AS lid, l.exit_d AS exit_d, l.qty AS qty, l.qty_out AS qty_out,
                 l.fill_in_micro AS fill_in_micro, l.fill_out_micro AS fill_out_micro,
                 l.brok_in_micro AS brok_in_micro, l.brok_out_micro AS brok_out_micro,
                 l.dividend_micro AS dividend_micro
            FROM committee_rating c
            LEFT JOIN ledger_row l ON l.signal_id = c.signal_id AND l.forward = 1 AND l.exit_d IS NOT NULL
           WHERE c.trial_id = ? AND c.market = ? AND c.rating IN ('approve', 'neutral', 'reject')
           ORDER BY c.d, c.signal_id, l.id
           LIMIT ?`,
    args: [o.trialId, o.market, READ_LIMIT],
  });
  const first = new Map<string, Record<string, unknown>>();
  const keyOf = (x: Record<string, unknown>): string =>
    `${String(x.d)}\u0000${String(x.signal_id)}`;
  const order: string[] = [];
  for (const x of r.rows as unknown as Record<string, unknown>[]) {
    const k = keyOf(x);
    if (!first.has(k)) {
      first.set(k, x);
      order.push(k);
    }
  }
  const days = order.map((k) => String(first.get(k)!.d)).sort();
  const calendar = days.length === 0 ? [] : await readCalendar(db, o.market, days[0]!);
  const settled: RatedOutcome[] = [];
  let unsettled = 0;
  let lateExit = 0;
  for (const k of order) {
    const x = first.get(k)!;
    if (x.exit_d === null || x.exit_d === undefined) {
      unsettled += 1;
      continue;
    }
    if (sessionsToExit(String(x.d), String(x.exit_d), calendar) > o.horizonSessions) {
      lateExit += 1;
      continue;
    }
    settled.push({
      d: String(x.d),
      signalId: String(x.signal_id),
      rating: String(x.rating) as RatedOutcome["rating"],
      judgeModel: x.judge_model === null ? null : String(x.judge_model),
      netPpm: netPpmOf(x as Parameters<typeof netPpmOf>[0]),
    });
  }
  return { settled, unsettled, lateExit };
}
