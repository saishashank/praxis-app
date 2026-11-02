// The movers gap gate additions (CR-MOV-A1, A2, A4; D-743, D-745, D-747): three sub-checks of step 8
// (event and state vetoes) that run after the five existing ones, so an old night never changes. Pure.
//   8f_halt_resume  no F4 / F6 entry while a halt watch with a zero or negative expectation is open,
//                   nor on the resume day (haltWatch.ts)
//   8g_known_date   no F4 entry within `results_pre_window_sessions` of a company's known results date
//   8h_short_risk   no F4 entry in a heavily shorted name when `short_risk_f4_veto` is on
// The results window (Feb / Aug) is a timing flag, never a veto on its own (A-D8-04 is a timing flag).
import { haltResumeVeto, type HaltWatchView } from "../states/haltWatch";
import type { MoversParams } from "../moversParams";

export type MoversGateInput = {
  readonly family: string;
  readonly haltWatch: HaltWatchView | null;
  /** Sessions from tonight to the code's next predicted results date; null = none known. */
  readonly sessionsToKnownDate: number | null;
  readonly inResultsWindow: boolean;
  readonly shortRisk: boolean;
  readonly sessions: readonly string[];
  readonly d: string;
  readonly params: Pick<
    MoversParams,
    | "haltResumeBlockSessions"
    | "haltWatchExpirySessions"
    | "resultsPreWindowSessions"
    | "shortRiskF4Veto"
  >;
};

export type MoversSub = "8f_halt_resume" | "8g_known_date" | "8h_short_risk";

const DIP_BUY_FAMILY = "F4";

/** The first failing movers sub-check in list order, or null. */
export function moversSubFail(x: MoversGateInput): { sub: MoversSub; value: string } | null {
  const halt = haltResumeVeto({
    watch: x.haltWatch,
    family: x.family,
    d: x.d,
    sessions: x.sessions,
    params: x.params,
  });
  if (halt !== null) return { sub: "8f_halt_resume", value: halt };
  if (
    x.family === DIP_BUY_FAMILY &&
    x.params.resultsPreWindowSessions > 0 &&
    x.sessionsToKnownDate !== null &&
    x.sessionsToKnownDate >= 0 &&
    x.sessionsToKnownDate <= x.params.resultsPreWindowSessions
  ) {
    return { sub: "8g_known_date", value: `in:${x.sessionsToKnownDate}` };
  }
  if (x.family === DIP_BUY_FAMILY && x.params.shortRiskF4Veto && x.shortRisk) {
    return { sub: "8h_short_risk", value: "heavily_shorted" };
  }
  return null;
}
