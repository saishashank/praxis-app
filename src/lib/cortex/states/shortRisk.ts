// Short interest as an event-risk flag (CR-MOV-A4; D-747). Not a score input and not a direction: a
// heavily shorted or fast-shorted name moves further either way, so it gets a smaller parcel (D7
// sizing), optionally no dip-buy entry (key `short_risk_f4_veto`), and a plain note on the card.
// Pure over the view's short points (newest first, usable at the cut-off = knownTime lag applied).
import type { ShortPoint } from "../pit/types";
import type { MoversParams } from "../moversParams";

const PPM_PER_PP = 10_000; // threshold-ok: one percentage point is 10,000 ppm
/** The change is read over this many reports (the study's 20-report change). */
export const SHORT_RISK_REPORTS = 20; // threshold-ok: reports back for the rise test

export type ShortRisk = {
  readonly flag: boolean;
  /** Latest published short position, percent; null when none is usable. */
  readonly pct: number | null;
  /** Change against the report SHORT_RISK_REPORTS back, percentage points; null when not available. */
  readonly changePp: number | null;
  readonly reason: "level" | "rise" | null;
};

export const NO_SHORT_RISK: ShortRisk = { flag: false, pct: null, changePp: null, reason: null };

export function shortRisk(
  points: readonly ShortPoint[],
  p: Pick<MoversParams, "shortRiskPctMin" | "shortRiskChangePpMin">,
): ShortRisk {
  const latest = points[0];
  if (latest === undefined) return NO_SHORT_RISK;
  const pct = latest.ppm / PPM_PER_PP;
  const back = points[SHORT_RISK_REPORTS];
  const changePp = back === undefined ? null : (latest.ppm - back.ppm) / PPM_PER_PP;
  const level = pct >= p.shortRiskPctMin;
  const rise = changePp !== null && changePp >= p.shortRiskChangePpMin;
  return {
    flag: level || rise,
    pct,
    changePp,
    reason: level ? "level" : rise ? "rise" : null,
  };
}
