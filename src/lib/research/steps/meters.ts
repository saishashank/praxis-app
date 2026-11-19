// M23 night step "meters" (docs/M23_design.md, D-1613; task M3, D-1623 to D-1625, D-1720 to D-1723): the forward meters. Each night
// and enabled market it writes the live-tested progress rows (CXA-005), the six mover-rule rows with their one look each
// (CXA-014) and the intraday-stream row (VAL-120). It reads and writes only research_meter and its own registry rows (a write
// allowlist test covers it), runs per enabled market, and never throws past `runResearchNight`, which logs a failure and goes on.
// The three parts are independent: one that fails does not stop the others, and the step reports the failure at the end.
import { runIntradayMeter } from "../meters/intraday";
import { runLiveTested } from "../meters/liveTested";
import { runMovers } from "../meters/movers";
import type { ResearchStep } from "../night";

export const metersStep: ResearchStep = {
  name: "meters",
  plain: "updating the forward-sample counters",
  async run(db, o) {
    let failed = false;
    for (const part of [runLiveTested, runMovers, runIntradayMeter] as const) {
      try {
        await part(db, o);
      } catch {
        failed = true;
      }
    }
    // a part that could not finish is reported once by the seam, in plain words, after the others have run
    if (failed) throw new Error("a meter could not be written");
  },
};
