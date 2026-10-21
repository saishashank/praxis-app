// Labels per (execution, rule version, variant) (M4 design 4.8 item 8; ARN-086, ARN-082, DAT-127,
// ARN-094; decision 29). A pure function of the evidence: UNVALIDATED -> PASSED-BACKTEST (VAL-110 on
// validation + one holdout confirmation) -> CONSISTENT-FORWARD (forward looks); negative outcomes
// FAILED / NOT-DEMONSTRATED; UNVALIDATABLE (event coverage); "insufficient evidence"; "possible luck".
// `cost_infeasible` is a flag beside the label, not a label (decision 29). Output matches `label`.
import type { StatsParams } from "../agents/params";
import type { Rational } from "../money/rational";
import { forwardLookLevel } from "./gates";
import { ratToNumber, type SingleTestResult, type Val110Result } from "./val110";

export type LabelName =
  | "UNVALIDATED"
  | "PASSED-BACKTEST"
  | "CONSISTENT-FORWARD"
  | "FAILED"
  | "NOT-DEMONSTRATED"
  | "UNVALIDATABLE"
  | "insufficient evidence"
  | "possible luck";

export type LabelRecord = {
  readonly id: string;
  readonly execution_id: string;
  readonly rule_version: string;
  readonly variant: string;
  readonly label: LabelName;
  readonly qualifiers_json: string;
  readonly cost_infeasible: 0 | 1;
  readonly n: number;
  readonly mde: number | null;
  readonly d: string;
  readonly result_ids: string;
};

export type ForwardEvidence = {
  /** Forward signal-ledger trades at fixed notional and months since the first forward entry. */
  readonly trades: number;
  readonly months: number;
  /** One-sided p of "forward mean net > 0" at the latest look, and that mean. */
  readonly p: number;
  readonly mean: number;
  /** Forward CIF inside the backtest 90 % prediction interval; null while not estimable. */
  readonly cifInside: boolean | null;
};

export type LabelInput = {
  readonly executionId: string;
  readonly ruleVersion: string;
  readonly variant: string;
  readonly d: string;
  readonly params: StatsParams;
  readonly activeLineages: number;
  /** Event-driven families (F2, F3, F5, F6) need event-history coverage. */
  readonly eventFamily: boolean;
  /** Covered / total tested dates with event history; null when unknown. */
  readonly coverage: { readonly covered: number; readonly total: number } | null;
  readonly f5DescriptiveOnly: boolean;
  readonly validation: Val110Result | null;
  readonly holdout: SingleTestResult | null;
  readonly forward: ForwardEvidence | null;
  readonly doubledWithoutPass: boolean;
  readonly costInfeasible: boolean;
  /** Share of tested rows in survivorship-exposed years (exact), null when none. */
  readonly survivorshipExposedShare: Rational | null;
  readonly liveRuleDiffersFromVariant: boolean;
};

export const NOTE_V1_KNOWLEDGE =
  "v1 rules were written with knowledge of recent market history; only forward evidence is fully out-of-sample.";
export const NOTE_EDGE =
  "edge vs random entries; positive after costs (lower bound > 0 under P5; point estimate > 0 under stress)";
export const NOTE_C2_BIAS = "C2 exit-mapping bias (ARN-004)";
export const NOTE_LIVE_DIFFERS = "live rule ≠ validated variant";
export const NOTE_F5 = "F5 descriptive-only";

/** Event coverage below the minimum (DAT-127): covered / total < min, exact. */
export function coverageShortfall(
  coverage: { covered: number; total: number } | null,
  min: Rational,
): boolean {
  if (coverage === null || coverage.total <= 0) return true;
  return BigInt(coverage.covered) * min.den < BigInt(coverage.total) * min.num;
}

function pct1(r: Rational): string {
  return (Math.round(ratToNumber(r) * 1000) / 10).toFixed(1);
}

/** The label and its qualifiers from the available evidence. */
export function assignLabel(input: LabelInput): LabelRecord {
  const { params } = input;
  const L = Math.max(params.activeLineagesFloor, input.activeLineages);
  const v = input.validation;
  const qualifiers: string[] = [];
  let label: LabelName;

  const negative = (r: Val110Result | null): LabelName => {
    const upper = r?.excessInterval?.upper;
    return upper !== undefined && upper < ratToNumber(params.usefulEdgeMin)
      ? "FAILED"
      : "NOT-DEMONSTRATED";
  };

  if (input.eventFamily && coverageShortfall(input.coverage, params.eventCoverageMin)) {
    label = "UNVALIDATABLE";
    qualifiers.push(
      input.coverage === null
        ? "event coverage unknown"
        : `event coverage ${input.coverage.covered}/${input.coverage.total} dates below minimum`,
    );
  } else if (input.f5DescriptiveOnly) {
    label = "UNVALIDATED";
    qualifiers.push(NOTE_F5);
  } else if (v === null) {
    label = "UNVALIDATED";
  } else if (v.insufficient) {
    label = "insufficient evidence";
    if (v.reachableD !== null) qualifiers.push(`reachable ${v.reachableD}`);
  } else if (!v.passes) {
    label = negative(v);
  } else if (input.holdout === null) {
    label = "UNVALIDATED";
    qualifiers.push("validation passed; holdout confirmation pending");
  } else if (input.holdout.insufficient) {
    label = "insufficient evidence";
    if (input.holdout.result.reachable_d !== null)
      qualifiers.push(`reachable ${input.holdout.result.reachable_d}`);
  } else if (!input.holdout.pass) {
    label = negative(v);
  } else {
    label = "PASSED-BACKTEST";
    const f = input.forward;
    if (f !== null && f.trades >= params.forwardLookTrades && f.months >= params.forwardMinMonths) {
      const k = Math.floor(f.trades / params.forwardLookTrades);
      const level = forwardLookLevel(k, L, params.forwardAlphaTotal);
      if (f.p <= level && f.mean > 0 && f.cifInside === true) label = "CONSISTENT-FORWARD";
      else if (f.cifInside === null) qualifiers.push("forward CIF not yet estimable");
    }
  }

  if (
    input.doubledWithoutPass &&
    (label === "UNVALIDATED" || label === "insufficient evidence" || label === "NOT-DEMONSTRATED")
  ) {
    label = "possible luck";
  }

  if (label === "PASSED-BACKTEST" || label === "CONSISTENT-FORWARD") {
    qualifiers.push(NOTE_EDGE, NOTE_V1_KNOWLEDGE);
  }
  if (input.eventFamily) qualifiers.push(NOTE_C2_BIAS);
  if (input.survivorshipExposedShare !== null && input.survivorshipExposedShare.num > 0n) {
    qualifiers.push(`survivorship-exposed (${pct1(input.survivorshipExposedShare)}%)`);
  }
  if (input.liveRuleDiffersFromVariant) qualifiers.push(NOTE_LIVE_DIFFERS);

  const resultIds = [
    ...(v?.results.map((r) => r.id) ?? []),
    ...(input.holdout ? [input.holdout.result.id] : []),
  ].sort();
  const first = v?.results[0];
  return {
    id: `label:${input.executionId}:${input.ruleVersion}:${input.variant}:${input.d}`,
    execution_id: input.executionId,
    rule_version: input.ruleVersion,
    variant: input.variant,
    label,
    qualifiers_json: JSON.stringify(qualifiers),
    cost_infeasible: input.costInfeasible ? 1 : 0,
    n: first?.n ?? 0,
    mde: v?.mde ?? null,
    d: input.d,
    result_ids: JSON.stringify(resultIds),
  };
}
