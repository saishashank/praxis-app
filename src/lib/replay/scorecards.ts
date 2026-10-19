// Scorecards and replay statistics (M4 T14; design 4.11, 4.7; ARN-049, ARN-053, ARN-070..078, ARN-102;
// decisions 25, 32, D-091 draft). Pure functions from replay results to numbers and to rows in the
// migration 0008 shapes `replay_run` / `replay_stat`; nothing is written here (T16 persists).
//
//   cohortFigure      ARN-071/053: effective N, CIFs (Wilson on resolved non-overlapping cohorts, Aalen-Johansen
//                     with bootstrap intervals for the censored ones), E[NAV at end] - seed
//   headline          the figures minus the matched C2 value (ARN-071)
//   progressTable     P(target | NAV bucket, sessions bucket), "not yet measured" below effective N 3
//   sleeveComparison  ARN-049: the leverage-carrying executions at 10x and at the reality-adjusted 5x
//   rankExecutions    ARN-078: tied groups where 90 % intervals overlap, never an order inside a group
//   tradeScorecard    ARN-070: net win rate (Wilson), average win/loss, payoff, expectancy, profit factor,
//                     holding period, exposure; block-bootstrap intervals; "Not enough history yet (n = x)"
//   barrierScorecard  ARN-072: triple barrier +/-(2, 1.5) x ATR20, 20 sessions, net, lift over the matched controls
//   patternScorecard  ARN-074: candle patterns, lift over same-date controls; every test charged to F4's lineage
//   leaveOneClassOut  ARN-076: F6 re-run with one evidence class disabled
//   zeroEdgeFor       decision 32: the zero-edge benchmark per (family, rule version) and the PRD-020 table
//   buildReplayStats  all of it, as `replay_stat` rows with a determinism digest (ARN-102)
// Everything iterates in sorted order and uses seeded streams (`scopedPrng`), so the same replay gives
// byte-identical rows.
import {
  aalenJohansen,
  cifBootstrap,
  cifProportions,
  type BootstrapCif,
  type Cause,
  type CifEstimate,
  type CifObservation,
  type CifProportion,
} from "./cif";
import type { CohortOutcome, CohortReplayResult } from "./cohortReplay";
import type { LedgerEntry, LedgerResult } from "./ledger";
import { costSetupFrom, type CostSetup, type PathSource } from "./returns";
import { zeroEdge, type ZeroEdgeResult } from "./zeroEdge";
import type { ControlSource } from "./controlLibrary";
import type { AgentParams } from "@/lib/agents/params";
import {
  canonicalJson,
  effectiveN,
  resolveCohortParams,
  sha256Hex,
  type EffectiveNCohort,
} from "@/lib/arena/cohort";
import { fillEntryAtOpen, fillIntradayStop, type FillEnv } from "@/lib/arena/fills";
import { feeFor } from "@/lib/arena/costs";
import { bucketBpsFor, slippageFill, DEFAULT_TICK_CROSS_FACTOR } from "@/lib/arena/slippage";
import { divFloor, makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import {
  belowInt,
  circularBlockBootstrap,
  mean,
  percentile,
  scopedPrng,
  wilsonInterval,
  type Interval,
} from "@/lib/stats";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const frac = (f: { readonly num: bigint; readonly den: bigint }): number =>
  Number(f.num) / Number(f.den);
const ratNum = (r: Rational): number => Number(r.num) / Number(r.den);

/** Candle patterns of ARN-074 (AGT-031 v1 candidates). */
export const PATTERN_NAMES = ["bullishEngulfing", "hammer", "morningStar", "piercingLine"] as const;

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Plain JSON form: bigint as text, rational as "num/den", maps and sets sorted, non-finite as null. */
export function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Map) {
    return Object.fromEntries(
      [...v.entries()]
        .sort((a, b) => cmp(String(a[0]), String(b[0])))
        .map(([k, x]) => [String(k), plain(x)]),
    );
  }
  if (v instanceof Set) return [...v].sort().map(plain);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.num === "bigint" && typeof o.den === "bigint" && Object.keys(o).length === 2) {
      return `${o.num}/${o.den}`;
    }
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, plain(o[k])]),
    );
  }
  return v;
}

export const canonical = (v: unknown): string => canonicalJson(plain(v));

// ---------------------------------------------------------------------------------------------------------
// ARN-071 / ARN-053: cohort figures
// ---------------------------------------------------------------------------------------------------------

const asEffective = (
  c: CohortOutcome,
): EffectiveNCohort & { readonly ttdSessions: number | null } => ({
  id: c.id,
  executionId: c.executionId,
  startD: c.startD,
  terminalD: c.censored ? null : c.endD,
  terminalKind: c.terminalKind,
  ttdSessions: c.censored ? null : c.sessions,
});

/** The scope key of a cohort figure: an E execution, or a control pooled over its slots. */
export function figureScope(c: Pick<CohortOutcome, "executionId" | "group">): string {
  return c.group === "base" ? c.executionId : `${c.executionId}~reality`;
}

export type NavFigure = {
  readonly n: number;
  /** Mean of liquidation NAV at the end minus seed, micro-AUD. */
  readonly meanMicro: number;
  readonly interval: Interval;
  readonly replicates: number;
};

export type CohortFigure = {
  readonly scope: string;
  readonly executionId: string;
  readonly group: "base" | "reality";
  readonly leverage: number | null;
  /** ARN-053: resolved cohorts not overlapping an already counted one (M3 effectiveN, per execution). */
  readonly effectiveN: number;
  readonly cohorts: number;
  readonly resolved: number;
  readonly censored: number;
  /** Wilson 90 % proportions of the effective cohorts (all slots of the counted starts for controls). */
  readonly proportions: readonly CifProportion[];
  /** Aalen-Johansen over every cohort, censored ones included. */
  readonly aalenJohansen: readonly CifEstimate[];
  readonly aalenJohansenBootstrap: readonly BootstrapCif[] | null;
  readonly navMinusSeed: NavFigure | null;
};

export type FigureOptions = {
  readonly params: AgentParams;
  /** Rolling-start step, to size the bootstrap block (sessions of one cohort / step). */
  readonly step: number;
  readonly timeoutSessions: number;
  /** Bootstrap intervals for the AJ CIF (E executions; off for pooled controls). */
  readonly intervals: boolean;
};

