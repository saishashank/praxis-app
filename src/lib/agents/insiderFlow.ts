// A2 insider / flow score (M4 T6; AGT-105; docs/M4_design.md 2.1, 2.5, decision 13). Score in
// quarter units (-4..+4, 0.25 = 1) = clip(director net on-market buying over the window: +/- the
// director weight; new or increased substantial holder +, decreased -), from notice PUBLICATION
// times only. When no notice source has run (no insider_notice coverage), the score is NULL
// ("unknown"), never 0: a known 0 means notices exist and net to nothing. Weights and the window
// are AgentParams.
import {
  localToUtc,
  previousTradingDay,
  type CalendarRow,
  type MarketHours,
} from "@/lib/data/calendar";
import {
  addRat,
  cmpRat,
  makeRational,
  mulRat,
  negRat,
  ratFromInt,
  type Rational,
} from "@/lib/money/rational";
import type { InsiderFlowScoreRow } from "./schema";
import type { AgentParams } from "./params";
import type { DecisionView, NoticeRow } from "./decisionView";
import { roundHalfAway } from "./regime";

const QUARTERS_PER_UNIT = 4n; // threshold-ok: stored score is in quarter units, the range is [-1, +1]
const MIDNIGHT = "00:00";

export type InsiderInputs = {
  readonly covered: boolean;
  readonly director_net: -1 | 0 | 1;
  readonly holder_up: boolean;
  readonly holder_down: boolean;
  readonly notices: number;
};

export type InsiderScore = { score_q: number | null; inputs: InsiderInputs };

/** Net director direction: by value when every director notice carries one, else by count. */
function directorDirection(notices: readonly NoticeRow[]): -1 | 0 | 1 {
  const dir = notices.filter((n) => n.kind === "director_buy" || n.kind === "director_sell");
  if (dir.length === 0) return 0;
  const valued = dir.every((n) => n.value_micro !== null);
  let net = 0n;
  for (const n of dir) {
    const amount = valued ? n.value_micro! : 1n;
    net += n.kind === "director_buy" ? amount : -amount;
  }
  return net > 0n ? 1 : net < 0n ? -1 : 0;
}

/** The AGT-105 score from the window's notices (pure). `covered` false = unknown. */
export function insiderFlowScore(
  notices: readonly NoticeRow[],
  covered: boolean,
  p: AgentParams,
): InsiderScore {
  const dirn = directorDirection(notices);
  const up = notices.some((n) => n.kind === "sh_new" || n.kind === "sh_increase");
  const down = notices.some((n) => n.kind === "sh_decrease");
  const inputs: InsiderInputs = {
    covered,
    director_net: dirn,
    holder_up: up,
    holder_down: down,
    notices: notices.length,
  };
  if (!covered) return { score_q: null, inputs };
  let total: Rational = ratFromInt(0n);
  if (dirn > 0) total = addRat(total, p.insiderWeights.directorNet);
  // AGT-136: net director selling uses its own weight (defaults to director_net: v1)
  if (dirn < 0) total = addRat(total, negRat(p.insiderWeights.directorSale));
  if (up) total = addRat(total, p.insiderWeights.holderNewOrIncrease);
  if (down) total = addRat(total, negRat(p.insiderWeights.holderDecrease));
  const one = ratFromInt(1n);
  const clipped =
    cmpRat(total, one) > 0 ? one : cmpRat(total, negRat(one)) < 0 ? negRat(one) : total;
  return {
    score_q: Number(roundHalfAway(mulRat(clipped, makeRational(QUARTERS_PER_UNIT, 1n)))),
    inputs,
  };
}

/** First session of the window of `sessions` sessions ending on D. */
export function insiderWindowStart(
  d: string,
  sessions: number,
  calendar: readonly CalendarRow[],
): string {
  let start = d;
  for (let i = 1; i < sessions; i++) start = previousTradingDay(start, calendar);
  return start;
}

/** Canonical JSON of the inputs (fixed key order) for insider_flow_score.inputs_json. */
export function insiderInputsJson(inputs: InsiderInputs): string {
  return JSON.stringify({
    covered: inputs.covered,
    director_net: inputs.director_net,
    holder_down: inputs.holder_down,
    holder_up: inputs.holder_up,
    notices: inputs.notices,
  });
}

/** The row for (code, D), read through the view (notices published before the cut-off). */
export async function insiderFlowFor(
  view: DecisionView,
  code: string,
  p: AgentParams,
  calendar: readonly CalendarRow[],
  hours: MarketHours,
): Promise<InsiderFlowScoreRow> {
  const start = insiderWindowStart(view.guardD, p.insiderWindowSessions, calendar);
  const sinceIso = localToUtc(start, MIDNIGHT, hours.tz).toISOString();
  const covered = await view.insiderCoverage();
  const notices = covered ? await view.insiderNotices(code, sinceIso) : [];
  const score = insiderFlowScore(notices, covered, p);
  return {
    market: view.market,
    code,
    d: view.guardD,
    score_q: score.score_q,
    inputs_json: insiderInputsJson(score.inputs),
  };
}
