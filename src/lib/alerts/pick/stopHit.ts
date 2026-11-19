// M21 C3 (EML-043, D-1226): the stop-hit e-mail trigger. Pure: no clock, no database. An alert whose latest
// state is `hit` stays under watch (the poll evaluates every alert that is not `cleared`), so its code has
// a delayed quote in every tick. The mail is due when that quote is usable (fresh, with cumulative volume,
// `isUsableForHit`) and the price is under the alert's stop. Information only: no `pick_alert` row, no
// order. Once per alert and session is the e-mail key's job (`emailKeys.pickStopHit`).
import { isUsableForHit } from "@/lib/data/quotes/parse";
import type { DelayedQuote } from "@/lib/data/quotes/types";
import type { AlertStateName } from "./types";

export type StopHitParams = {
  now: Date;
  /** 2 x `intraday_refresh_min`. */
  maxAgeMin: number;
  /** `intraday_quote_delay_min`. */
  delayMin: number;
};

/** True when a hit alert's delayed price is under its stop (a stale or volume-less quote is never due). */
export function stopHitDue(
  alert: { state: AlertStateName; stopMicro: bigint },
  quote: DelayedQuote | null,
  p: StopHitParams,
): boolean {
  if (alert.state !== "hit" || quote === null) return false;
  if (!isUsableForHit(quote, p.now, p.maxAgeMin, p.delayMin)) return false;
  return quote.lastMicro < alert.stopMicro;
}

/** One due stop-hit mail: the alert's own facts and the delayed quote that crossed the stop. */
export type StopHitItem = {
  alertId: string;
  userId: string;
  market: string;
  pickD: string;
  profile: string;
  rank: number;
  code: string;
  limitMicro: bigint;
  stopMicro: bigint;
  lastMicro: bigint;
  quoteAt: string;
};
