// M23 night step "lookSync" (docs/M23_design.md, D-1613): a pass-through stub from task A1. Owned later by task A2
// (the registry ledger import, D-1607), which replaces the body of `run`; no other task edits this file. It reads and writes only research_prereg, holdout_look and research_result, through the registry gate (its write
// allowlist test is part of the owner's task), runs per enabled market, and never throws past `runResearchNight`, which
// logs a failure and goes on.
import type { ResearchStep } from "../night";

export const lookSyncStep: ResearchStep = {
  name: "lookSync",
  plain: "importing the recorded results of tests run elsewhere",
  async run() {
    // stub: nothing to do until task A2 lands
  },
};
