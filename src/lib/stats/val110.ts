// VAL-110 / ARN-087 evaluator (M4 design 4.8 items 2-7; decisions 24, 25, 27). Every criterion (i)-(vi)
// is a separate check over signal-ledger rows plus their matched controls, and every check becomes one
// `validation_result` row (migration 0008). Pure and deterministic: bootstraps are seeded from
// `boot:<test id>` scopes, there is no clock and no Math.random.
//
// A validation/holdout access row must already be in the trial ledger when the evaluator is called
// (design 4.8 item 5: "each access writes a trial_ledger row BEFORE the test reads the rows"); the
// evaluator refuses to run without it.
import type { StatsParams } from "../agents/params";
import type { LedgerEntry } from "../replay/ledger";
import type { Rational } from "../money/rational";
import {
  circularBlockBootstrap,
  mean,
  percentile,
  sampleSd,
  studentisedTest,
  type StudentisedTest,
} from "./bootstrap";
import { deflatedSharpeRatio, returnMoments } from "./dsr";
import { validationLevelFor } from "./errorBudget";
import {
  absoluteGatePasses,
  holdoutLevel,
  minimumDetectableEffect,
  stressGatePasses,
  validationLevel,
} from "./gates";
import { probabilityOfBacktestOverfitting } from "./pbo";
import { scopedPrng, STATS_MASTER_SEED } from "./rng";
import {
  addWeekdays,
  type LineageSplitRecord,
  type TrialKind,
  type TrialLedgerRow,
} from "./splits";

// ---- rows ----

/** One closed signal-ledger row, reduced to floats (display/test domain; money stays exact upstream). */
export type SignalRow = {
  readonly id: string;
  /** Entry-session index 0..S-1 within the tested window. */
  readonly entrySession: number;
  /** Net return under P5 (the absolute-gate profile). */
  readonly net: number;
  /** Net return under P3 + 50 % slippage (VAL-110 iv). */
  readonly stress: number;
  /** Paired excess over the mean of the row's matched controls (decision 25); null without controls. */
  readonly excess: number | null;
};

export function ratToNumber(r: Rational): number {
  return Number(r.num) / Number(r.den);
}

/** A closed replay LedgerEntry as a SignalRow; null while open. */
export function signalRowFromEntry(entry: LedgerEntry, entrySession: number): SignalRow | null {
  if (entry.net === null || entry.stress === null) return null;
  return {
    id: entry.row.id,
    entrySession,
    net: Number(entry.net.num) / Number(entry.net.den),
    stress: Number(entry.stress.num) / Number(entry.stress.den),
    excess: entry.excess === null ? null : ratToNumber(entry.excess),
  };
}

// ---- records ----

export type ValidationTest =
  "i" | "ii" | "iii" | "iv" | "iv-b" | "v" | "vi" | "holdout" | "ks" | "size" | "leverage";

export type ValidationResultRecord = {
  readonly id: string;
  readonly run_id: string;
  readonly lineage_id: string;
  readonly rule_version: string;
  readonly variant: string;
  readonly split_version: number;
  readonly test: ValidationTest;
  readonly level: number;
  readonly B: number;
  readonly n: number;
  readonly blocks: number;
  readonly stat: number | null;
  readonly p: number | null;
  readonly mde: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly L_used: number;
  readonly m_used: number;
  readonly outcome: string;
  readonly reachable_d: string | null;
};

export type CheckState = "pass" | "fail" | "insufficient" | "n/a" | "blocks" | "descriptive";

export type ChallengerRow = {
  readonly key: string;
  readonly entrySession: number;
  readonly excess: number;
};

export type SafetyInput = {
  /** Effective N of the non-overlapping development + validation cohorts (ARN-053). */
  readonly effectiveN: number;
  /** Delta (bust + stalled) CIF(252) versus C2, as a fraction; null when not estimable. */
  readonly delta: number | null;
  /** First date the check can block, for the descriptive case. */
  readonly firstBlockD: string | null;
};

