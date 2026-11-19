// Research engine, sector rank IC (M23 R1; D-1605, D-1634). Pure, seeded. A monthly panel: each month holds some groups
// (sector groups), each with a member count, a signal and an outcome. The statistic is the mean over months of the
// Spearman rank correlation of signal and outcome across that month's groups; its one-sided lower bound is the
// alpha-quantile of the stationary block-bootstrap replicate means over the months (expected block in months).
//
// Order of work (D-1605): months are counted from member counts alone (a month counts when at least `minGroupsPerMonth`
// groups have at least `minMembers` members). Below `minMonths` the function returns `below_sample` before `read` is
// called once. Only then are signals and outcomes read. Months whose correlation is undefined (constant signal or
// outcome) are left out and counted; too few left is an INCONCLUSIVE verdict (D-1656).
import { spearman } from "@/lib/stats/rankIc";
import { blockLowerBound, type EngineVerdict } from "./eventStudy";

export type MonthEntry = {
  /** Month index in the panel (0-based, in time order). */
  readonly month: number;
  readonly groups: readonly { readonly group: string; readonly members: number }[];
};

/** The signal and the outcome of one group in one month; called only after the floor is met. */
export type ReadGroup = (month: number, group: string) => { signal: number; outcome: number };

export type SectorIcParams = {
  readonly lineage: string;
  /** Groups with fewer members are left out of a month (D-1634: 3). */
  readonly minMembers: number;
  /** A month needs at least this many qualifying groups to carry a correlation. */
  readonly minGroupsPerMonth: number;
  /** Months (blocks) needed before the outcomes are read (D-1634: 95). */
  readonly minMonths: number;
  /** Expected bootstrap block in months (D-1634: 3). */
  readonly expectedBlockMonths: number;
  readonly alpha?: number;
  readonly replicates?: number;
  readonly masterSeed?: bigint;
  /** Months from this index on form the holdout figure (reported, never the gate). */
  readonly holdoutFromMonth?: number;
};

export type SectorIcResult =
  | {
      readonly status: "below_sample";
      readonly months: number;
      readonly floor: number;
      readonly reason: string;
    }
  | {
      readonly status: "looked";
      readonly verdict: EngineVerdict;
      readonly reason: string;
      /** Months that qualified from the member counts (counted before any outcome). */
      readonly months: number;
      /** Months with a defined correlation (the statistic's n). */
      readonly usedMonths: number;
      readonly degenerateMonths: number;
      readonly meanIc: number | null;
      readonly lowerIc: number | null;
      readonly alpha: number;
      readonly holdoutMeanIc: number | null;
      readonly holdoutMonths: number;
      readonly meanGroupsPerMonth: number;
    };

/** Qualifying groups of each month, from member counts alone. */
export function qualifyingMonths(
  entries: readonly MonthEntry[],
  minMembers: number,
  minGroupsPerMonth: number,
): { month: number; groups: string[] }[] {
  const out: { month: number; groups: string[] }[] = [];
  for (const e of entries.slice().sort((a, b) => a.month - b.month)) {
    const groups = e.groups.filter((g) => g.members >= minMembers).map((g) => g.group);
    if (groups.length >= minGroupsPerMonth) out.push({ month: e.month, groups });
  }
  return out;
}

export function sectorIcLook(
  entries: readonly MonthEntry[],
  read: ReadGroup,
  p: SectorIcParams,
): SectorIcResult {
  const qualified = qualifyingMonths(entries, p.minMembers, p.minGroupsPerMonth);
  if (qualified.length < p.minMonths) {
    return {
      status: "below_sample",
      months: qualified.length,
      floor: p.minMonths,
      reason: `${qualified.length} monthly blocks, the floor is ${p.minMonths}`,
    };
  }
  const alpha = p.alpha ?? 0.1; // threshold-ok: D-1634 one-sided 90 % lower bound
  const ics: number[] = [];
  const monthIndex: number[] = [];
  let degenerate = 0;
  let groupSum = 0;
  for (const q of qualified) {
    const signals: number[] = [];
    const outcomes: number[] = [];
    for (const g of q.groups) {
      const r = read(q.month, g);
      signals.push(r.signal);
      outcomes.push(r.outcome);
    }
    const ic = spearman(signals, outcomes);
    if (ic === null) {
      degenerate += 1;
      continue;
    }
    ics.push(ic);
    monthIndex.push(q.month);
    groupSum += q.groups.length;
  }
  const used = ics.length;
  const mean = used === 0 ? null : ics.reduce((a, b) => a + b, 0) / used;
  let holdoutSum = 0;
  let holdoutN = 0;
  if (p.holdoutFromMonth !== undefined) {
    ics.forEach((v, i) => {
      if (monthIndex[i]! >= p.holdoutFromMonth!) {
        holdoutSum += v;
        holdoutN += 1;
      }
    });
  }
  const holdoutMeanIc = holdoutN === 0 ? null : holdoutSum / holdoutN;
  const base = {
    months: qualified.length,
    usedMonths: used,
    degenerateMonths: degenerate,
    alpha,
    holdoutMeanIc,
    holdoutMonths: holdoutN,
    meanGroupsPerMonth: used === 0 ? 0 : groupSum / used,
  };
  if (used < p.minMonths) {
    return {
      status: "looked",
      verdict: "INCONCLUSIVE",
      reason: `only ${used} months had a defined correlation, the floor is ${p.minMonths}`,
      meanIc: mean,
      lowerIc: null,
      ...base,
    };
  }
  const first = monthIndex[0]!;
  const lower = blockLowerBound({
    sessions: monthIndex.map((m) => m - first),
    sessionCount: monthIndex[monthIndex.length - 1]! - first + 1,
    values: ics,
    block: p.expectedBlockMonths,
    alpha,
    scope: `research:${p.lineage}:boot`,
    replicates: p.replicates,
    masterSeed: p.masterSeed,
  });
  const verdict: EngineVerdict = lower === null ? "INCONCLUSIVE" : lower > 0 ? "PASS" : "NULL";
  return {
    status: "looked",
    verdict,
    reason:
      lower === null
        ? "the lower bound could not be computed"
        : lower > 0
          ? "the lower bound of the mean monthly rank correlation is above zero"
          : "the lower bound of the mean monthly rank correlation is not above zero",
    meanIc: mean,
    lowerIc: lower,
    ...base,
  };
}
