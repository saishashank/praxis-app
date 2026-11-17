// M23 night step "sectorIndex" (docs/M23_design.md, D-1613): a pass-through stub from task A1. Owned later by task S1
// (the sector index series, D-1632 and D-1633), which replaces the body of `run`; no other task edits this file. It reads and writes only sector_index (its write
// allowlist test is part of the owner's task), runs per enabled market, and never throws past `runResearchNight`, which
// logs a failure and goes on.
import type { ResearchStep } from "../night";

export const sectorIndexStep: ResearchStep = {
  name: "sectorIndex",
  plain: "building the industry-group index series",
  async run() {
    // stub: nothing to do until task S1 lands
  },
};
