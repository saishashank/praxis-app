// M14 entry gates shared by the live night (batch 2b) and the cohort replay (AGT-003, D-214...D-221;
// docs/M14_design.md 2.1). Pure: no clock, no I/O, no random source. `selectEntries` takes the
// candidates of one E execution in rank order (after the held / re-entry filters) and returns the
// ones that may go on to the quality gate and `planLegs`, plus a reason per skipped candidate.
// Order per candidate: FAM-005 cost gate -> FAM-006 second position -> FAM-009 SHOCK abstain.
// The gates apply to E executions only; the signal ledger and the C2/C3 controls never call this.
// Rank order matters: a candidate that fails a gate is skipped and the next-ranked one is tried, so
// the first leg of the night is the first candidate that passed.
import { MIN_MARKETABLE_PARCEL_MICRO } from "@/lib/arena/sizing";
import type { CostProfile } from "@/lib/arena/costs";
import { divFloor } from "@/lib/money/rational";
import { costGateVerdict, roundTripCost, type CostGateTable } from "./costGate";
import type { EntryParams } from "./params";
import type { Candidate, CodeFacts } from "./families/types";

export const COST_GATE_REASON = "skipped_cost_gate";
export const SECOND_POSITION_REASON = "second_position";
export const ABSTAIN_SHOCK_REASON = "abstain_shock";

/** Industry values that mean "not known" (D-218). */
const UNKNOWN_INDUSTRY = new Set(["", "class pend", "not applic"]);

export type EntryGateContext = {
  /** `params.entry` (cost_gate_k, second_position_*). */
  readonly entry: EntryParams;
  /** `params.windows.adv`: the ADV window of the cost-gate slippage bucket (same as sizing). */
  readonly advWindow: number;
  /** The execution's cost profile (FAM-005 brokerage). */
  readonly costProfile: CostProfile;
  /** Development-split medians; absent = every signal unmeasured. */
  readonly costTable?: CostGateTable;
  /** Facts of the night, by code (missing = unknown). */
  readonly factsOf: (code: string) => CodeFacts | undefined;
  /** Codes the execution holds now. */
  readonly heldCodes: readonly string[];
  /** Settled cash available for the entries (FAM-009). */
  readonly cashMicro: bigint;
  /**
   * Codes that cannot open a position tonight (a blocked code at the quality gate, a disposal across
   * the next session). They stay eligible, so the later gate gives their own reason, but they do not
   * become the first leg that FAM-006 measures the next candidate against.
   */
  readonly noPosition?: ReadonlySet<string>;
};

export type EntrySelection = {
  /** Candidates that passed, in rank order. */
  readonly eligible: Candidate[];
  /** Skipped candidates with their `not_taken_reason` word. */
  readonly skipped: Map<Candidate, string>;
  /** Card flags (`cost_gate_unmeasured`, `industry_unknown`, `corr_unknown`) by candidate. */
  readonly flags: Map<Candidate, string[]>;
};

export function industryKnown(industry: string | null | undefined): industry is string {
  return (
    industry !== null &&
    industry !== undefined &&
    !UNKNOWN_INDUSTRY.has(industry.trim().toLowerCase())
  );
}

/** 20-session average traded value in micro, as `sizingEnvFor` computes it (raw bars). */
function advValueOf(facts: CodeFacts, window: number): bigint {
  const bars = facts.rawBars.slice(-window);
  let value = 0n;
  for (const b of bars) value += b.close * b.volume;
  return divFloor(value, BigInt(bars.length === 0 ? 1 : bars.length));
}

/**
 * Pearson correlation of the last `sessions` daily simple returns of the adjusted closes (a
 * statistic, not money: floats are fine and deterministic). null = too little history or no variance.
 */
export function returnCorrelation(
  a: readonly bigint[],
  b: readonly bigint[],
  sessions: number,
): number | null {
  const need = sessions + 1;
  if (a.length < need || b.length < need) return null;
  const ra = dailyReturns(a.slice(-need));
  const rb = dailyReturns(b.slice(-need));
  if (ra === null || rb === null) return null;
  const n = ra.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n; // money-float-ok: correlation statistic
  const mb = rb.reduce((s, x) => s + x, 0) / n; // money-float-ok: correlation statistic
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = ra[i]! - ma;
    const y = rb[i]! - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  if (saa === 0 || sbb === 0) return null;
  return sab / Math.sqrt(saa * sbb);
}

