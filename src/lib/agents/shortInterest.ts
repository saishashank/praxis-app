// A2 short-interest delta (M4 T6; DAT-125a, F6 class (d); docs/M4_design.md 2.5). The ASIC daily
// aggregate short position is stored as integer parts-per-million. Class (d) holds when the value
// at the last as_of usable at the cut-off minus the value `window` sessions earlier is at most
// -short_drop_pp x 10,000 ppm. A missing value at either end gives "unknown" (class (d) not
// available), never false and never 0.
import { previousTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { cmpRat, makeRational, mulRat, negRat, ratFromInt } from "@/lib/money/rational";
import type { AgentParams } from "./params";
import type { DecisionView, ShortInterestPoint } from "./decisionView";

const PPM_PER_PP = 10_000n; // threshold-ok: one percentage point is 10,000 ppm

export type ShortInterestDelta = {
  readonly latest_as_of: string | null;
  readonly prior_as_of: string | null;
  readonly latest_ppm: number | null;
  readonly prior_ppm: number | null;
  /** latest - prior in ppm; null = unknown. */
  readonly delta_ppm: number | null;
  /** F6 class (d): true / false, or "unknown" when a value is missing. */
  readonly drop: boolean | "unknown";
};

const UNKNOWN: ShortInterestDelta = {
  latest_as_of: null,
  prior_as_of: null,
  latest_ppm: null,
  prior_ppm: null,
  delta_ppm: null,
  drop: "unknown",
};

/** Pure: `points` are the usable points (any order); `calendar` gives the session count back. */
export function shortInterestDelta(
  points: readonly ShortInterestPoint[],
  calendar: readonly CalendarRow[],
  p: AgentParams,
): ShortInterestDelta {
  if (points.length === 0) return UNKNOWN;
  const sorted = [...points].sort((a, b) => (a.as_of < b.as_of ? 1 : a.as_of > b.as_of ? -1 : 0));
  const latest = sorted[0]!;
  let target = latest.as_of;
  for (let i = 0; i < p.windows.shortInterest; i++) target = previousTradingDay(target, calendar);
  const prior = sorted.find((s) => s.as_of === target);
  if (prior === undefined) {
    return {
      ...UNKNOWN,
      latest_as_of: latest.as_of,
      latest_ppm: latest.short_ppm,
      prior_as_of: target,
    };
  }
  const delta = latest.short_ppm - prior.short_ppm;
  const limit = negRat(mulRat(p.f6.shortDropPp, makeRational(PPM_PER_PP, 1n)));
  return {
    latest_as_of: latest.as_of,
    prior_as_of: target,
    latest_ppm: latest.short_ppm,
    prior_ppm: prior.short_ppm,
    delta_ppm: delta,
    drop: cmpRat(ratFromInt(BigInt(delta)), limit) <= 0,
  };
}

/** Reads the usable points through the view and computes the delta for D. */
export async function shortInterestFor(
  view: DecisionView,
  code: string,
  p: AgentParams,
  calendar: readonly CalendarRow[],
): Promise<ShortInterestDelta> {
  // Enough newest-first points to reach the one `window` sessions before the latest (calendar
  // gaps and weekends do not matter: the lookup is by exact as_of).
  const limit = p.windows.shortInterest * 2 + p.windows.shortInterest;
  const points = await view.shortInterest(code, limit);
  return shortInterestDelta(points, calendar, p);
}
