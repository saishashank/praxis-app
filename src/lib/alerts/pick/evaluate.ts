// M17 WP3: the pure alert transition (ARN-112..114, D-395). No clock, no database, no Cortex input:
// `evaluateAlert` takes the alert state, one delayed quote (or none) and a context.
// A stale quote or a quote without cumulative volume never produces a hit or a price clear
// (`isUsableForHit`); only the non-price transitions can happen without one.
import { isUsableForHit } from "@/lib/data/quotes/parse";
import type { DelayedQuote } from "@/lib/data/quotes/types";
import type { AlertState, EvalCtx, Transition } from "./types";

const PCT_SCALE = 100_000n; // threshold-ok: 1/1000 of a percent, exact bigint maths
const PCT_MILLI = 1000; // threshold-ok: percent -> milli-percent

/** Highest price at which the alert stays armed: limit raised by `chase_cap_pct` (D-395). */
export function chaseCapMicro(limitMicro: bigint, chaseCapPct: number): bigint {
  const milli = BigInt(Math.round(chaseCapPct * PCT_MILLI));
  return limitMicro + (limitMicro * milli) / PCT_SCALE;
}

export function evaluateAlert(
  s: AlertState,
  q: DelayedQuote | null,
  ctx: EvalCtx,
): Transition | null {
  if (s.state === "cleared") return null; // never re-armed (ARN-114)

  // Non-price transitions, in this precedence. They need no quote.
  if (ctx.muted) return { state: "cleared", reason: "muted" };
  if (ctx.filled) return { state: "cleared", reason: "filled" };
  if (!ctx.inList) return { state: "cleared", reason: "left_list" };
  if (ctx.halted) return { state: "cleared", reason: "halted" };
  // expired only without a hit (ARN-114 e)
  if (s.state !== "hit" && s.sessionsArmed > ctx.params.maxSessions)
    return { state: "cleared", reason: "expired" };

  // After a hit in this session a later rise or fall changes nothing (ARN-113).
  if (s.hitThisSession) return null;
  if (q === null) return null;
  if (!isUsableForHit(q, ctx.now, ctx.params.maxAgeMin, ctx.params.delayMin)) return null;

  const p = q.lastMicro;
  // below_stop only before any hit (ARN-114 b); above_chase_cap applies in any state
  if (s.state !== "hit" && p < s.stopMicro)
    return { state: "cleared", reason: "below_stop", quoteAt: q.quoteAt };
  if (p > chaseCapMicro(s.limitMicro, ctx.params.chaseCapPct)) {
    return { state: "cleared", reason: "above_chase_cap", quoteAt: q.quoteAt };
  }
  // Hit: at or below the limit and above the stop. Between limit and cap the alert stays armed.
  if (p <= s.limitMicro && p > s.stopMicro) {
    return { state: "hit", hitMicro: p, quoteAt: q.quoteAt };
  }
  return null;
}
