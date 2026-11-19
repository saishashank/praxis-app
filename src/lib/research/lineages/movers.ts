// The six mover rules and their one-look evaluation (M23 M3; CXA-014, D-1625, D-1721). Pure and seeded: no database, no clock.
// The frozen plan is `docs/research/prereg/CXA-014.json`; every number below is a transcription of it and a test checks that
// the two agree. Order of work (D-1605): the caller counts matured events from dates alone and calls `evaluateMover` only once
// that count has reached the rule's n; below n this function returns "below sample" before it looks at any value. A rule
// is either a mean rule (the direction-signed mean of its events' market-adjusted return) or a difference rule (the mean
// of one group less the mean of the other). The interval is the one-sided 90 % lower bound of a stationary block bootstrap
// resampled by session, expected block = the rule's horizon. PASS when that bound is above zero, NULL when it is not,
// INCONCLUSIVE (and spent) when the statistic cannot be formed. Aggregates only: no code, no company leaves this module.
import { percentile } from "@/lib/stats/bootstrap";
import { scopedPrng, STATS_MASTER_SEED } from "@/lib/stats/rng";
import { stationaryBlockBootstrap } from "@/lib/stats/stationaryBootstrap";
import {
  blockLowerBound,
  DEFAULT_REPLICATES,
  FAMILY_ALPHA,
  type EngineVerdict,
} from "../eventStudy";

/** The repo path of the frozen plan (the registry hash is the sha256 of this file's text). */
export const MOVERS_PLAN_PATH = "docs/research/prereg/CXA-014.json";

export type MoverId = "A1" | "A2" | "A3" | "A4" | "A5" | "A8";

export type MoverRule = {
  readonly id: MoverId;
  readonly lineage: string;
  /** mean: direction-signed mean of the events; difference: mean of side 1 less mean of side 0. */
  readonly kind: "mean" | "difference";
  /** The floor of events (for a difference rule: on each side), D-1625. */
  readonly n: number;
  /** The outcome horizon in sessions, also the expected bootstrap block. */
  readonly horizon: number;
  /** +1: the mean is expected above zero; -1: below zero (mean rules only). */
  readonly direction: 1 | -1;
};

/** The six rules, in the order of the plan (a test compares this with the frozen file). */
export const MOVER_RULES: readonly MoverRule[] = [
  { id: "A1", lineage: "movers_a1", kind: "mean", n: 40, horizon: 5, direction: -1 }, // threshold-ok: D-1625 A1 n and horizon
  { id: "A2", lineage: "movers_a2", kind: "difference", n: 60, horizon: 20, direction: 1 }, // threshold-ok: D-1625 A2 n and horizon
  { id: "A3", lineage: "movers_a3", kind: "mean", n: 100, horizon: 10, direction: 1 }, // threshold-ok: D-1625 A3 n and horizon
  { id: "A4", lineage: "movers_a4", kind: "mean", n: 60, horizon: 20, direction: -1 }, // threshold-ok: D-1625 A4 n and horizon
  { id: "A5", lineage: "movers_a5", kind: "mean", n: 60, horizon: 20, direction: 1 }, // threshold-ok: D-1625 A5 n and horizon
  { id: "A8", lineage: "movers_a8", kind: "difference", n: 60, horizon: 1, direction: 1 }, // threshold-ok: D-1625 A8 n and horizon
];

export const moverRuleOf = (id: MoverId): MoverRule => MOVER_RULES.find((r) => r.id === id)!;

/** The default grid point of the volume-creep angle that A3 counts (a test pins it to the angle registry). */
export const CREEP_ANGLE_ID = "A-D2-07";
export const CREEP_GRID_KEY = "ar_min_pct=2,vr_min=3";

/** One matured event: its session, its outcome in parts per million, and for a difference rule its side (1 or 0). */
export type MoverObs = { readonly session: string; readonly value: number; readonly side?: 0 | 1 };

export type MoverResult =
  | { readonly status: "below_sample"; readonly reason: string }
  | {
      readonly status: "looked";
      readonly verdict: EngineVerdict;
      readonly n: number;
      readonly sessions: number;
      readonly blocks: number;
      readonly meanPpm: number | null;
      readonly lowerPpm: number | null;
    };

