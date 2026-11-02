// The halt-watch line of the Evening Review (CR-MOV-A1; D-744): one "needs attention" entry per code
// that is halted or suspended and may resume, with the reason class the notice pointed to and what
// Praxis does (nothing is bought or sold on a halt; the intraday watch looks at the resume). The wording
// is qualitative on purpose: no figure of any past resume is quoted (SEC-110, uncalibrated).
import { loadMoversParams, openHaltWatches } from "@/lib/cortex/store/movers";
import type { HaltReasonClass } from "@/lib/cortex/states/haltWatch";
import type { AttentionItem } from "@/lib/email/templates/review";
import type { Ctx } from "./sections";

const REASON_WORD: Readonly<Record<HaltReasonClass, string>> = {
  capital_raise: "a share issue",
  takeover: "a possible deal",
  material_announcement: "a company announcement",
  regulatory: "a regulator or exchange query",
  unknown: "a reason not stated in the notice",
};

const EXPECTATION: Readonly<Record<string, string>> = {
  "-1": "Past resumes after a share issue have mostly fallen.",
  "0": "The direction of the resume is not known.",
  "1": "Past resumes after a possible deal have mostly risen.",
};

/** One attention item per open halt watch of the review date. */
export async function haltAttentionItems(c: Ctx): Promise<AttentionItem[]> {
  const params = await loadMoversParams(c.db);
  const open = await openHaltWatches(
    c.db,
    c.market,
    c.d,
    params.haltWatchExpirySessions,
    c.calendar,
  );
  return open.map((w) => ({
    name: `${w.code} is in a trading halt (${REASON_WORD[w.reasonClass]})`,
    status: "attention" as const,
    daysOpen: 1,
    fix: `${EXPECTATION[String(w.expectedSign)] ?? EXPECTATION["0"]!} Nothing is bought or sold while it is halted; Praxis looks at the first prices after it resumes.`,
  }));
}