function dailyReturns(closes: readonly bigint[]): number[] | null {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]!;
    if (prev <= 0n) return null;
    out.push(Number(closes[i]!) / Number(prev) - 1); // money-float-ok: return for a correlation
  }
  return out;
}

/**
 * FAM-006: may `facts` be a second position next to `first`? Different industry (when both are
 * known) and return correlation at or below the limit (when there is enough history).
 */
export function secondPositionVerdict(
  facts: CodeFacts | undefined,
  first: CodeFacts | undefined,
  maxCorr: number,
  sessions: number,
): { ok: boolean; flags: string[] } {
  const flags: string[] = [];
  const bothKnown =
    facts !== undefined &&
    first !== undefined &&
    industryKnown(facts.industry) &&
    industryKnown(first.industry);
  if (!bothKnown) flags.push("industry_unknown");
  else if (facts.industry!.trim().toLowerCase() === first.industry!.trim().toLowerCase()) {
    return { ok: false, flags };
  }
  const corr =
    facts === undefined || first === undefined
      ? null
      : returnCorrelation(facts.closesAdj, first.closesAdj, sessions);
  if (corr === null) flags.push("corr_unknown");
  else if (corr > maxCorr) return { ok: false, flags };
  return { ok: true, flags };
}

export function selectEntries(ranked: readonly Candidate[], ctx: EntryGateContext): EntrySelection {
  const eligible: Candidate[] = [];
  const skipped = new Map<Candidate, string>();
  const flags = new Map<Candidate, string[]>();
  const { entry } = ctx;
  const cash = ctx.cashMicro < 0n ? 0n : ctx.cashMicro;
  // the first position(s): everything held plus the first leg taken tonight
  const firsts: string[] = [...ctx.heldCodes];
  for (const c of ranked) {
    const facts = ctx.factsOf(c.code);
    const own: string[] = [];
    // FAM-005 cost gate (D-214, D-215)
    if (facts !== undefined) {
      const cost = roundTripCost(ctx.costProfile, advValueOf(facts, ctx.advWindow));
      const verdict = costGateVerdict(
        ctx.costTable,
        c.family,
        c.ruleVersion,
        c.variant,
        cost,
        entry.costGateK,
      );
      if (verdict === "skip") {
        skipped.set(c, COST_GATE_REASON);
        continue;
      }
      if (verdict === "unmeasured") own.push("cost_gate_unmeasured");
    }
    // FAM-006 second position (D-217); a code that cannot open is neither tested nor a first leg
    const opens = ctx.noPosition?.has(c.code) !== true;
    if (opens && firsts.length > 0) {
      let blockedBy = false;
      const seen = new Set<string>();
      for (const code of firsts) {
        const v = secondPositionVerdict(
          facts,
          ctx.factsOf(code),
          entry.secondPositionMaxCorr,
          entry.secondPositionCorrSessions,
        );
        if (!v.ok) {
          blockedBy = true;
          break;
        }
        for (const f of v.flags) seen.add(f);
      }
      if (blockedBy) {
        skipped.set(c, SECOND_POSITION_REASON);
        continue;
      }
      own.push(...[...seen].sort());
    }
    // FAM-009 (D-220): a half-size candidate that cannot clear two parcels abstains
    if (c.halfSize && cash < 2n * MIN_MARKETABLE_PARCEL_MICRO) {
      skipped.set(c, ABSTAIN_SHOCK_REASON);
      continue;
    }
    if (own.length > 0) flags.set(c, own);
    eligible.push(c);
    if (opens && firsts.length === 0) firsts.push(c.code);
  }
  return { eligible, skipped, flags };
}

/**
 * D-284 (FAM-006): the code of the first leg when sizing rejected it, else null. The caller then runs
 * the entry gates once more with that code removed from the pool (and in `noPosition`), so a
 * same-industry second it had blocked and the next candidate are tried; its rejection stays as it is.
 */
export function firstLegRetryCode(
  results: readonly {
    readonly leg: { readonly key: string };
    readonly sizing: { readonly accepted: boolean };
  }[],
): string | null {
  const first = results[0];
  return first === undefined || first.sizing.accepted ? null : first.leg.key;
}
