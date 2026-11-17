// M23 night step "shockStops" (docs/M23_design.md, D-1613): a pass-through stub from task A1. Owned later by task T4
// (the SHOCK comparator, D-1638), which replaces the body of `run`; no other task edits this file. It reads and writes only shock_stop_outcome (its write
// allowlist test is part of the owner's task), runs per enabled market, and never throws past `runResearchNight`, which
// logs a failure and goes on.
import type { ResearchStep } from "../night";

export const shockStopsStep: ResearchStep = {
  name: "shockStops",
  plain: "comparing the two stop rules after a shock",
  async run() {
    // stub: nothing to do until task T4 lands
  },
};
