// M17 WP5: indicative limit and stop (AGT-143), for display and e-mail only, "indicative, delayed
// data". stop = last - k x ATR (the family default stop rule on the delayed price);
// limit = min(last x 1.08, stop / (1 - 0.12)). Integer micro arithmetic; null when not computable.
export const LIMIT_UP_PERCENT = 8n; // threshold-ok: AGT-143
export const LIMIT_STOP_PERCENT = 12n; // threshold-ok: AGT-143
const HUNDRED = 100n; // threshold-ok: percent
const PPM = 1_000_000n; // threshold-ok: unit

export type FamilyStopRule = {
  /** ATR(20) in micro-AUD from the last end-of-day bars. */
  atrMicro: bigint;
  /** Stop distance in ATR, parts per million (2 x ATR = 2,000,000). */
  multPpm: bigint;
};

export type IndicativeLevels = { limitMicro: bigint; stopMicro: bigint };

export function indicativeLevels(
  lastMicro: bigint,
  rule: FamilyStopRule | null,
): IndicativeLevels | null {
  if (rule === null || lastMicro <= 0n || rule.atrMicro <= 0n || rule.multPpm <= 0n) return null;
  const stopMicro = lastMicro - (rule.atrMicro * rule.multPpm) / PPM;
  if (stopMicro <= 0n || stopMicro >= lastMicro) return null;
  const byLast = (lastMicro * (HUNDRED + LIMIT_UP_PERCENT)) / HUNDRED;
  const byStop = (stopMicro * HUNDRED) / (HUNDRED - LIMIT_STOP_PERCENT);
  return { limitMicro: byLast < byStop ? byLast : byStop, stopMicro };
}
