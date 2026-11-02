// The announcement archive by forward accumulation (CR-MOV-A7; D-749). Every announcement the Sentinel
// ingests is copied, once, into the append-only `announcement_archive` (migration 0024) with the three
// facts the event angles and the calibration later need and the `announcement` table cannot keep (it is
// pruned beyond 400 days): the price-sensitive flag, the TIMING class of the publication (before the
// open, during the session, after the close) and whether it is a halt / suspension / reinstatement
// notice. `session_d` is the session in which the market first sees the item (a post-close or
// non-session-day item is that of the next session). `known_at` is the instant this system first stored
// the row and nothing earlier: a calibration that reads the archive cannot see an item before the app did.
// Cost: $0, no new source. Not an Owner-visible feature; it unlocks A2 known dates and, after a year,
// F2/F3/F5 calibration on live-recorded events.
import type { InStatement } from "@libsql/client";
import {
  isTradingDay,
  localToUtc,
  marketDate,
  nextTradingDay,
  type CalendarRow,
} from "@/lib/data/calendar";
import { watchNoticeKind } from "@/lib/cortex/states/haltWatch";
import type { FeedItem } from "./feed";

export type PublicationTiming = "pre_open" | "intraday" | "post_close";

export type MarketHoursLocal = { tz: string; open_time: string; close_time: string };

/** The market hours used when the market row cannot be read (ASX regular session). */
export const DEFAULT_HOURS: MarketHoursLocal = {
  tz: "Australia/Melbourne",
  open_time: "10:00",
  close_time: "16:00",
};

/** Minutes after the close that still count as the session (the closing auction). */
const CLOSE_GRACE_MIN = 10; // threshold-ok: ASX closing single price auction window
const MS_PER_MIN = 60_000; // threshold-ok: unit

/** Timing class and market session of a publication instant. Pure. */
export function classifyPublication(
  publishedAtIso: string,
  hours: MarketHoursLocal,
  calendar: readonly CalendarRow[],
): { timing: PublicationTiming; sessionD: string } {
  const at = new Date(publishedAtIso);
  const day = marketDate(at, hours.tz);
  if (!isTradingDay(day, calendar)) {
    return { timing: "pre_open", sessionD: nextTradingDay(day, calendar) };
  }
  const open = localToUtc(day, hours.open_time, hours.tz).getTime();
  const close =
    localToUtc(day, hours.close_time, hours.tz).getTime() + CLOSE_GRACE_MIN * MS_PER_MIN;
  const t = at.getTime();
  if (t < open) return { timing: "pre_open", sessionD: day };
  if (t < close) return { timing: "intraday", sessionD: day };
  return { timing: "post_close", sessionD: nextTradingDay(day, calendar) };
}

/** The archive's halt_kind of an announcement (null for any other). */
export function archiveHaltKind(type: string | null, title: string) {
  return watchNoticeKind(type, title);
}

const ROWS_PER_STATEMENT = 50; // threshold-ok: SQLite variable budget per statement

/**
 * INSERT OR IGNORE statements for the archive, 50 items each. `now` becomes known_at; a repeated item
 * (same source and ann_id) changes nothing.
 */
export function archiveStatements(
  items: readonly FeedItem[],
  market: string,
  source: string,
  now: string,
  hours: MarketHoursLocal,
  calendar: readonly CalendarRow[],
): InStatement[] {
  const stmts: InStatement[] = [];
  for (let i = 0; i < items.length; i += ROWS_PER_STATEMENT) {
    const slice = items.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      sql:
        "INSERT INTO announcement_archive (market, code, source, ann_id, published_at, known_at, " +
        "session_d, timing, type, price_sensitive, halt_kind, title) VALUES " +
        `${slice.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")} ON CONFLICT DO NOTHING`,
      args: slice.flatMap((r) => {
        const c = classifyPublication(r.publishedAt, hours, calendar);
        return [
          market,
          r.code,
          source,
          r.annId,
          r.publishedAt,
          now,
          c.sessionD,
          c.timing,
          r.type,
          r.priceSensitive ? 1 : 0,
          archiveHaltKind(r.type, r.title),
          r.title,
        ];
      }),
    });
  }
  return stmts;
}