export type Val110Input = {
  readonly runId: string;
  readonly lineageId: string;
  readonly ruleVersion: string;
  readonly variant: string;
  readonly split: LineageSplitRecord;
  /** The trial-ledger row recorded before this call. */
  readonly access: TrialLedgerRow;
  readonly params: StatsParams;
  /** Active lineages in the market; L = max(floor, this). */
  readonly activeLineages: number;
  readonly rows: readonly SignalRow[];
  /** Sessions S in the tested window and the lineage's frozen block length. */
  readonly sessionCount: number;
  readonly block: number;
  /** Last date of the tested window (reachable-date projection). */
  readonly windowEndD: string;
  /** Lineage trials on this split (DSR N). */
  readonly trialsOnSplit: number;
  /**
   * VAL-112 (D-226): validation_access + pattern_test rows already spent on this lineage's split
   * version, not counting this access (k). Absent = the v1 fixed level alpha / (m L), so a caller that
   * has not been moved to the error budget keeps v1 behaviour.
   */
  readonly priorTests?: number;
  readonly challenger?: {
    readonly challengerRows: readonly ChallengerRow[];
    readonly incumbentRows: readonly ChallengerRow[];
  } | null;
  readonly safety?: SafetyInput | null;
  /** From feasibility.ts (ARN-094). */
  readonly costInfeasible: boolean;
  /** Weekly returns, T weeks x N tested variants of the lineage (VAL-110 v). */
  readonly pboWeekly?: readonly (readonly number[])[] | null;
  readonly dsr?: {
    /** Daily returns of the selected variant. */
    readonly daily: readonly number[];
    /** Daily Sharpe of each tested variant (for V). */
    readonly variantDailySr: readonly number[];
    /** Frozen default variance of the families' daily development SR. */
    readonly defaultSrVariance: number;
  } | null;
  readonly masterSeed?: bigint;
};

export type Val110Result = {
  readonly results: readonly ValidationResultRecord[];
  readonly checks: {
    readonly i: CheckState;
    readonly ii: CheckState;
    readonly iii: CheckState;
    readonly iv: CheckState;
    readonly ivb: CheckState;
    readonly v: CheckState;
    readonly vi: CheckState;
  };
  /** Absolute gate (one-sided 90 % lower bound of mean net under P5 > 0). */
  readonly absoluteGate: boolean | null;
  readonly insufficient: boolean;
  readonly passes: boolean;
  readonly level: number;
  readonly B: number;
  readonly L: number;
  readonly m: number;
  readonly mde: number | null;
  /** Two-sided 90 % interval of the mean excess (FAILED / NOT-DEMONSTRATED, ARN-086). */
  readonly excessInterval: { readonly lower: number; readonly upper: number } | null;
  readonly reachableD: string | null;
};

// ---- shared pieces ----

function requireAccess(
  access: TrialLedgerRow,
  input: { lineageId: string; split: LineageSplitRecord },
  kind: TrialKind,
): void {
  if (
    access.kind !== kind ||
    access.lineage_id !== input.lineageId ||
    access.split_version !== input.split.version
  ) {
    throw new Error(`a ${kind} trial_ledger row must be recorded before the test reads the rows`);
  }
}

/** B = max(floor, ceil(factor / level)) with a relative guard against 20/level = 48,000.0000000001. */
export function replicationsFor(level: number, params: StatsParams): number {
  return Math.max(
    params.bootstrapReplicationsMin,
    Math.ceil(params.bootstrapReplicationsFactor / level - 1e-9),
  );
}

const Q_LOW_90 = 0.1; // one-sided 90 % lower bound (statistical definition, ARN-081)
const Q_LOW_2S = 0.05; // two-sided 90 % interval
const Q_HIGH_2S = 0.95;

type MeanTest = {
  readonly n: number;
  readonly blocks: number;
  readonly mean: number;
  readonly test: StudentisedTest;
  readonly p: number;
  readonly interval: { readonly lower: number; readonly upper: number };
  readonly companionLower90: number;
  readonly companionMean: number;
  readonly redraws: number;
};