/** Cohorts of the counted starts: M3 effectiveN picks the starts, every slot of a counted start joins. */
export function countedCohorts(outcomes: readonly CohortOutcome[]): CohortOutcome[] {
  const counted = new Set(effectiveN(outcomes.map(asEffective)).counted);
  const starts = new Set(outcomes.filter((o) => counted.has(o.id)).map((o) => o.startD));
  return outcomes.filter((o) => starts.has(o.startD));
}

export function cohortFigure(
  scope: string,
  outcomes: readonly CohortOutcome[],
  o: FigureOptions,
): CohortFigure {
  const first = outcomes[0];
  if (first === undefined) throw new RangeError(`no cohorts for ${scope}`);
  const sorted = [...outcomes].sort((a, b) => cmp(a.startD, b.startD) || cmp(a.id, b.id));
  const chosen = countedCohorts(sorted);
  const eff = effectiveN(sorted.map(asEffective)).n;
  const proportions = cifProportions(
    chosen.map(asEffective),
    o.params.cif.horizons,
    o.params.cif.confidence,
  );
  const obs: CifObservation[] = sorted.map((c) => ({
    time: c.sessions,
    cause: c.terminalKind as Cause | null,
  }));
  const block = Math.max(1, Math.ceil(o.timeoutSessions / o.step));
  const boot =
    o.intervals && obs.length > 0
      ? cifBootstrap(
          obs,
          o.params.cif.horizons,
          block,
          o.params.stats.bootstrapSizeCheckReplications,
          `cifboot:${scope}`,
        )
      : null;
  // E[NAV at end] - seed over the counted, resolved cohorts: seeded percentile bootstrap
  const resolved = chosen.filter((c) => !c.censored);
  let nav: NavFigure | null = null;
  if (resolved.length > 0) {
    const vals = resolved.map((c) => Number(c.outcomeMicro - c.seedMicro));
    const B = o.params.stats.bootstrapSizeCheckReplications;
    const rng = scopedPrng(`navboot:${scope}`);
    const means = new Float64Array(B);
    for (let b = 0; b < B; b += 1) {
      let s = 0;
      for (let k = 0; k < vals.length; k += 1) s += vals[belowInt(rng, vals.length)]!;
      means[b] = s / vals.length;
    }
    const lowQ = (1 - o.params.cif.confidence) / 2;
    nav = {
      n: vals.length,
      meanMicro: mean(vals),
      interval: { lower: percentile(means, lowQ), upper: percentile(means, 1 - lowQ) },
      replicates: B,
    };
  }
  return {
    scope,
    executionId: first.executionId,
    group: first.group,
    leverage: first.leverage,
    effectiveN: eff,
    cohorts: sorted.length,
    resolved: sorted.filter((c) => !c.censored).length,
    censored: sorted.filter((c) => c.censored).length,
    proportions,
    aalenJohansen: aalenJohansen(obs, o.params.cif.horizons),
    aalenJohansenBootstrap: boot,
    navMinusSeed: nav,
  };
}

export type Headline = {
  readonly scope: string;
  readonly comparator: string;
  /** CIF_target(252) of the execution minus the matched C2 value (percentage points / 100), null if either is unmeasured. */
  readonly cifTargetMinusC2: number | null;
  /** E[NAV at end] - seed minus the matched C2 value, micro-AUD. */
  readonly navMinusC2Micro: number | null;
  readonly effectiveN: number;
  readonly comparatorEffectiveN: number;
};

