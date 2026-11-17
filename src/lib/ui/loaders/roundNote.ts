// The note shown while one round has ended and the next has not started trading (Owner 2026-11-16): the
// A$600 round ends at a close and its successor starts two sessions later (`restartSession`), so for a
// day or two no cohort has a value yet. The round number, seed and days come from the stored cohorts and
// the trading calendar (never hard-coded). Display only; reads no quotes and writes nothing.
import { SEED_MICRO, roundOverridesFor } from "@/lib/arena/cohort";
import { restartSession } from "@/lib/arena/terminal";
import { nextTradingDay } from "@/lib/data/calendar";
import { readCalendar } from "@/lib/intraday/run";
import { currencyFormatFor, formatDay, formatMicro } from "@/lib/view/format";
import { melbourneDate } from "@/lib/view/active";
import { soft } from "./common";

type Exec = {
  execute: (q: {
    sql: string;
    args: (string | number)[];
  }) => Promise<{ rows: Record<string, unknown>[] }>;
};

const LIVE_UNLEVERED =
  "c.control_idx IS NULL AND EXISTS (SELECT 1 FROM execution e WHERE e.id = c.execution_id AND e.kind = 'E' AND e.variant = 'U')";

/**
 * "Round 2 starts Tue 17 Nov with A$5,000 a strategy. Orders are placed after that day's close; the
 * first buys are at the open on Wed 18 Nov." when a round ended and no live round has a value yet; null
 * otherwise (including the first-ever state, when no round has ended).
 */
export async function pendingRoundNote(
  db: Exec,
  market: string,
  currency: string,
  now: Date,
): Promise<string | null> {
  return soft(async () => {
    const ended = await db.execute({
      sql: `SELECT COUNT(*) AS n, MAX(c.terminal_d) AS d FROM cohort c
       WHERE c.terminal_kind IS NOT NULL AND ${LIVE_UNLEVERED}`,
      args: [],
    });
    if (Number(ended.rows[0]?.n ?? 0) === 0) return null;
    const running = await db.execute({
      sql: `SELECT 1 AS x FROM cohort c WHERE c.terminal_kind IS NULL AND ${LIVE_UNLEVERED}
         AND EXISTS (SELECT 1 FROM nav_daily n WHERE n.cohort_id = c.id) LIMIT 1`,
      args: [],
    });
    if (running.rows.length > 0) return null;
    const calendar = await readCalendar(db as never, market);
    const succ = await db.execute({
      sql: `SELECT MIN(c.start_d) AS d FROM cohort c WHERE c.terminal_kind IS NULL AND ${LIVE_UNLEVERED}`,
      args: [],
    });
    const rounds = await db.execute({
      sql: `SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM cohort c WHERE ${LIVE_UNLEVERED}
                                 GROUP BY c.execution_id)`,
      args: [],
    });
    const hasSucc = succ.rows[0]?.d !== null && succ.rows[0]?.d !== undefined;
    const terminalD = String(ended.rows[0]?.d);
    const startD = hasSucc ? String(succ.rows[0]!.d) : restartSession(terminalD, calendar);
    const round = Number(rounds.rows[0]?.n ?? 0) + (hasSucc ? 0 : 1);
    const seed = roundOverridesFor(startD).seedMicro ?? SEED_MICRO;
    const buyD = nextTradingDay(startD, calendar);
    const today = melbourneDate(now.toISOString());
    const verb = today !== null && startD <= today ? "started" : "starts";
    return (
      `Round ${round} ${verb} ${formatDay(startD, now)} with ${formatMicro(seed, currencyFormatFor(currency)).replace(/\.00$/, "")} a strategy. ` +
      `Orders are placed after ${verb === "started" ? "each" : "that"} day's close; the first buys are at the open on ${formatDay(buyD, now)}.`
    );
  }, null);
}
