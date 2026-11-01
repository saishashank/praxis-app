// M17 / V2-S5 (D-694, D-695): the armed-pick reserve of the shared delayed-quote budget. Armed
// buy-price alerts (O-74) keep priority over watch-list and held-code polling: the requests they
// need until the end of the poll window are set aside before anything else spends the day's budget.
// Pure; no I/O.
import { QUOTE_STOP_AT } from "@/lib/data/quotes/budget";

const MS_PER_MIN = 60_000; // threshold-ok: unit

/** Poll ticks left in the window, this one included (>= 1 inside the window). */
export function remainingPollTicks(now: Date, windowEnd: Date, stepMin: number): number {
  const step = Math.max(1, stepMin) * MS_PER_MIN;
  return Math.max(1, Math.floor((windowEnd.getTime() - now.getTime()) / step) + 1);
}

/** Requests to keep for `armed` codes on this and every later tick of the window. */
export const armedReserve = (armed: number, ticksLeft: number): number =>
  Math.max(0, armed) * Math.max(1, ticksLeft);

/**
 * How often the non-armed codes (watch list, held) may be polled: 1 = every tick, k = every k-th
 * tick, 0 = not at all. Sized so `extras` codes per polled tick fit in what is left under the stop
 * line after the armed reserve (a slower cadence instead of stopping, D-695).
 */
export function extrasCadence(p: {
  dayMax: number;
  usedToday: number;
  armed: number;
  ticksLeft: number;
  extras: number;
}): number {
  if (p.extras <= 0) return 0;
  const room =
    Math.floor(p.dayMax * QUOTE_STOP_AT) - p.usedToday - armedReserve(p.armed, p.ticksLeft);
  const affordable = Math.floor(room / p.extras);
  if (affordable <= 0) return 0;
  return affordable >= p.ticksLeft ? 1 : Math.ceil(p.ticksLeft / affordable);
}
