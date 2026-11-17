// Plain words for an opinion meter (M22 C4; D-1427, D-1520): one place, used by the Committee page and the System Health
// line. No internal code, no model or table name beyond the model versions the Owner already sees on the Committee page.
import { KIND_WORDS, type Meter } from "./meter";
import { PROMOTION_LINE } from "./promotion";

const PPM_PER_POINT = 10_000; // threshold-ok: ppm per percentage point

export const EARNED_TEXT = PROMOTION_LINE;

export type MeterView = {
  kind: Meter["kind"];
  label: string;
  settled: number;
  needed: number;
  /** "counting": the count is not met; "measured": met, not earned; "earned": all three conditions hold. */
  status: "counting" | "measured" | "earned";
  /** "37 of 150 settled cases so far". */
  progress: string;
  /** The lift with its lower bound, once the count is met. */
  lift: string | null;
  /** "Seen with 2 judge versions: a (40 cases, +1.2 points), b (31 cases, +0.4 points)". */
  versions: string | null;
  /** What the lift does not yet show, once the count is met and the review is not earned. */
  missing: string | null;
  /** The sentence of an earned review, with whether its request is on file. */
  earned: string | null;
};

const points = (ppm: number): string => {
  const p = ppm / PPM_PER_POINT;
  return `${p > 0 ? "+" : ""}${p.toFixed(2)} points`;
};
const cases = (n: number): string => `${n} ${n === 1 ? "case" : "cases"}`;

/** Pure: the words of one meter. `requested` says whether the request is on file. */
export function viewOf(m: Meter, requested: boolean): MeterView {
  const status: MeterView["status"] = m.earned
    ? "earned"
    : m.conditions.enough
      ? "measured"
      : "counting";
  const progress = `${m.settled}${m.capped ? "+" : ""} of ${m.needed} settled ${m.needed === 1 ? "case" : "cases"} so far`;
  const lift =
    m.lift === null
      ? null
      : `Cases the opinion favoured beat the ones it marked down by ${points(m.lift.ppm)} (at least ${points(m.lift.lower90Ppm)} with 90 % confidence; ${m.lift.forN} favoured, ${m.lift.againstN} marked down)`;
  const versions =
    m.versions.length === 0
      ? null
      : `Judge versions seen: ${m.versions
          .map(
            (v) =>
              `${v.model} (${cases(v.n)}${v.liftPpm === null ? "" : `, ${points(v.liftPpm)}`})`,
          )
          .join(", ")}`;
  let missing: string | null = null;
  if (m.conditions.enough && !m.earned) {
    const gaps: string[] = [];
    if (m.lift === null) gaps.push("there are too few cases on one side to measure a gap");
    else if (!m.conditions.liftPositive) gaps.push("the gap could still be chance");
    if (!m.conditions.stable) gaps.push("it does not yet hold in two judge versions");
    missing = `Not yet a review: ${gaps.join(", and ")}.`;
  }
  return {
    kind: m.kind,
    label: KIND_WORDS[m.kind],
    settled: m.settled,
    needed: m.needed,
    status,
    progress,
    lift,
    versions,
    missing,
    earned: m.earned
      ? `${EARNED_TEXT}${requested ? "." : " (the request is being written)."}`
      : null,
  };
}