/** Studentised one-sided circular-block-bootstrap test of mean(values) > 0, resampling `companion` jointly. */
function meanTest(
  sessions: readonly number[],
  values: readonly number[],
  companion: readonly number[],
  sessionCount: number,
  block: number,
  B: number,
  seedScope: string,
  masterSeed: bigint,
): MeanTest {
  const r = circularBlockBootstrap(
    { sessions, sessionCount, block, replicates: B, series: [values, companion] },
    scopedPrng(seedScope, masterSeed),
  );
  const m0 = r.replicateMeans[0]!;
  const m1 = r.replicateMeans[1]!;
  const observed = mean(values);
  const test = studentisedTest(observed, m0);
  // Degenerate resampling distribution (se = 0): the studentised ratio is undefined.
  const p = test.se > 0 ? test.p : observed > 0 ? 1 / (B + 1) : 1;
  return {
    n: values.length,
    blocks: r.blocks,
    mean: observed,
    test,
    p,
    interval: { lower: percentile(m0, Q_LOW_2S), upper: percentile(m0, Q_HIGH_2S) },
    companionLower90: percentile(m1, Q_LOW_90),
    companionMean: mean(companion),
    redraws: r.redraws,
  };
}

/** Date at which the window could hold enough rows and blocks at its measured signal rate. */
function reachableDate(
  n: number,
  sessionCount: number,
  block: number,
  windowEndD: string,
  params: StatsParams,
): string | null {
  if (n === 0) return null;
  const rate = n / sessionCount;
  const need = Math.max(params.minBlocks * block, Math.ceil(params.minTrades / rate));
  return addWeekdays(windowEndD, Math.max(0, need - sessionCount));
}

function resultId(input: Val110Input, test: string): string {
  return `vr:${input.lineageId}:${input.ruleVersion}:${input.variant}:${input.split.version}:${input.runId}:${test}`;
}

type RecordFields = Pick<
  ValidationResultRecord,
  "stat" | "p" | "mde" | "lower" | "upper" | "reachable_d"
>;

const NO_FIELDS: RecordFields = {
  stat: null,
  p: null,
  mde: null,
  lower: null,
  upper: null,
  reachable_d: null,
};

function record(
  input: Val110Input,
  test: ValidationTest,
  idSuffix: string,
  base: {
    level: number;
    B: number;
    n: number;
    blocks: number;
    L: number;
    m: number;
    outcome: string;
  },
  fields: Partial<RecordFields>,
): ValidationResultRecord {
  return {
    id: resultId(input, idSuffix),
    run_id: input.runId,
    lineage_id: input.lineageId,
    rule_version: input.ruleVersion,
    variant: input.variant,
    split_version: input.split.version,
    test,
    level: base.level,
    B: base.B,
    n: base.n,
    blocks: Math.floor(base.blocks),
    L_used: base.L,
    m_used: base.m,
    outcome: base.outcome,
    ...NO_FIELDS,
    ...fields,
  };
}

// ---- VAL-110 ----

