// M23 night step "labelEval" (docs/M23_design.md, D-1613; task M3, D-1636, D-1722): the automatic label evaluation and the late
// `ann_labels` look. It reads the golden, label, archive and bar tables and writes only research_meter, research_prereg,
// holdout_look, research_result, holdout_look_refusal and app_log (a write allowlist test covers it), runs per enabled market,
// and never throws past `runResearchNight`, which logs a failure and goes on. No panel source is wired in M23 for the late
// look (D-1692): until one is, it is not taken.
import { runAnnLabelsLate, runLabels } from "../meters/labels";
import type { ResearchStep } from "../night";

export const labelEvalStep: ResearchStep = {
  name: "labelEval",
  plain: "scoring the announcement labels",
  async run(db, o) {
    let failed = false;
    try {
      await runLabels(db, o);
    } catch {
      failed = true;
    }
    try {
      await runAnnLabelsLate(db, o);
    } catch {
      failed = true;
    }
    if (failed) throw new Error("a label evaluation could not finish");
  },
};
