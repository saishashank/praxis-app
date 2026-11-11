// Synthetic ZZ world for the learning Cortex tests (D-923). 40 liquid ZZ codes; on the evening before D
// angle A-D1-02 ranks them in the order of the next day's return (perfect), A-D2-01 in the reverse
// order, A-D1-06 gives everyone the same value, and the gate A-D1-09 is stored but never scored.
import { previousTradingDay } from "@/lib/data/calendar";
import type { CloseBar, FeatureNight, ScorecardInput } from "@/lib/cortex/learn/scorecard";

export const D = "2026-11-10"; // Tuesday
export const AFTER = "2026-11-11";
export const N_CODES = 40;
export const codes = (n = N_CODES): string[] =>
  Array.from({ length: n }, (_, i) => `ZZ${String(i + 1).padStart(3, "0")}`);

export const back = (d: string, n: number): string => {
  let t = d;
  for (let i = 0; i < n; i += 1) t = previousTradingDay(t, []);
  return t;
};
export const PREV = back(D, 1);
export const BACK21 = back(D, 21);

/** Rank-standardised value of the k-th of n (1-based) in [-1, 1]. */
export const rankVal = (k: number, n = N_CODES): number => (2 * (k - 1)) / (n - 1) - 1;

/** Weekday sessions from..to inclusive. */
export function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const t = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (t <= end) {
    if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}

/** Code k: close 10 on every session except D (+k per mille), D-21 (so the 20-session return is
 *  +2k per mille) and the day after D (a big move nothing may read). */
export function bars(
  n = N_CODES,
  extra: Partial<Record<string, number>> = {},
): Map<string, CloseBar[]> {
  const out = new Map<string, CloseBar[]>();
  codes(n).forEach((code, i) => {
    const k = i + 1;
    const list: CloseBar[] = weekdays("2026-09-01", AFTER).map((d) => {
      let c = 10;
      if (d === D) c = 10 * (1 + k / 1000);
      if (d === BACK21) c = 10 / (1 + k / 500);
      if (d === AFTER) c = extra[code] ?? 5;
      return { d, c };
    });
    out.set(code, list);
  });
  return out;
}

export function featureNight(
  d: string,
  n = N_CODES,
  value: (k: number, angle: string) => unknown = (k, a) =>
    a === "A-D1-02" ? rankVal(k, n) : a === "A-D2-01" ? -rankVal(k, n) : a === "A-D1-06" ? 0.5 : 1,
): FeatureNight {
  return {
    d,
    rows: codes(n).map((code, i) => ({
      code,
      features: Object.fromEntries(
        ["A-D1-02", "A-D2-01", "A-D1-06", "A-D1-09"].map((a) => [a, value(i + 1, a)]),
      ),
      activeSetHash: "zzhash",
      manifestId: "zzmanifest",
    })),
  };
}

export function input(over: Partial<ScorecardInput> = {}): ScorecardInput {
  return {
    market: "AU",
    d: D,
    featuresPrev: featureNight(PREV),
    featuresBack20: featureNight(BACK21),
    end20: PREV,
    bars: bars(),
    liquidCodes: codes(),
    movers: [],
    regimes: new Map([[PREV, "RISK-ON"]]),
    resultsSeason: () => false,
    prior60: null,
    ...over,
  };
}