const MIN_FINITE_NUM = 95; // threshold-ok: a difference rule needs 95 % of its replicates to have both sides
const MIN_FINITE_DEN = 100; // threshold-ok: the denominator of that share

const round6 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1e6) / 1e6); // threshold-ok: 6 places kept in a stored aggregate

const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

/** Evaluates one rule on its matured events. Below the floor nothing is computed. Deterministic for a given input. */
export function evaluateMover(
  rule: MoverRule,
  obs: readonly MoverObs[],
  opts: { readonly replicates?: number; readonly masterSeed?: bigint } = {},
): MoverResult {
  const reps = opts.replicates ?? DEFAULT_REPLICATES;
  const seed = opts.masterSeed ?? STATS_MASTER_SEED;
  const scope = `research:movers:${rule.id}:boot`;
  const dates = [...new Set(obs.map((o) => o.session))].sort();
  const ix = new Map(dates.map((x, i) => [x, i]));
  const sessions = obs.map((o) => ix.get(o.session)!);
  if (rule.kind === "mean") {
    if (obs.length < rule.n) return { status: "below_sample", reason: "too few matured events" };
    const values = obs.map((o) => o.value * rule.direction);
    const lower = blockLowerBound({
      sessions,
      sessionCount: dates.length,
      values,
      block: rule.horizon,
      alpha: FAMILY_ALPHA,
      scope,
      replicates: reps,
      masterSeed: seed,
    });
    const m = mean(values) * rule.direction; // back to the raw sign of the return
    return {
      status: "looked",
      verdict: lower === null ? "INCONCLUSIVE" : lower > 0 ? "PASS" : "NULL",
      n: obs.length,
      sessions: dates.length,
      blocks: Math.floor(dates.length / rule.horizon),
      meanPpm: round6(m),
      lowerPpm: round6(lower),
    };
  }
  const one = obs.filter((o) => o.side === 1);
  const zero = obs.filter((o) => o.side === 0);
  if (one.length < rule.n || zero.length < rule.n)
    return { status: "below_sample", reason: "too few matured events on one side" };
  const v = obs.map((o) => o.value);
  const s1 = obs.map((o) => (o.side === 1 ? 1 : 0));
  const diff = (rows: Int32Array): number => {
    let a = 0;
    let na = 0;
    let b = 0;
    let nb = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]!;
      if (s1[r] === 1) {
        a += v[r]!;
        na += 1;
      } else {
        b += v[r]!;
        nb += 1;
      }
    }
    return na === 0 || nb === 0 ? Number.NaN : a / na - b / nb;
  };
  const rep = stationaryBlockBootstrap(
    { sessions, sessionCount: dates.length },
    diff,
    scopedPrng(scope, seed),
    { expectedBlock: rule.horizon, maxHold: rule.horizon, replicates: reps },
  );
  const finite = Array.from(rep.values).filter((x) => Number.isFinite(x));
  const point = mean(one.map((o) => o.value)) - mean(zero.map((o) => o.value));
  // a replicate that lost a side has no value; the statistic is undefined if more than 5 % did (D-1605: INCONCLUSIVE, spent)
  const defined = finite.length * MIN_FINITE_DEN >= rep.values.length * MIN_FINITE_NUM;
  const lower = defined ? percentile(finite, FAMILY_ALPHA) : Number.NaN;
  const ok = Number.isFinite(lower);
  return {
    status: "looked",
    verdict: !ok ? "INCONCLUSIVE" : lower > 0 ? "PASS" : "NULL",
    n: obs.length,
    sessions: dates.length,
    blocks: Math.floor(dates.length / rule.horizon),
    meanPpm: round6(point),
    lowerPpm: ok ? round6(lower) : null,
  };
}

/** The aggregates stored with a rule's look (numbers and words only; no code or company). */
export function moverStats(
  rule: MoverRule,
  r: Extract<MoverResult, { status: "looked" }>,
): Record<string, number | string | null> {
  return {
    rule: rule.id,
    kind: rule.kind,
    direction:
      rule.kind === "mean" ? (rule.direction === 1 ? "above zero" : "below zero") : "above zero",
    n: r.n,
    sessions: r.sessions,
    horizonSessions: rule.horizon,
    level: FAMILY_ALPHA,
    meanPpm: r.meanPpm,
    lowerPpm: r.lowerPpm,
  };
}
