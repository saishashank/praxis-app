// M23 night step "annCalibration" (docs/M23_design.md, D-1613): a pass-through stub from task A1. Owned later by task T2
// (the announcement-angle trigger, D-1635), which replaces the body of `run`; no other task edits this file. It reads and writes only its own result rows (its write
// allowlist test is part of the owner's task), runs per enabled market, and never throws past `runResearchNight`, which
// logs a failure and goes on.
import type { ResearchStep } from "../night";

export const annCalibrationStep: ResearchStep = {
  name: "annCalibration",
  plain: "checking announcement categories against outcomes",
  async run() {
    // stub: nothing to do until task T2 lands
  },
};
