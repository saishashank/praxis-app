// M23 night step "monitors" (docs/M23_design.md, D-1613): a pass-through stub from task A1. Owned later by task M1
// (residual monitors 1 to 4, D-1614 to D-1618), which replaces the body of `run`; task M2 then extends the same file with
// monitors 5 to 8 (D-1619 to D-1622, the M1 to M2 hand-off). It reads and writes only `residual_monitor` (its write
// allowlist test is part of the owner's task), runs per enabled market, and never throws past `runResearchNight`, which
// logs a failure and goes on.
import type { ResearchStep } from "../night";

export const monitorsStep: ResearchStep = {
  name: "monitors",
  plain: "reading the background watches",
  async run() {
    // stub: nothing to do until task M1 lands
  },
};
