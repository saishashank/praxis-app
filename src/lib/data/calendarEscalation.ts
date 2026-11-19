// Escalation of a DRAFTED trading calendar (OPS-103, DAT-160; D-961). Pure: a function of the date and of
// the drafted rows read from the database, so the heartbeat, System Health and the tests agree.
//
// Only rows written by the yearly draft job count (source `draft:...`, calendarRules.mjs): the V1 seed
// rows keep their own, older confirmation flow. For each market:
//   - the year AFTER today's, drafted and not yet confirmed:
//       before 1 December  -> `draft_ready`        an Owner item ("drafted, check and confirm"), no incident
//       from 1 December    -> `unconfirmed_next`   S2 incident `calendar_unconfirmed`
//   - today's year, drafted and still not confirmed (from 1 January the provisional rows are in use,
//     `dayStatus` already reads unconfirmed rows):
//                          -> `in_use_unconfirmed` S2 incident `calendar_unconfirmed_in_use`, every
//                             affected day is flagged "calendar unconfirmed" (System Health item, Evening
//                             Review day line) and the item stays in the daily attention reminder until the
//                             Owner confirms the year.
// Confirming the year (calendarAdmin.confirmCalendar) leaves no unconfirmed drafted row, so every finding
// clears by itself.

export type DraftedYear = { market: string; year: number; rows: number; unconfirmed: number };
export type CalendarFindingKind = "draft_ready" | "unconfirmed_next" | "in_use_unconfirmed";
export type CalendarFinding = {
  kind: CalendarFindingKind;
  market: string;
  year: number;
  /** The plain line shown to the Owner. */
  text: string;
};

export const DRAFT_READY_TEXT =
  "Next year's trading calendar is drafted. Check it against the ASX calendar and confirm it on System Health.";
/** Heartbeat incident kinds (S2, one open per kind). */
export const KIND_CALENDAR_UNCONFIRMED = "calendar_unconfirmed";
export const KIND_CALENDAR_UNCONFIRMED_IN_USE = "calendar_unconfirmed_in_use";
/** First day of the escalation (month and day), local to the Owner. */
export const ESCALATE_FROM = "12-01";

export function calendarEscalation(
  today: string,
  drafted: readonly DraftedYear[],
): CalendarFinding[] {
  const year = Number(today.slice(0, 4));
  const out: CalendarFinding[] = [];
  for (const y of drafted) {
    if (y.rows === 0 || y.unconfirmed === 0) continue;
    if (y.year === year) {
      out.push({
        kind: "in_use_unconfirmed",
        market: y.market,
        year: y.year,
        text: `Trading days of ${y.year} use a calendar that is not confirmed yet. Check it against the ASX calendar and confirm it on System Health.`,
      });
    } else if (y.year === year + 1) {
      const late = today.slice(5) >= ESCALATE_FROM;
      out.push({
        kind: late ? "unconfirmed_next" : "draft_ready",
        market: y.market,
        year: y.year,
        text: late
          ? `The ${y.year} trading calendar is still not confirmed. Confirm it on System Health before 1 January.`
          : DRAFT_READY_TEXT,
      });
    }
  }
  return out.sort((a, b) => a.market.localeCompare(b.market) || a.year - b.year);
}

/** The drafted years of one market from the database (key-range scan of `trading_calendar`). */
export async function readDraftedYears(
  db: {
    execute: (q: { sql: string; args: Array<string | number> }) => Promise<{ rows: unknown[] }>;
  },
  markets: readonly string[],
  today: string,
): Promise<DraftedYear[]> {
  const out: DraftedYear[] = [];
  const y = Number(today.slice(0, 4));
  for (const market of markets) {
    // rows-ok: two years of one market (about 520 rows) through the (market, d) key, once a day
    const r = await db.execute({
      sql: `SELECT substr(d, 1, 4) AS y, COUNT(*) AS n, SUM(CASE WHEN confirmed = 0 THEN 1 ELSE 0 END) AS u
            FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ? AND source LIKE 'draft:%'
            GROUP BY substr(d, 1, 4)`,
      args: [market, `${y}-01-01`, `${y + 1}-12-31`],
    });
    for (const row of r.rows as Array<Record<string, unknown>>) {
      out.push({
        market,
        year: Number(row.y),
        rows: Number(row.n),
        unconfirmed: Number(row.u ?? 0),
      });
    }
  }
  return out;
}
