// What the nightly Cortex run carries for the movers gap additions (CR-MOV-A1, A2, A4; D-743…D-747).
// Plain data produced by the store (cortex/store/movers.ts) and read by the pure core: the latest halt
// watch per code, the predicted result dates per code and the parameters. Absent on a night (replay,
// offline, an old caller) = the original gates only, byte for byte.
import type { CalendarRow } from "@/lib/data/calendar";
import type { MoversGateInput } from "./gates/movers";
import { inResultsWindow, sessionsToNextDate } from "./gates/resultsSeason";
import type { HaltWatchView } from "./states/haltWatch";
import type { MoversParams } from "./moversParams";

export type MoversNight = {
  readonly params: MoversParams;
  /** Latest watch row per code (open, or resumed recently enough to matter). */
  readonly haltWatch: ReadonlyMap<string, HaltWatchView>;
  /** Predicted result dates >= the night's date per code (sorted); empty until a year of archive exists. */
  readonly knownDates: ReadonlyMap<string, readonly string[]>;
};

/** The step 8 movers input of one code tonight (pure). */
export function moversGateInput(x: {
  readonly d: string;
  readonly sessions: readonly string[];
  readonly calendar: readonly CalendarRow[];
  readonly movers: MoversNight;
  readonly code: string;
  readonly family: string;
  readonly shortRisk: boolean;
}): MoversGateInput {
  const dates = x.movers.knownDates.get(x.code) ?? [];
  return {
    family: x.family,
    haltWatch: x.movers.haltWatch.get(x.code) ?? null,
    sessionsToKnownDate: sessionsToNextDate(x.d, dates, x.calendar),
    inResultsWindow: inResultsWindow(x.d, x.movers.params),
    shortRisk: x.shortRisk,
    sessions: x.sessions,
    d: x.d,
    params: x.movers.params,
  };
}
