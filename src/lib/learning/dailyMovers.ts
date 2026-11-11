// D-921: why each of the session's biggest movers moved, from evidence only (pure). The cause rule is
// applied in this order and the first that fits wins:
//   price-sensitive announcement before the open        -> news_before_open
//   price-sensitive announcement during the day         -> news_during_day
//   its sector moved with it (>= 60 % of its move)      -> sector_move  (sector of >= 3 liquid shares)
//   the index moved with it (>= 50 % of its move)       -> market_move
//   volume at least 2x usual                            -> volume_no_news
//   otherwise                                           -> stock_specific
// Every cause text is one definite plain sentence with the numbers and no question mark.
import type { CalendarRow } from "@/lib/data/calendar";
import { homeProfile } from "@/lib/market/staticProfile.mjs";
import { isTradingDay, previousTradingDay } from "@/lib/data/calendar";
import type { MoverCause } from "./daily";
import { SECTOR_MIN } from "./dailyFeatures";

const MARKET_TZ: string = homeProfile().tz!;
/** ASX continuous trading opens at 10:00 Sydney and the close auction ends at about 16:10. */
const OPEN_HHMM = "10:00"; // threshold-ok: ASX open, Sydney time
const CLOSE_HHMM = "16:00"; // threshold-ok: ASX close, Sydney time (announcements after it wait for the next open)
const SECTOR_SHARE = 0.6; // threshold-ok: D-921 sector move explains the mover at 60 %
const INDEX_SHARE = 0.5; // threshold-ok: D-921 index move explains the mover at 50 %
const VOL_MULT = 2; // threshold-ok: D-921 volume at least 2x usual
const TITLE_MAX = 80; // threshold-ok: announcement title length shown
export const PPM = 1_000_000; // threshold-ok: parts per million
const PPM_PER_PCT = 10_000; // threshold-ok: ppm per percent

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: MARKET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Sydney date and HH:MM of an instant. */
export function sydneyParts(iso: string): { d: string; hhmm: string } {
  const parts = fmt.formatToParts(new Date(iso));
  const g = (k: string): string => parts.find((p) => p.type === k)?.value ?? "";
  const hh = g("hour") === "24" ? "00" : g("hour"); // threshold-ok: some engines print midnight as 24
  return { d: `${g("year")}-${g("month")}-${g("day")}`, hhmm: `${hh}:${g("minute")}` };
}

/**
 * The session after whose close (and before the next open) an announcement landed, or null when it came
 * during trading hours. A weekend or holiday announcement waits for the open after the last session.
 */
export function evening(iso: string, calendar: readonly CalendarRow[]): string | null {
  const s = sydneyParts(iso);
  try {
    if (!isTradingDay(s.d, calendar)) return previousTradingDay(s.d, calendar);
    if (s.hhmm >= CLOSE_HHMM) return s.d;
    if (s.hhmm < OPEN_HHMM) return previousTradingDay(s.d, calendar);
  } catch {
    return null; // no session found around it: not usable
  }
  return null;
}

/** Percent with a sign and one decimal: "+4.1%". */
export const pct = (ppm: number): string => {
  const v = Number((ppm / PPM_PER_PCT).toFixed(1)); // threshold-ok: one decimal
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`; // threshold-ok: one decimal
};

const x1 = (n: number): string => String(Number(n.toFixed(1))); // threshold-ok: one decimal

export type News = { readonly publishedAt: string; readonly title: string };

const cut = (t: string): string => (t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 3)}...` : t); // threshold-ok: ellipsis

export type CauseInput = {
  readonly movePpm: number;
  readonly indexMovePpm: number | null;
  readonly sectorName: string | null;
  /** Average move of the OTHER liquid shares of its sector that day. */
  readonly sectorMovePpm: number | null;
  /** Liquid shares in its sector, itself included. */
  readonly sectorShares: number;
  readonly volumeVsUsualPpm: number | null;
  /** Price-sensitive announcement titles after the previous close and before the open. */
  readonly newsBefore: readonly News[];
  /** Price-sensitive announcement titles during trading hours of the session. */
  readonly newsDuring: readonly News[];
};

const same = (a: number, b: number): boolean => Math.sign(a) === Math.sign(b) && a !== 0;

export function classifyCause(i: CauseInput): { cause: MoverCause; causeText: string } {
  const move = pct(i.movePpm);
  if (i.newsBefore.length > 0) {
    return {
      cause: "news_before_open",
      causeText: `Company news before the open: "${cut(i.newsBefore[0]!.title)}" (price-sensitive); the share moved ${move} on the day.`,
    };
  }
  if (i.newsDuring.length > 0) {
    return {
      cause: "news_during_day",
      causeText: `Company news during the day, after the open: "${cut(i.newsDuring[0]!.title)}" (price-sensitive); the share moved ${move} on the day.`,
    };
  }
  if (
    i.sectorName !== null &&
    i.sectorMovePpm !== null &&
    i.sectorShares >= SECTOR_MIN &&
    same(i.sectorMovePpm, i.movePpm) &&
    Math.abs(i.sectorMovePpm) >= SECTOR_SHARE * Math.abs(i.movePpm)
  ) {
    return {
      cause: "sector_move",
      causeText: `Sector-wide: ${i.sectorName} ${pct(i.sectorMovePpm)} on the day; it moved with its sector (${move}).`,
    };
  }
  if (
    i.indexMovePpm !== null &&
    same(i.indexMovePpm, i.movePpm) &&
    Math.abs(i.indexMovePpm) >= INDEX_SHARE * Math.abs(i.movePpm)
  ) {
    return {
      cause: "market_move",
      causeText: `Market-wide: the index moved ${pct(i.indexMovePpm)} and this share ${move}; it largely followed the market.`,
    };
  }
  if (i.volumeVsUsualPpm !== null && i.volumeVsUsualPpm >= VOL_MULT * PPM) {
    return {
      cause: "volume_no_news",
      causeText: `Heavy trading without news: volume was ${x1(i.volumeVsUsualPpm / PPM)}x its usual level and no price-sensitive announcement came out (${move}).`,
    };
  }
  const ctx: string[] = [];
  if (i.sectorName !== null && i.sectorMovePpm !== null)
    ctx.push(`${i.sectorName} ${pct(i.sectorMovePpm)}`);
  if (i.indexMovePpm !== null) ctx.push(`the index ${pct(i.indexMovePpm)}`);
  return {
    cause: "stock_specific",
    causeText: `Stock-specific: ${move} with no price-sensitive news, and neither its sector nor the market explains it${ctx.length > 0 ? ` (${ctx.join(", ")})` : ""}.`,
  };
}

/**
 * Splits a share's price-sensitive announcements around session `d` (previous session `prev`):
 * "before" arrived after the previous close and before the 10:00 open, "during" in trading hours.
 */
export function splitNews(
  anns: readonly News[],
  d: string,
  prev: string,
  calendar: readonly CalendarRow[],
): { before: News[]; during: News[] } {
  const before: News[] = [];
  const during: News[] = [];
  for (const a of anns) {
    const s = sydneyParts(a.publishedAt);
    if (evening(a.publishedAt, calendar) === prev) before.push(a);
    else if (s.d === d && s.hhmm >= OPEN_HHMM && s.hhmm < CLOSE_HHMM) during.push(a);
  }
  return { before, during };
}