export function evaluateVal110(input: Val110Input): Val110Result {
  requireAccess(input.access, input, "validation_access");
  const { params } = input;
  const master = input.masterSeed ?? STATS_MASTER_SEED;
  const L = Math.max(params.activeLineagesFloor, input.activeLineages);
  const m = params.trialBudgetPerLineage;
  const level =
    input.priorTests === undefined
      ? validationLevel(params.alpha, m, L)
      : validationLevelFor({
          mode: params.valErrorBudgetMode,
          w0: params.valFwerPerLineage,
          priorTests: input.priorTests,
          legacy: { alpha: params.alpha, m, lineages: L },
        });
  const B = replicationsFor(level, params);
  const results: ValidationResultRecord[] = [];
  const base = (extra: {
    n: number;
    blocks: number;
    outcome: string;
    level?: number;
    B?: number;
  }) => ({
    level: extra.level ?? level,
    B: extra.B ?? B,
    n: extra.n,
    blocks: extra.blocks,
    L,
    m,
    outcome: extra.outcome,
  });

  // (i) excess over matched controls + absolute gate
  const withControls = input.rows.filter((r) => r.excess !== null);
  const sessions = withControls.map((r) => r.entrySession);
  const excess = withControls.map((r) => r.excess as number);
  const net = withControls.map((r) => r.net);
  const blocks = input.sessionCount / input.block;
  const insufficient = withControls.length < params.minTrades || blocks < params.minBlocks;
  let checkI: CheckState;
  let absoluteGate: boolean | null = null;
  let mde: number | null = null;
  let excessInterval: { lower: number; upper: number } | null = null;
  let reachable: string | null = null;

  if (insufficient) {
    checkI = "insufficient";
    reachable = reachableDate(
      withControls.length,
      input.sessionCount,
      input.block,
      input.windowEndD,
      params,
    );
    const why =
      blocks < params.minBlocks ? "insufficient independent blocks" : "insufficient evidence";
    results.push(
      record(input, "i", "i", base({ n: withControls.length, blocks, outcome: why, B: 0 }), {
        reachable_d: reachable,
      }),
    );
  } else {
    const t = meanTest(
      sessions,
      excess,
      net,
      input.sessionCount,
      input.block,
      B,
      `boot:${resultId(input, "i")}`,
      master,
    );
    absoluteGate = absoluteGatePasses(t.companionLower90);
    mde = minimumDetectableEffect(level, t.test.se);
    excessInterval = t.interval;
    const pPass = t.p <= level;
    checkI = pPass && absoluteGate ? "pass" : "fail";
    results.push(
      record(
        input,
        "i",
        "i:excess",
        base({
          n: t.n,
          blocks: t.blocks,
          outcome: pPass
            ? "excess over matched controls: p <= level"
            : "excess over matched controls: p > level",
        }),
        {
          stat: t.test.t,
          p: t.p,
          mde,
          lower: t.interval.lower,
          upper: t.interval.upper,
        },
      ),
      record(
        input,
        "i",
        "i:absolute",
        base({
          n: t.n,
          blocks: t.blocks,
          outcome: absoluteGate
            ? "absolute gate: 90% lower bound of mean net > 0 (P5)"
            : "absolute gate: 90% lower bound of mean net <= 0 (P5)",
        }),
        { stat: t.companionMean, lower: t.companionLower90 },
      ),
    );
  }

  // (ii) challengers only
  let checkII: CheckState = "n/a";
  if (input.challenger !== undefined && input.challenger !== null) {
    const c = new Map<string, ChallengerRow>();
    const inc = new Map<string, ChallengerRow>();
    for (const r of input.challenger.challengerRows) c.set(r.key, r);
    for (const r of input.challenger.incumbentRows) inc.set(r.key, r);
    const keys = [...new Set([...c.keys(), ...inc.keys()])].sort();
    // Rows present in only one version count against 0 excess on the other side (no trade, no excess).
    const sess = keys.map((k) => (c.get(k) ?? inc.get(k))!.entrySession);
    const diff = keys.map((k) => (c.get(k)?.excess ?? 0) - (inc.get(k)?.excess ?? 0));
    const blocksII = input.sessionCount / input.block;
    if (keys.length < params.minTrades || blocksII < params.minBlocks) {
      checkII = "insufficient";
      results.push(
        record(
          input,
          "ii",
          "ii",
          base({ n: keys.length, blocks: blocksII, outcome: "insufficient evidence", B: 0 }),
          {},
        ),
      );
    } else {
      const t = meanTest(
        sess,
        diff,
        diff,
        input.sessionCount,
        input.block,
        B,
        `boot:${resultId(input, "ii")}`,
        master,
      );
      const ok = t.p <= level && t.mean > 0;
      checkII = ok ? "pass" : "fail";
      results.push(
        record(
          input,
          "ii",
          "ii",
          base({
            n: t.n,
            blocks: t.blocks,
            outcome: ok ? "challenger beats incumbent" : "challenger does not beat incumbent",
          }),
          {
            stat: t.test.t,
            p: t.p,
            mde: minimumDetectableEffect(level, t.test.se),
            lower: t.interval.lower,
            upper: t.interval.upper,
          },
        ),
      );
    }
  }

  // (iii) safety check
  let checkIII: CheckState = "descriptive";
  {
    const s = input.safety ?? null;
    const tolerance = ratToNumber(params.deltaBustTolerance);
    if (
      s !== null &&
      s.delta !== null &&
      s.effectiveN >= params.safetyCheckMinNeff &&
      s.delta > tolerance
    ) {
      checkIII = "blocks";
    } else if (s !== null && s.delta !== null && s.effectiveN >= params.safetyCheckMinNeff) {
      checkIII = "pass";
    }
    const outcome =
      checkIII === "blocks"
        ? "blocks promotion: delta (bust + stalled) above tolerance"
        : checkIII === "pass"
          ? "within tolerance"
          : s === null || s.delta === null
            ? "descriptive: not estimable"
            : `descriptive: effective N ${s.effectiveN} below ${params.safetyCheckMinNeff}`;
    results.push(
      record(
        input,
        "iii",
        "iii",
        base({ n: s?.effectiveN ?? 0, blocks: 0, outcome, level: params.alpha, B: 0 }),
        {
          stat: s?.delta ?? null,
          reachable_d: checkIII === "descriptive" ? (s?.firstBlockD ?? null) : null,
        },
      ),
    );
  }

  // (iv) stress point estimate
  const stressMean = input.rows.length === 0 ? Number.NaN : mean(input.rows.map((r) => r.stress));
  const checkIV: CheckState =
    input.rows.length > 0 && stressGatePasses(stressMean) ? "pass" : "fail";
  results.push(
    record(
      input,
      "iv",
      "iv",
      base({
        n: input.rows.length,
        blocks,
        outcome: checkIV === "pass" ? "stress mean net > 0" : "stress mean net <= 0",
        level: params.alpha,
        B: 0,
      }),
      { stat: Number.isNaN(stressMean) ? null : stressMean },
    ),
  );

  // (iv-b) not cost-infeasible
  const checkIVB: CheckState = input.costInfeasible ? "fail" : "pass";
  results.push(
    record(
      input,
      "iv-b",
      "iv-b",
      base({
        n: input.rows.length,
        blocks: 0,
        outcome: input.costInfeasible ? "cost-infeasible" : "not cost-infeasible",
        level: params.alpha,
        B: 0,
      }),
      {},
    ),
  );

  // (v) PBO
  let checkV: CheckState = "n/a";
  {
    const weekly = input.pboWeekly ?? null;
    const pbo =
      weekly === null
        ? ({ status: "n/a", reason: "no weekly returns" } as const)
        : probabilityOfBacktestOverfitting(weekly, {
            blocks: params.pboBlocks,
            minVariants: params.pboMinVariants,
          });
    if (pbo.status === "ok") {
      checkV = pbo.pbo <= params.pboMax ? "pass" : "fail";
      results.push(
        record(
          input,
          "v",
          "v",
          base({
            n: weekly!.length,
            blocks: 0,
            outcome: checkV === "pass" ? "PBO within limit" : "PBO above limit",
            level: params.alpha,
            B: 0,
          }),
          { stat: pbo.pbo },
        ),
      );
    } else {
      results.push(
        record(
          input,
          "v",
          "v",
          base({
            n: weekly?.length ?? 0,
            blocks: 0,
            outcome: `n/a: ${pbo.reason}`,
            level: params.alpha,
            B: 0,
          }),
          {},
        ),
      );
    }
  }

  // (vi) DSR
  let checkVI: CheckState = "insufficient";
  {
    const d = input.dsr ?? null;
    if (d === null || d.daily.length < 3) {
      results.push(
        record(
          input,
          "vi",
          "vi",
          base({
            n: d?.daily.length ?? 0,
            blocks: 0,
            outcome: "insufficient daily returns",
            level: params.alpha,
            B: 0,
          }),
          {},
        ),
      );
    } else {
      const mo = returnMoments(d.daily);
      const v =
        d.variantDailySr.length >= params.pboMinVariants
          ? sampleSd(d.variantDailySr) ** 2
          : d.defaultSrVariance;
      const r = deflatedSharpeRatio({
        sharpe: mo.sharpe,
        skew: mo.skew,
        kurtosis: mo.kurtosis,
        observations: mo.n,
        trials: Math.max(1, input.trialsOnSplit),
        srVariance: v,
      });
      checkVI = r.dsr !== null && r.dsr >= params.dsrMin ? "pass" : "fail";
      results.push(
        record(
          input,
          "vi",
          "vi",
          base({
            n: mo.n,
            blocks: 0,
            outcome: checkVI === "pass" ? "DSR at or above minimum" : "DSR below minimum",
            level: params.alpha,
            B: 0,
          }),
          { stat: r.dsr, lower: r.sr0 },
        ),
      );
    }
  }

  const passes =
    checkI === "pass" &&
    (checkII === "pass" || checkII === "n/a") &&
    checkIII !== "blocks" &&
    checkIV === "pass" &&
    checkIVB === "pass" &&
    (checkV === "pass" || checkV === "n/a") &&
    checkVI === "pass";

  return {
    results,
    checks: {
      i: checkI,
      ii: checkII,
      iii: checkIII,
      iv: checkIV,
      ivb: checkIVB,
      v: checkV,
      vi: checkVI,
    },
    absoluteGate,
    insufficient,
    passes,
    level,
    B,
    L,
    m,
    mde,
    excessInterval,
    reachableD: reachable,
  };
}

