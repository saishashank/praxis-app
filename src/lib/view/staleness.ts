// Stale-data rules for the pages (docs/M7_design.md 2.10, UX-102). Each section says when its data was
// last good; a section older than its allowance shows a banner with that time instead of silently
// showing old numbers. Pure: the clock is a parameter.
import { formatTime } from "@/lib/health/format";

export type Staleness =
  | { state: "missing"; text: string }
  | { state: "fresh"; lastGood: string; ageMinutes: number; text: string }
  | { state: "stale"; lastGood: string; ageMinutes: number; text: string };

const MS_PER_MINUTE = 60_000; // threshold-ok: unit conversion
const MS_PER_DAY = 86_400_000; // threshold-ok: unit conversion

/**
 * `lastGood` is a stored UTC instant. `maxAgeMinutes` is how old the data may be and still be fresh.
 * A missing, unparseable or future-dated instant is "missing" (never shown as fresh).
 */
export function staleness(
  lastGood: string | null | undefined,
  now: Date,
  maxAgeMinutes: number,
): Staleness {
  const t = typeof lastGood === "string" ? Date.parse(lastGood) : NaN;
  if (!Number.isFinite(t) || t > now.getTime() + MS_PER_MINUTE) {
    return { state: "missing", text: "No data yet" };
  }
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - t) / MS_PER_MINUTE));
  const when = formatTime(lastGood as string);
  if (ageMinutes > maxAgeMinutes) {
    return {
      state: "stale",
      lastGood: lastGood as string,
      ageMinutes,
      text: `Showing data from ${when}. It has not updated since.`,
    };
  }
  return { state: "fresh", lastGood: lastGood as string, ageMinutes, text: `Updated ${when}` };
}

/** Whole calendar days between two YYYY-MM-DD dates (later minus earlier), or null if either is malformed. */
export function daysBetween(earlier: string, later: string): number | null {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(earlier) || !re.test(later)) return null;
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / MS_PER_DAY) : null;
}

/** A date-keyed dataset (a nightly run) is stale when its date is more than `maxDays` behind today. */
export function dateStaleness(
  lastD: string | null | undefined,
  todayD: string,
  maxDays: number,
): Staleness {
  const gap = typeof lastD === "string" ? daysBetween(lastD, todayD) : null;
  if (gap === null || gap < 0) return { state: "missing", text: "No data yet" };
  const ageMinutes = gap * 24 * 60; // threshold-ok: minutes per day
  if (gap > maxDays) {
    return {
      state: "stale",
      lastGood: lastD as string,
      ageMinutes,
      text: `Showing data from ${lastD}. It has not updated since.`,
    };
  }
  return { state: "fresh", lastGood: lastD as string, ageMinutes, text: `Data for ${lastD}` };
}