/** ARN-071 headline statistics: each execution's CIF_target at the last horizon and E[NAV]-seed minus its family's C2. */
export function headlines(
  figures: ReadonlyMap<string, CohortFigure>,
  families: readonly string[],
): Headline[] {
  const out: Headline[] = [];
  const lastOf = (f: CohortFigure): number => f.proportions.length - 1;
  for (const [scope, f] of [...figures.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (!/^E\d+/.test(f.executionId)) continue;
    const idx = Number(f.executionId.slice(1));
    const family = families[Math.floor((idx - 1) / 2)];
    if (family === undefined) continue;
    const c2 = figures.get(`C2-${family}`);
    const target = f.proportions[lastOf(f)]?.cif.target ?? null;
    const c2Target = c2?.proportions[c2 === undefined ? 0 : lastOf(c2)]?.cif.target ?? null;
    out.push({
      scope,
      comparator: `C2-${family}`,
      cifTargetMinusC2:
        target !== null &&
        c2Target !== null &&
        c2 !== undefined &&
        c2.effectiveN > 0 &&
        f.effectiveN > 0
          ? target - c2Target
          : null,
      navMinusC2Micro:
        f.navMinusSeed !== null && c2?.navMinusSeed != null
          ? f.navMinusSeed.meanMicro - c2.navMinusSeed.meanMicro
          : null,
      effectiveN: f.effectiveN,
      comparatorEffectiveN: c2?.effectiveN ?? 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Progress: P(target | NAV bucket, sessions bucket)
// ---------------------------------------------------------------------------------------------------------

export type ProgressCell = {
  readonly scope: string;
  readonly sessions: number;
  /** Lower edge of the NAV bucket in ppm of the seed (null = below the first edge). */
  readonly navFromPpm: number | null;
  readonly cohorts: number;
  readonly effectiveN: number;
  /** null = "not yet measured" (effective N below `progress_min_neff`). */
  readonly pTarget: number | null;
  readonly interval: Interval | null;
};

function navBucket(ppm: number, edges: readonly number[]): number | null {
  let lower: number | null = null;
  for (const e of edges) if (ppm >= e) lower = e;
  return lower;
}

/** Progress per execution: cohorts alive at a checkpoint, bucketed by NAV, with their eventual outcome. */
export function progressTable(
  outcomes: readonly CohortOutcome[],
  params: AgentParams,
  sessionsEdges: readonly number[] = params.progress.sessionsEdges,
): ProgressCell[] {
  const byScope = new Map<string, CohortOutcome[]>();
  for (const c of outcomes) {
    if (c.kind !== "E") continue;
    const k = figureScope(c);
    byScope.set(k, [...(byScope.get(k) ?? []), c]);
  }
  const cells: ProgressCell[] = [];
  for (const [scope, list] of [...byScope.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    for (const s of sessionsEdges) {
      const groups = new Map<string, CohortOutcome[]>();
      for (const c of list) {
        const point = c.checkpoints.find((p) => p[0] === s);
        if (point === undefined) continue;
        const b = navBucket(point[1], params.progress.navEdgesPpm);
        const key = b === null ? "-" : String(b);
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      for (const [key, members] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
        const eff = effectiveN(members.map(asEffective));
        const counted = new Set(eff.counted);
        const picked = members.filter((m) => counted.has(m.id));
        const hits = picked.filter((m) => m.terminalKind === "target").length;
        const enough = eff.n >= params.stats.progressMinNeff;
        cells.push({
          scope,
          sessions: s,
          navFromPpm: key === "-" ? null : Number(key),
          cohorts: members.length,
          effectiveN: eff.n,
          pTarget: enough ? hits / eff.n : null,
          interval: enough ? wilsonInterval(hits, eff.n, params.cif.confidence) : null,
        });
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------------------------------------
// ARN-049: sleeve figures at 10x and at the reality-adjusted 5x ("hypothetical leverage")
// ---------------------------------------------------------------------------------------------------------

export type SleeveLeg = {
  readonly leverage: number;
  readonly figure: CohortFigure;
  readonly sleeveTrades: number;
  readonly shadowTrades: number;
  readonly closeouts: number;
  readonly locks: number;
  readonly netPlMicro: bigint;
};

export type SleeveComparison = {
  readonly family: string;
  readonly label: "hypothetical leverage";
  readonly unlevered: CohortFigure | null;
  readonly levered: SleeveLeg | null;
  readonly reality: SleeveLeg | null;
};

function sleeveLeg(
  family: string,
  outcomes: readonly CohortOutcome[],
  group: "base" | "reality",
  figures: ReadonlyMap<string, CohortFigure>,
): SleeveLeg | null {
  const execution = `E${String(2 * ["F1", "F2", "F3", "F4", "F5", "F6"].indexOf(family) + 2).padStart(2, "0")}`;
  const scope = group === "base" ? execution : `${execution}~reality`;
  const figure = figures.get(scope);
  if (figure === undefined || figure.leverage === null) return null;
  const mine = outcomes.filter((c) => figureScope(c) === scope);
  let trades = 0;
  let shadow = 0;
  let closeouts = 0;
  let locks = 0;
  let net = 0n;
  for (const c of mine) {
    if (c.sleeve === null) continue;
    trades += c.sleeve.trades;
    shadow += c.sleeve.shadowTrades;
    closeouts += c.sleeve.closeouts;
    locks += c.sleeve.locks;
    net += c.sleeve.netPlMicro;
  }
  return {
    leverage: figure.leverage,
    figure,
    sleeveTrades: trades,
    shadowTrades: shadow,
    closeouts,
    locks,
    netPlMicro: net,
  };
}

export function sleeveComparison(
  outcomes: readonly CohortOutcome[],
  figures: ReadonlyMap<string, CohortFigure>,
  families: readonly string[],
): SleeveComparison[] {
  return families.map((family) => {
    const u = `E${String(2 * families.indexOf(family) + 1).padStart(2, "0")}`;
    return {
      family,
      label: "hypothetical leverage",
      unlevered: figures.get(u) ?? null,
      levered: sleeveLeg(family, outcomes, "base", figures),
      reality: sleeveLeg(family, outcomes, "reality", figures),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------
// ARN-078: rankings with tied groups
// ---------------------------------------------------------------------------------------------------------

export type RankGroup = {
  readonly rank: number;
  readonly tied: boolean;
  readonly members: readonly {
    readonly scope: string;
    readonly mean: number;
    readonly interval: Interval;
  }[];
};

export type Ranking = {
  readonly metric: "navMinusSeedMicro";
  readonly groups: readonly RankGroup[];
  readonly insufficient: readonly { readonly scope: string; readonly effectiveN: number }[];
};

/** Eligible executions (effective N >= progress_min_neff) ordered by mean; overlapping 90 % intervals are grouped as tied. */
export function rankExecutions(figures: readonly CohortFigure[], params: AgentParams): Ranking {
  const eligible = figures
    .filter(
      (f) =>
        /^E\d+/.test(f.executionId) &&
        f.effectiveN >= params.stats.progressMinNeff &&
        f.navMinusSeed !== null,
    )
    .map((f) => ({
      scope: f.scope,
      mean: f.navMinusSeed!.meanMicro,
      interval: f.navMinusSeed!.interval,
    }))
    .sort((a, b) => a.interval.lower - b.interval.lower || cmp(a.scope, b.scope));
  const groups: { members: typeof eligible; upper: number }[] = [];
  for (const e of eligible) {
    const g = groups[groups.length - 1];
    if (g !== undefined && e.interval.lower <= g.upper) {
      g.members = [...g.members, e];
      g.upper = Math.max(g.upper, e.interval.upper);
    } else {
      groups.push({ members: [e], upper: e.interval.upper });
    }
  }
  // best group first
  const ordered = groups
    .map((g) => ({
      members: [...g.members].sort((a, b) => b.mean - a.mean || cmp(a.scope, b.scope)),
    }))
    .sort((a, b) => b.members[0]!.mean - a.members[0]!.mean);
  return {
    metric: "navMinusSeedMicro",
    groups: ordered.map((g, i) => ({
      rank: i + 1,
      tied: g.members.length > 1,
      members: g.members,
    })),
    insufficient: figures
      .filter(
        (f) =>
          /^E\d+/.test(f.executionId) &&
          !(f.effectiveN >= params.stats.progressMinNeff && f.navMinusSeed !== null),
      )
      .map((f) => ({ scope: f.scope, effectiveN: f.effectiveN }))
      .sort((a, b) => cmp(a.scope, b.scope)),
  };
}

// ---------------------------------------------------------------------------------------------------------
// ARN-070: trade scorecard from the signal ledger
// ---------------------------------------------------------------------------------------------------------

export type Estimate = { readonly value: number | null; readonly interval: Interval | null };

export type TradeScorecard =
  | {
      readonly scope: string;
      readonly n: number;
      readonly insufficient: true;
      readonly message: string;
    }
  | {
      readonly scope: string;
      readonly n: number;
      readonly insufficient: false;
      readonly winRate: { readonly value: number; readonly interval: Interval };
      readonly avgWin: Estimate;
      readonly avgLoss: Estimate;
      readonly payoff: Estimate;
      readonly expectancy: Estimate;
      readonly profitFactor: Estimate;
      readonly holdingSessions: { readonly mean: number; readonly median: number };
      /** Share of decision sessions with at least one open row. */
      readonly exposure: number;
      readonly block: number;
      readonly blocks: number;
      readonly replicates: number;
    };

export const notEnoughHistory = (n: number): string => `Not enough history yet (n = ${n})`;

export type TradeInput = {
  readonly entries: readonly LedgerEntry[];
  /** Calendar of the replay (index of every session). */
  readonly sessions: readonly string[];
  readonly params: AgentParams;
  readonly scope: string;
};

function intervalOf(values: ArrayLike<number>, confidence: number): Interval {
  const lowQ = (1 - confidence) / 2;
  return { lower: percentile(values, lowQ), upper: percentile(values, 1 - lowQ) };
}

export function tradeScorecard(input: TradeInput): TradeScorecard {
  const { params, scope, sessions } = input;
  const closed = input.entries.filter((e) => e.net !== null && e.row.exit_d !== null);
  const n = closed.length;
  if (n < params.stats.scenarioMinN) {
    return { scope, n, insufficient: true, message: notEnoughHistory(n) };
  }
  const index = new Map<string, number>();
  sessions.forEach((d, i) => index.set(d, i));
  const r = closed.map((e) => frac(e.net!));
  const entrySession = closed.map((e) => index.get(e.row.entry_d) ?? 0);
  const holds = closed.map(
    (e) => (index.get(e.row.exit_d!) ?? 0) - (index.get(e.row.entry_d) ?? 0) + 1,
  );
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x <= 0);
  const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
  const avgWin = wins.length === 0 ? null : mean(wins);
  const avgLoss = losses.length === 0 ? null : mean(losses);
  const block = Math.max(
    params.stats.bootstrapBlockMinSessions,
    percentile(holds, params.stats.bootstrapBlockPercentile),
  );
  const B = params.stats.bootstrapReplicationsMin;
  // series: r, r*1[win], 1[win], r*1[loss], 1[loss] -- ratios of replicate means give the derived statistics
  const win = r.map((x) => (x > 0 ? 1 : 0));
  const boot = circularBlockBootstrap(
    {
      sessions: entrySession,
      sessionCount: sessions.length,
      block,
      replicates: B,
      series: [
        r,
        r.map((x, i) => x * win[i]!),
        win,
        r.map((x, i) => x * (1 - win[i]!)),
        win.map((w) => 1 - w),
      ],
    },
    scopedPrng(`card:${scope}`),
  );
  const [mR, mWR, mW, mLR, mL] = boot.replicateMeans as [
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
  ];
  const ratioSeries = (num: Float64Array, den: Float64Array): number[] => {
    const out: number[] = [];
    for (let b = 0; b < B; b += 1) if (den[b]! !== 0) out.push(num[b]! / den[b]!);
    return out;
  };
  const aw = ratioSeries(mWR, mW);
  const al = ratioSeries(mLR, mL);
  const po: number[] = [];
  const pf: number[] = [];
  for (let b = 0; b < B; b += 1) {
    if (mW[b]! !== 0 && mL[b]! !== 0 && mLR[b]! !== 0) {
      po.push(mWR[b]! / mW[b]! / Math.abs(mLR[b]! / mL[b]!));
    }
    if (mLR[b]! !== 0) pf.push(mWR[b]! / Math.abs(mLR[b]!));
  }
  const est = (value: number | null, series: number[]): Estimate => ({
    value,
    interval:
      value === null || series.length === 0 ? null : intervalOf(series, params.cif.confidence),
  });
  const openDays = new Set<string>();
  for (const e of closed) {
    const a = index.get(e.row.entry_d) ?? 0;
    const b = index.get(e.row.exit_d!) ?? a;
    for (let i = a; i <= b; i += 1) openDays.add(sessions[i]!);
  }
  const winCount = wins.length;
  return {
    scope,
    n,
    insufficient: false,
    winRate: { value: winCount / n, interval: wilsonInterval(winCount, n, params.cif.confidence) },
    avgWin: est(avgWin, aw),
    avgLoss: est(avgLoss, al),
    payoff: est(
      avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
      po,
    ),
    expectancy: { value: mean(r), interval: intervalOf(mR, params.cif.confidence) },
    profitFactor: est(
      losses.length > 0 && sum(losses) !== 0 ? sum(wins) / Math.abs(sum(losses)) : null,
      pf,
    ),
    holdingSessions: { mean: mean(holds), median: median(holds)! },
    exposure: openDays.size / sessions.length,
    block,
    blocks: boot.blocks,
    replicates: B,
  };
}

/** Group closed ledger rows by (lineage, rule version, variant) and score each group. */
export function tradeScorecards(
  result: LedgerResult,
  sessions: readonly string[],
  params: AgentParams,
): TradeScorecard[] {
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of result.entries) {
    const k = `${e.lineage}|${e.ruleVersion}|${e.variant}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([scope, entries]) => tradeScorecard({ entries, sessions, params, scope }));
}

// ---------------------------------------------------------------------------------------------------------
// ARN-072: triple barrier
// ---------------------------------------------------------------------------------------------------------

export type BarrierSpec = {
  readonly kUp: Rational;
  readonly kDown: Rational;
  readonly horizon: number;
  readonly cost: CostSetup;
};

export function barrierSpecFrom(params: AgentParams): BarrierSpec {
  return {
    kUp: params.stats.barrierKUp,
    kDown: params.stats.barrierKDown,
    horizon: params.stats.barrierHorizonSessions,
    cost: costSetupFrom(params),
  };
}

export type BarrierOutcome = {
  readonly hit: "up" | "down" | "time";
  /** Net return of the barrier trade after P5 brokerage and slippage on both sides. */
  readonly net: number;
};

/**
 * One barrier trade: buy at the open of `entryIdx` (ARN-032 slippage, qty = floor(notional / fill)),
 * upper barrier fill + k_up x ATR, lower barrier fill - k_down x ATR, a limit of `horizon` sessions
 * from the entry session. A session touching both barriers counts the lower first (adverse). A
 * barrier exit fills at the barrier (the open when it gaps through it) less slippage; the time exit
 * sells at the close of the last session. Null when the path is incomplete (data ends first).
 */
export function barrierTrade(
  src: PathSource,
  p: {
    readonly code: string;
    readonly entryIdx: number;
    readonly endIdx: number;
    readonly atrMicro: bigint;
    readonly advMicro: bigint;
  },
  spec: BarrierSpec,
): BarrierOutcome | null {
  const { sessions } = src;
  const last = p.entryIdx + spec.horizon - 1;
  if (last > p.endIdx || p.atrMicro <= 0n) return null;
  const entryBar = src.bar(p.code, sessions[p.entryIdx]!);
  if (entryBar === null) return null;
  const env = (bar: { open: bigint; high: bigint; low: bigint; close: bigint }): FillEnv => ({
    bar: { openMicro: bar.open, highMicro: bar.high, lowMicro: bar.low, closeMicro: bar.close },
    advMicro: p.advMicro,
    profile: spec.cost.profile,
    buckets: spec.cost.buckets,
  });
  const price = slippageFill(
    entryBar.open,
    "buy",
    p.advMicro,
    DEFAULT_TICK_CROSS_FACTOR,
    spec.cost.buckets,
  ).fillMicro;
  const qty = divFloor(spec.cost.notionalMicro, price);
  if (qty <= 0n) return null;
  const entry = fillEntryAtOpen(env(entryBar), qty);
  const costIn = entry.valueMicro + entry.brokerageMicro;
  const up =
    entry.fillPriceMicro + roundHalfAwayFromZero(mulRat(spec.kUp, makeRational(p.atrMicro)));
  const downRaw =
    entry.fillPriceMicro - roundHalfAwayFromZero(mulRat(spec.kDown, makeRational(p.atrMicro)));
  const down = downRaw < 1n ? 1n : downRaw;
  const done = (proceeds: bigint, hit: BarrierOutcome["hit"]): BarrierOutcome => ({
    hit,
    net: Number(proceeds - costIn) / Number(costIn),
  });
  let lastBar = entryBar;
  for (let i = p.entryIdx; i <= last; i += 1) {
    const bar = i === p.entryIdx ? entryBar : src.bar(p.code, sessions[i]!);
    if (bar === null) continue;
    lastBar = bar;
    const e = env(bar);
    const stop = fillIntradayStop(e, qty, down, { afterOpen: i === p.entryIdx });
    if (stop !== null) return done(stop.valueMicro - stop.brokerageMicro, "down");
    if (bar.high >= up) {
      const ref = i !== p.entryIdx && bar.open >= up ? bar.open : up;
      const fill = slippageFill(
        ref,
        "sell",
        p.advMicro,
        DEFAULT_TICK_CROSS_FACTOR,
        spec.cost.buckets,
      ).fillMicro;
      const value = qty * fill;
      return done(value - feeFor(spec.cost.profile, value, "sell"), "up");
    }
  }
  const fill = slippageFill(
    lastBar.close,
    "sell",
    p.advMicro,
    DEFAULT_TICK_CROSS_FACTOR,
    spec.cost.buckets,
  ).fillMicro;
  const value = qty * fill;
  return done(value - feeFor(spec.cost.profile, value, "sell"), "time");
}

export type LiftCard =
  | {
      readonly scope: string;
      readonly n: number;
      readonly insufficient: true;
      readonly message: string;
    }
  | {
      readonly scope: string;
      readonly n: number;
      readonly insufficient: false;
      readonly meanNet: number;
      readonly meanControl: number;
      /** Mean paired lift (barrier net minus the mean of the matched controls on the same date). */
      readonly lift: number;
      readonly liftInterval: Interval;
      readonly share: { readonly up: number; readonly down: number; readonly time: number };
      readonly block: number;
      readonly blocks: number;
      readonly replicates: number;
    };

function liftCard(
  scope: string,
  rows: readonly {
    readonly idx: number;
    readonly net: number;
    readonly control: number;
    readonly hit: BarrierOutcome["hit"];
  }[],
  sessionCount: number,
  params: AgentParams,
  holdBlock: number,
): LiftCard {
  const n = rows.length;
  if (n < params.stats.scenarioMinN) {
    return { scope, n, insufficient: true, message: notEnoughHistory(n) };
  }
  const lifts = rows.map((r) => r.net - r.control);
  const block = Math.max(params.stats.bootstrapBlockMinSessions, holdBlock);
  const B = params.stats.bootstrapReplicationsMin;
  const boot = circularBlockBootstrap(
    { sessions: rows.map((r) => r.idx), sessionCount, block, replicates: B, series: [lifts] },
    scopedPrng(`barrier:${scope}`),
  );
  const share = (h: BarrierOutcome["hit"]): number => rows.filter((r) => r.hit === h).length / n;
  return {
    scope,
    n,
    insufficient: false,
    meanNet: mean(rows.map((r) => r.net)),
    meanControl: mean(rows.map((r) => r.control)),
    lift: mean(lifts),
    liftInterval: intervalOf(boot.replicateMeans[0]!, params.cif.confidence),
    share: { up: share("up"), down: share("down"), time: share("time") },
    block,
    blocks: boot.blocks,
    replicates: B,
  };
}

/**
 * ARN-072 signal scorecard per (lineage, rule version, variant): each closed ledger row's barrier trade
 * (same entry session and fill as the row) against the barrier trades of its matched controls.
 */
export function barrierScorecards(
  result: LedgerResult,
  src: ControlSource,
  params: AgentParams,
): LiftCard[] {
  const spec = barrierSpecFrom(params);
  const sessions = src.sessions;
  const index = new Map<string, number>();
  sessions.forEach((d, i) => index.set(d, i));
  const endIdx = sessions.length - 1;
  const universe = new Map<string, Map<string, { adv: bigint }>>();
  const advOf = (d: string, family: LedgerEntry["family"], code: string): bigint => {
    const key = `${d}|${family}`;
    let m = universe.get(key);
    if (m === undefined) {
      m = new Map(src.controlUniverse(d, family).map((u) => [u.code, { adv: u.advMicro }]));
      universe.set(key, m);
    }
    return m.get(code)?.adv ?? 0n;
  };
  const groups = new Map<string, LedgerEntry[]>();
  for (const e of result.entries) {
    const k = `${e.lineage}|${e.ruleVersion}|${e.variant}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const cards: LiftCard[] = [];
  for (const [scope, entries] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const rows: { idx: number; net: number; control: number; hit: BarrierOutcome["hit"] }[] = [];
    const holds: number[] = [];
    for (const e of entries) {
      const entryIdx = index.get(e.row.entry_d);
      if (entryIdx === undefined || e.row.exit_d === null) continue;
      holds.push((index.get(e.row.exit_d) ?? entryIdx) - entryIdx + 1);
      const atr = src.positionFacts(e.code, e.decisionD)?.atrMicro ?? null;
      if (atr === null) continue;
      const own = barrierTrade(
        src,
        {
          code: e.code,
          entryIdx,
          endIdx,
          atrMicro: atr,
          advMicro: advOf(e.decisionD, e.family, e.code),
        },
        spec,
      );
      if (own === null) continue;
      const ctrl: number[] = [];
      for (const c of e.controls?.controls ?? []) {
        const catr = src.positionFacts(c.code, e.decisionD)?.atrMicro ?? null;
        if (catr === null) continue;
        const t = barrierTrade(
          src,
          {
            code: c.code,
            entryIdx,
            endIdx,
            atrMicro: catr,
            advMicro: advOf(e.decisionD, e.family, c.code),
          },
          spec,
        );
        if (t !== null) ctrl.push(t.net);
      }
      if (ctrl.length === 0) continue;
      rows.push({ idx: entryIdx, net: own.net, control: mean(ctrl), hit: own.hit });
    }
    const holdBlock =
      holds.length === 0 ? 0 : percentile(holds, params.stats.bootstrapBlockPercentile);
    cards.push(liftCard(scope, rows, sessions.length, params, holdBlock));
  }
  return cards;
}

// ---------------------------------------------------------------------------------------------------------
// ARN-074: candle-pattern scorecard
// ---------------------------------------------------------------------------------------------------------

export type PatternCard = {
  readonly pattern: string;
  /** Every pattern test is charged to the market's trial ledger against F4's lineage (ARN-074, ARN-085). */
  readonly chargedTo: string;
  readonly card: LiftCard;
};

export function patternScorecards(
  src: ControlSource & { familyInputs(d: string): import("@/lib/agents/families").FamilyInputs },
  params: AgentParams,
  market: string,
  range?: { readonly from: string; readonly to: string },
): PatternCard[] {
  const spec = barrierSpecFrom(params);
  const sessions = src.sessions;
  const endIdx = sessions.length - 1;
  const rows = new Map<
    string,
    { idx: number; net: number; control: number; hit: BarrierOutcome["hit"] }[]
  >();
  for (const name of PATTERN_NAMES) rows.set(name, []);
  for (let i = 0; i < endIdx; i += 1) {
    const d = sessions[i]!;
    if (range !== undefined && (d < range.from || d > range.to)) continue;
    if (i + spec.horizon > endIdx) break;
    const inputs = src.familyInputs(d);
    const memo = new Map<string, BarrierOutcome | null>();
    const outcome = (code: string, atr: bigint | null, adv: bigint): BarrierOutcome | null => {
      if (atr === null) return null;
      let o = memo.get(code);
      if (o === undefined) {
        o = barrierTrade(
          src,
          { code, entryIdx: i + 1, endIdx, atrMicro: atr, advMicro: adv },
          spec,
        );
        memo.set(code, o);
      }
      return o;
    };
    const eligible = inputs.codes.filter((c) => c.tier === "U1" || c.tier === "U2");
    for (const name of PATTERN_NAMES) {
      for (const c of eligible) {
        if (c.patterns?.[name] !== true) continue;
        const own = outcome(
          c.code,
          c.ind.atrWarm ? c.ind.atrMicro : null,
          c.ind.adv === null ? 0n : floorAdv(c.ind.adv),
        );
        if (own === null) continue;
        const ctrl: number[] = [];
        for (const o of eligible) {
          if (o.code === c.code || o.tier !== c.tier || o.patterns?.[name] === true) continue;
          const t = outcome(
            o.code,
            o.ind.atrWarm ? o.ind.atrMicro : null,
            o.ind.adv === null ? 0n : floorAdv(o.ind.adv),
          );
          if (t !== null) ctrl.push(t.net);
        }
        if (ctrl.length === 0) continue;
        rows.get(name)!.push({ idx: i, net: own.net, control: mean(ctrl), hit: own.hit });
      }
    }
  }
  return PATTERN_NAMES.map((name) => ({
    pattern: name,
    chargedTo: `${market}:F4`,
    card: liftCard(`pattern:${name}`, rows.get(name)!, sessions.length, params, params.windows.vol),
  }));
}

function floorAdv(adv: Rational): bigint {
  return divFloor(adv.num, adv.den);
}

// ---------------------------------------------------------------------------------------------------------
// ARN-076: leave-one-input-class-out (F6)
// ---------------------------------------------------------------------------------------------------------

export const F6_CLASSES = ["a", "b", "c", "d"] as const;

export type LeaveOneOut = {
  readonly disabled: string | null;
  readonly rows: number;
  readonly meanExcess: number | null;
  readonly meanNet: number | null;
};

export type ClassContribution = {
  readonly class: string;
  readonly without: LeaveOneOut;
  /** Mean paired excess with all classes minus without this class (the class's marginal contribution). */
  readonly contribution: number | null;
  readonly interval: Interval | null;
};

function f6Summary(result: LedgerResult, disabled: string | null) {
  const rows = result.entries.filter((e) => e.family === "F6" && e.net !== null);
  const ex = rows.filter((e) => e.excess !== null).map((e) => ratNum(e.excess!));
  const nets = rows.map((e) => frac(e.net!));
  return {
    summary: {
      disabled,
      rows: rows.length,
      meanExcess: ex.length === 0 ? null : mean(ex),
      meanNet: nets.length === 0 ? null : mean(nets),
    } satisfies LeaveOneOut,
    session: rows.filter((e) => e.excess !== null).map((e) => e.row.entry_d),
    values: ex,
  };
}

/**
 * Weekly re-run of F6 with each evidence class disabled in turn (the caller's `run` replays the ledger
 * with `familyOptions.f6DisabledClasses`). The contribution is the difference of the mean paired
 * excess; its interval pairs the two block bootstraps on the same seeded draws.
 */
export function leaveOneClassOut(
  run: (disabled: string | null) => LedgerResult,
  sessions: readonly string[],
  params: AgentParams,
  scope: string,
): { readonly all: LeaveOneOut; readonly classes: readonly ClassContribution[] } {
  const index = new Map<string, number>();
  sessions.forEach((d, i) => index.set(d, i));
  const full = f6Summary(run(null), null);
  const block = params.stats.bootstrapBlockMinSessions;
  const B = params.stats.bootstrapReplicationsMin;
  const replicates = (s: ReturnType<typeof f6Summary>, tag: string): Float64Array | null =>
    s.values.length === 0
      ? null
      : circularBlockBootstrap(
          {
            sessions: s.session.map((d) => index.get(d) ?? 0),
            sessionCount: sessions.length,
            block,
            replicates: B,
            series: [s.values],
          },
          scopedPrng(`loco:${scope}:${tag}`),
        ).replicateMeans[0]!;
  const classes: ClassContribution[] = [];
  const fullBoot = replicates(full, "draws");
  for (const cls of F6_CLASSES) {
    const w = f6Summary(run(cls), cls);
    const wBoot = replicates(w, "draws");
    let interval: Interval | null = null;
    if (fullBoot !== null && wBoot !== null) {
      const diff = new Float64Array(B);
      for (let b = 0; b < B; b += 1) diff[b] = fullBoot[b]! - wBoot[b]!;
      interval = intervalOf(diff, params.cif.confidence);
    }
    classes.push({
      class: cls,
      without: w.summary,
      contribution:
        full.summary.meanExcess !== null && w.summary.meanExcess !== null
          ? full.summary.meanExcess - w.summary.meanExcess
          : null,
      interval,
    });
  }
  return { all: full.summary, classes };
}

// ---------------------------------------------------------------------------------------------------------
// Zero-edge benchmark inputs (decision 32)
// ---------------------------------------------------------------------------------------------------------

export type FamilyFlow = {
  readonly family: string;
  readonly ruleVersion: string;
  readonly rows: number;
  /** Share of decision sessions with at least one new row of the family (the entry opportunity rate). */
  readonly entryRate: number;
  readonly meanHoldSessions: number;
  readonly medianVol20: number | null;
  readonly medianSlippageBps: number | null;
};

/** Measured turnover, holding period, volatility and slippage of a family's development rows. */
export function familyFlow(
  result: LedgerResult,
  src: ControlSource,
  family: LedgerEntry["family"],
  ruleVersion: string,
  decisionSessions: number,
): FamilyFlow {
  const index = new Map<string, number>();
  src.sessions.forEach((d, i) => index.set(d, i));
  const mine = result.entries.filter((e) => e.family === family && e.ruleVersion === ruleVersion);
  const days = new Set(mine.map((e) => e.decisionD));
  const holds: number[] = [];
  const vols: number[] = [];
  const bps: number[] = [];
  const universe = new Map<
    string,
    readonly { code: string; vol20: number | null; advMicro: bigint }[]
  >();
  for (const e of mine) {
    if (e.row.exit_d !== null) {
      holds.push((index.get(e.row.exit_d) ?? 0) - (index.get(e.row.entry_d) ?? 0) + 1);
    }
    let u = universe.get(e.decisionD);
    if (u === undefined) {
      u = src.controlUniverse(e.decisionD, family);
      universe.set(e.decisionD, u);
    }
    const me = u.find((x) => x.code === e.code);
    if (me?.vol20 != null) vols.push(me.vol20);
    if (me !== undefined) bps.push(ratNum(bucketBpsFor(me.advMicro)));
  }
  return {
    family,
    ruleVersion,
    rows: mine.length,
    entryRate: decisionSessions === 0 ? 0 : days.size / decisionSessions,
    meanHoldSessions: holds.length === 0 ? 1 : mean(holds),
    medianVol20: median(vols),
    medianSlippageBps: median(bps),
  };
}

/** Median 20-session volatility of the U1 universe over the development window (PRD-020). */
export function u1MedianVol(src: ControlSource, from: string, to: string): number | null {
  const vols: number[] = [];
  for (const d of src.sessions) {
    if (d < from || d > to) continue;
    for (const u of src.controlUniverse(d, "F1"))
      if (u.tier === "U1" && u.vol20 !== null) vols.push(u.vol20);
  }
  return median(vols);
}

export type ZeroEdgeSet = {
  readonly perFamily: readonly ZeroEdgeResult[];
  /** The PRD-020 table: one benchmark for all, U1 median volatility, pooled flow. */
  readonly prd020: ZeroEdgeResult | null;
  readonly skipped: readonly { readonly family: string; readonly reason: string }[];
};

export function zeroEdgeFor(
  flows: readonly FamilyFlow[],
  prd020Vol: number | null,
  params: AgentParams,
  fallbackSlippageBps: number,
): ZeroEdgeSet {
  const cohortParams = resolveCohortParams({});
  const perFamily: ZeroEdgeResult[] = [];
  const skipped: { family: string; reason: string }[] = [];
  for (const f of flows) {
    if (f.rows === 0 || f.medianVol20 === null) {
      skipped.push({ family: f.family, reason: "no development rows" });
      continue;
    }
    perFamily.push(
      zeroEdge({
        family: f.family,
        ruleVersion: f.ruleVersion,
        dailyVol: f.medianVol20,
        entryRate: Math.min(1, f.entryRate),
        meanHoldSessions: f.meanHoldSessions,
        slippageBps: f.medianSlippageBps ?? fallbackSlippageBps,
        params: cohortParams,
        trials: params.replay.zeroEdgeTrials,
        seed: params.replay.zeroEdgeSeed,
      }),
    );
  }
  const pooled = flows.filter((f) => f.rows > 0);
  let prd020: ZeroEdgeResult | null = null;
  if (prd020Vol !== null && pooled.length > 0) {
    prd020 = zeroEdge({
      family: "PRD-020",
      ruleVersion: pooled[0]!.ruleVersion,
      dailyVol: prd020Vol,
      entryRate: Math.min(1, mean(pooled.map((f) => f.entryRate))),
      meanHoldSessions: mean(pooled.map((f) => f.meanHoldSessions)),
      slippageBps: mean(pooled.map((f) => f.medianSlippageBps ?? fallbackSlippageBps)),
      params: cohortParams,
      trials: params.replay.zeroEdgeTrials,
      seed: params.replay.zeroEdgeSeed,
    });
  }
  return { perFamily, prd020, skipped };
}

// ---------------------------------------------------------------------------------------------------------
// Rows in the migration 0008 shapes and the determinism digest
// ---------------------------------------------------------------------------------------------------------

/** `replay_stat` (migration 0008): PK (run_id, scope, metric). */
export type ReplayStatRow = {
  readonly run_id: string;
  readonly scope: string;
  readonly metric: string;
  readonly d: string;
  readonly value_json: string;
};

/** `replay_run` (migration 0008). */
export type ReplayRunRow = {
  readonly id: string;
  readonly kind: "light" | "full" | "null" | "injected" | "evidence";
  readonly market: string;
  readonly snapshot_sha: string;
  readonly commit_sha: string;
  readonly params_sha: string;
  readonly seed: number;
  readonly node_version: string;
  readonly files_json: string;
  readonly minutes: number;
};

export type ReplayStatInput = {
  readonly scope: string;
  readonly metric: string;
  readonly value: unknown;
};

export function statRows(
  runId: string,
  d: string,
  items: readonly ReplayStatInput[],
): ReplayStatRow[] {
  const seen = new Set<string>();
  const rows = items
    .map((it) => ({
      run_id: runId,
      scope: it.scope,
      metric: it.metric,
      d,
      value_json: canonical(it.value),
    }))
    .sort((a, b) => cmp(a.scope, b.scope) || cmp(a.metric, b.metric));
  for (const r of rows) {
    const k = `${r.scope}\u0000${r.metric}`;
    if (seen.has(k)) throw new RangeError(`duplicate replay_stat key ${r.scope} / ${r.metric}`);
    seen.add(k);
  }
  return rows;
}

/** SHA-256 of the canonical output (cohort outcomes and every statistic): the replay's determinism digest. */
export function replayDigest(parts: {
  readonly cohorts: CohortReplayResult;
  readonly stats: readonly ReplayStatRow[];
}): string {
  return sha256Hex(
    canonicalJson({
      cohorts: plain(parts.cohorts),
      stats: parts.stats.map((s) => [s.scope, s.metric, s.d, s.value_json]),
    }),
  );
}

export type RunInput = {
  readonly id: string;
  readonly kind: ReplayRunRow["kind"];
  readonly market: string;
  readonly snapshotSha: string;
  readonly commitSha: string;
  readonly paramsSha: string;
  readonly seed: bigint;
  readonly nodeVersion: string;
  readonly minutes: number;
  readonly files: readonly string[];
  readonly digest: string;
};

export function replayRunRow(i: RunInput): ReplayRunRow {
  return {
    id: i.id,
    kind: i.kind,
    market: i.market,
    snapshot_sha: i.snapshotSha,
    commit_sha: i.commitSha,
    params_sha: i.paramsSha,
    seed: Number(i.seed),
    node_version: i.nodeVersion,
    files_json: canonicalJson({ digest: i.digest, files: [...i.files].sort() }),
    minutes: i.minutes,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Everything for one replay
// ---------------------------------------------------------------------------------------------------------

export type ScorecardInput = {
  readonly runId: string;
  readonly d: string;
  readonly params: AgentParams;
  readonly market: string;
  readonly families: readonly string[];
  readonly cohorts: CohortReplayResult;
  readonly ledger: LedgerResult | null;
  readonly src:
    | (ControlSource & { familyInputs(d: string): import("@/lib/agents/families").FamilyInputs })
    | null;
  readonly timeoutSessions: number;
  /** Extra statistic rows (e.g. leave-one-class-out, supplied by the caller that ran the replays). */
  readonly extra?: readonly ReplayStatInput[];
  readonly patterns?: boolean;
};

export type ScorecardOutput = {
  readonly rows: readonly ReplayStatRow[];
  readonly digest: string;
  readonly figures: readonly CohortFigure[];
};

export function buildReplayStats(input: ScorecardInput): ScorecardOutput {
  const { params } = input;
  const items: ReplayStatInput[] = [];
  const byScope = new Map<string, CohortOutcome[]>();
  for (const c of input.cohorts.cohorts) {
    const k = figureScope(c);
    byScope.set(k, [...(byScope.get(k) ?? []), c]);
  }
  const figures = new Map<string, CohortFigure>();
  for (const [scope, list] of [...byScope.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const isE = list[0]!.kind === "E";
    figures.set(
      scope,
      cohortFigure(scope, list, {
        params,
        step: input.cohorts.step,
        timeoutSessions: input.timeoutSessions,
        intervals: isE,
      }),
    );
  }
  const list = [...figures.values()];
  for (const f of list) {
    items.push({
      scope: f.scope,
      metric: "cif",
      value: {
        proportions: f.proportions,
        aalenJohansen: f.aalenJohansen,
        bootstrap: f.aalenJohansenBootstrap,
      },
    });
    items.push({
      scope: f.scope,
      metric: "effective_n",
      value: { n: f.effectiveN, cohorts: f.cohorts, resolved: f.resolved, censored: f.censored },
    });
    if (f.navMinusSeed !== null)
      items.push({ scope: f.scope, metric: "nav_minus_seed", value: f.navMinusSeed });
  }
  for (const h of headlines(figures, input.families)) {
    items.push({ scope: h.scope, metric: "headline", value: h });
  }
  const progress = progressTable(input.cohorts.cohorts, params);
  const progressScopes = [...new Set(progress.map((p) => p.scope))].sort();
  for (const s of progressScopes) {
    items.push({ scope: s, metric: "progress", value: progress.filter((p) => p.scope === s) });
  }
  for (const s of sleeveComparison(input.cohorts.cohorts, figures, input.families)) {
    if (s.levered !== null || s.reality !== null) {
      items.push({ scope: `sleeve:${s.family}`, metric: "sleeve_leverage", value: s });
    }
  }
  items.push({ scope: "all", metric: "ranking", value: rankExecutions(list, params) });

  if (input.ledger !== null) {
    const sessions = input.src?.sessions ?? [];
    for (const c of tradeScorecards(input.ledger, sessions, params)) {
      items.push({ scope: c.scope, metric: "scorecard", value: c });
    }
    if (input.src !== null) {
      for (const c of barrierScorecards(input.ledger, input.src, params)) {
        items.push({ scope: c.scope, metric: "barrier", value: c });
      }
      const decisionSessions = input.ledger.sessions;
      const pairs = [
        ...new Set(input.ledger.entries.map((e) => `${e.family}|${e.ruleVersion}`)),
      ].sort();
      const flows = pairs.map((pair) => {
        const [family, ruleVersion] = pair.split("|") as [LedgerEntry["family"], string];
        return familyFlow(input.ledger!, input.src!, family, ruleVersion, decisionSessions);
      });
      const u1 = u1MedianVol(input.src, sessions[0] ?? "", sessions[sessions.length - 1] ?? "");
      const ze = zeroEdgeFor(flows, u1, params, ratNum(bucketBpsFor(0n)));
      for (const z of ze.perFamily)
        items.push({
          scope: `${input.market}:${z.family}:${z.ruleVersion}`,
          metric: "zero_edge",
          value: z,
        });
      if (ze.prd020 !== null)
        items.push({ scope: "PRD-020", metric: "zero_edge", value: ze.prd020 });
      if (ze.skipped.length > 0)
        items.push({ scope: "all", metric: "zero_edge_skipped", value: ze.skipped });
      items.push({ scope: "all", metric: "family_flow", value: flows });
      if (input.patterns === true) {
        for (const p of patternScorecards(input.src, params, input.market)) {
          items.push({ scope: `pattern:${p.pattern}`, metric: "pattern", value: p });
        }
      }
    }
  }
  for (const e of input.extra ?? []) items.push(e);
  const rows = statRows(input.runId, input.d, items);
  return { rows, digest: replayDigest({ cohorts: input.cohorts, stats: rows }), figures: list };
}
