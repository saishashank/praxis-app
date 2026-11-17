// M23 night step "labelEval" (docs/M23_design.md, D-1613): a pass-through stub from task A1. Owned later by task M3
// (the label evaluation, D-1625), which replaces the body of `run`; no other task edits this file. It reads and writes only research_meter and its own result rows (its write
// allowlist test is part of the owner's task), runs per enabled market, and never throws past `runResearchNight`, which
// logs a failure and goes on.
import type { ResearchStep } from "../night";

export const labelEvalStep: ResearchStep = {
  name: "labelEval",
  plain: "scoring the announcement labels",
  async run() {
    // stub: nothing to do until task M3 lands
  },
};
