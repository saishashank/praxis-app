// Results-season and known-date calendar (CR-MOV-A2, A-D8-04-lite; D-745). Two pure facts:
//   inResultsWindow     the session lies in the February or August reporting window (keys, default the
//                       whole month): a timing flag for the trace and the sizing context, never a veto;
//   predictResultsDates a company's own next result dates, one year after the result-type announcements
//                       the archive holds (half-year, full-year, quarterly activities), once the archive
//                       spans `known_date_min_history_days` (a year of live accumulation, A7).
// Point-in-time: the caller passes only archive rows with known_at <= the cut-off. Pure.
import { addDays, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import type { MoversParams } from "../moversParams";

const FEB = 2; // threshold-ok: calendar month
const AUG = 8; // threshold-ok: calendar month
const YEAR_SHIFT_DAYS = 364; // threshold-ok: 52 weeks keeps the weekday of the reporting date
const LOOKBACK_DAYS = 400; // threshold-ok: archive rows older than this are not read for a prediction

/** Result-type announcement words (ASX types and titles of the periodic reports). */
const RESULT_RE =
  /\b(half[- ]?year(ly)?|full[- ]?year|preliminary final|annual report|quarterly activities|appendix 4[ecd])\b/i;

export function isResultsAnnouncement(type: string | null, title: string): boolean {
  return RESULT_RE.test(`${type ?? ""} ${title}`);
}

/** Session date d inside the Feb / Aug window of the keys. */
export function inResultsWindow(
  d: string,
  p: Pick<MoversParams, "resultsWindowStartDay" | "resultsWindowEndDay">,
): boolean {
  const month = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  return (
    (month === FEB || month === AUG) &&
    day >= p.resultsWindowStartDay &&
    day <= p.resultsWindowEndDay
  );
}

export type ResultsHistoryRow = {
  /** Session date of publication. */
  readonly sessionD: string;
  readonly type: string | null;
  readonly title: string;
};

/**
 * Predicted result dates >= d: every result-type row of the last LOOKBACK_DAYS shifted by 52 weeks.
 * Empty until the archive spans `knownDateMinHistoryDays` before d (`archiveSinceD` = the earliest
 * known_at date of the archive, null = empty archive). Sorted, unique.
 */
export function predictResultsDates(x: {
  readonly d: string;
  readonly history: readonly ResultsHistoryRow[];
  readonly archiveSinceD: string | null;
  readonly params: Pick<MoversParams, "knownDateMinHistoryDays">;
}): string[] {
  if (x.archiveSinceD === null) return [];
  if (x.archiveSinceD > addDays(x.d, -x.params.knownDateMinHistoryDays)) return [];
  const oldest = addDays(x.d, -LOOKBACK_DAYS);
  const out = new Set<string>();
  for (const r of x.history) {
    if (r.sessionD < oldest || r.sessionD > x.d) continue;
    if (!isResultsAnnouncement(r.type, r.title)) continue;
    const next = addDays(r.sessionD, YEAR_SHIFT_DAYS);
    if (next >= x.d) out.add(next);
  }
  return [...out].sort();
}

/** Sessions from d to the first predicted date (0 = today), or null when there is none. */
export function sessionsToNextDate(
  d: string,
  dates: readonly string[],
  calendar: readonly CalendarRow[],
): number | null {
  const next = dates.find((x) => x >= d);
  if (next === undefined) return null;
  if (next === d) return 0;
  return sessionsBetween(addDays(d, 1), next, calendar).length;
}