// ---- holdout confirmation (ARN-086) and leverage (ARN-084) ----

export type SingleTestInput = Omit<
  Val110Input,
  | "access"
  | "challenger"
  | "safety"
  | "costInfeasible"
  | "pboWeekly"
  | "dsr"
  | "trialsOnSplit"
  | "priorTests"
  | "windowEndD"
> & { readonly windowEndD: string };

export type SingleTestResult = {
  readonly result: ValidationResultRecord;
  readonly pass: boolean;
  readonly insufficient: boolean;
  readonly level: number;
  readonly B: number;
  readonly mde: number | null;
};

function singleTest(
  input: SingleTestInput,
  test: "holdout" | "leverage",
  level: number,
  L: number,
  withAbsoluteGate: boolean,
): SingleTestResult {
  const { params } = input;
  const B = replicationsFor(level, params);
  const m = params.trialBudgetPerLineage;
  const asVal = input as unknown as Val110Input;
  const usable = input.rows.filter((r) => r.excess !== null || test === "leverage");
  // Leverage tests the sleeve's own per-trade net expectancy (ARN-084), not the excess.
  const values = usable.map((r) => (test === "leverage" ? r.net : (r.excess as number)));
  const net = usable.map((r) => r.net);
  const sessions = usable.map((r) => r.entrySession);
  const blocks = input.sessionCount / input.block;
  const insufficient = usable.length < params.minTrades || blocks < params.minBlocks;
  const common = { level, L, m };
  if (insufficient) {
    return {
      result: record(
        asVal,
        test,
        test,
        { ...common, B: 0, n: usable.length, blocks, outcome: "insufficient evidence" },
        {
          reachable_d: reachableDate(
            usable.length,
            input.sessionCount,
            input.block,
            input.windowEndD,
            params,
          ),
        },
      ),
      pass: false,
      insufficient: true,
      level,
      B,
      mde: null,
    };
  }
  const t = meanTest(
    sessions,
    values,
    net,
    input.sessionCount,
    input.block,
    B,
    `boot:${resultId(asVal, test)}`,
    input.masterSeed ?? STATS_MASTER_SEED,
  );
  const mde = minimumDetectableEffect(level, t.test.se);
  const pass = t.p <= level && (!withAbsoluteGate || absoluteGatePasses(t.companionLower90));
  return {
    result: record(
      asVal,
      test,
      test,
      { ...common, B, n: t.n, blocks: t.blocks, outcome: pass ? "confirmed" : "not confirmed" },
      {
        stat: t.test.t,
        p: t.p,
        mde,
        lower: withAbsoluteGate ? t.companionLower90 : t.interval.lower,
        upper: t.interval.upper,
      },
    ),
    pass,
    insufficient: false,
    level,
    B,
    mde,
  };
}

/** One holdout confirmation of (i): one-sided alpha / L with the same bootstrap, plus the absolute gate. */
export function evaluateHoldout(
  input: SingleTestInput & { readonly access: TrialLedgerRow },
): SingleTestResult {
  requireAccess(input.access, input, "holdout_access");
  const L = Math.max(input.params.activeLineagesFloor, input.activeLineages);
  return singleTest(input, "holdout", holdoutLevel(input.params.alpha, L), L, true);
}

/**
 * ARN-084 sleeve per-trade net expectancy at alpha / (m L). Descriptive since O-45 (D-228): it is not
 * charged to the trial ledger, so it needs no access row (an `access` passed in is ignored).
 */
export function evaluateLeverage(
  input: SingleTestInput & { readonly access?: TrialLedgerRow },
): SingleTestResult {
  const L = Math.max(input.params.activeLineagesFloor, input.activeLineages);
  return singleTest(
    input,
    "leverage",
    validationLevel(input.params.alpha, input.params.trialBudgetPerLineage, L),
    L,
    false,
  );
}
