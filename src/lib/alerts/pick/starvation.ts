// OPS-109 c (M18, D-971): quote starvation. A held position is "starved" when its newest delayed
// quote (`quote_latest.fetched_at`) is older than `minutes` while the poll window is open on a
// trading day. Pure: the poll tick reads the rows and the window and raises the S2 `quote_starvation`
// incident once a day. Nothing here reads a clock, a database or a code's name for the Owner line.

/** Minutes without a fresh quote before a held code is starved. */
export const STARVATION_MINUTES = 30; // threshold-ok: D-971 (OPS-109 c)

export type StarvationWindow = { start: Date; end: Date };

export type StarvationOptions = {
  minutes: number;
  /** The poll window of a trading day (UTC instants); null on a weekend or holiday. */
  window: StarvationWindow | null;
};

const MS_PER_MIN = 60_000; // threshold-ok: unit

/**
 * The held codes (sorted) with no fresh quote. `latestFetchedAt` maps a code to the ISO time of its
 * newest stored quote; a missing or unparsable value counts as "no quote", measured from the start of
 * the window so a quote of an earlier day never starts the clock before the day's first poll.
 */
export function starved(
  heldCodes: Iterable<string>,
  latestFetchedAt: ReadonlyMap<string, string | null>,
  now: Date,
  opts: StarvationOptions,
): string[] {
  const w = opts.window;
  if (w === null) return [];
  const t = now.getTime();
  if (t < w.start.getTime() || t > w.end.getTime()) return [];
  const limit = opts.minutes * MS_PER_MIN;
  const out: string[] = [];
  for (const code of new Set(heldCodes)) {
    const raw = latestFetchedAt.get(code);
    const parsed = raw === undefined || raw === null ? Number.NaN : new Date(raw).getTime();
    const last = Math.max(Number.isNaN(parsed) ? w.start.getTime() : parsed, w.start.getTime());
    if (t - last > limit) out.push(code);
  }
  return out.sort();
}
