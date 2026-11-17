// Synthetic fixtures for the learning-loop pure cores (tests only; no real data).
import type { LearnEvent, AngleDayRow, CompareRow, Horizon } from "@/lib/cortex/learn/types";
import { scopedPrng, uniform01, type Prng } from "@/lib/stats/rng";

/** `count` weekday dates from `start` (a Monday), as YYYY-MM-DD. */
export function weekdays(count: number, start = "2026-01-05"): string[] {
  const out: string[] = [];
  const t = new Date(`${start}T00:00:00Z`);
  while (out.length < count) {
    const day = t.getUTCDay();
    if (day !== 0 && day !== 6) out.push(t.toISOString().slice(0, 10));
    t.setUTCDate(t.getUTCDate() + 1);
  }
  return out;
}

export function normal(rng: Prng): number {
  const u = Math.max(uniform01(rng), Number.MIN_VALUE);
  const v = uniform01(rng);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function row(
  d: string,
  angleId: string,
  horizon: Horizon,
  ic: number | null,
  extra: Partial<AngleDayRow> = {},
): AngleDayRow {
  return {
    market: "ASX",
    d,
    angleId,
    angleVersion: 1,
    horizon,
    featureD: d,
    n: 450,
    ic,
    topExcessPpm: null,
    bottomExcessPpm: null,
    basePpm: null,
    regime: "RISK_ON",
    resultsSeason: 0,
    psiPpm: 10_000,
    excludedNews: 0,
    activeSetHash: "h",
    manifestId: "m",
    ...extra,
  };
}

/**
 * IC paths per angle: daily IC = `meanAt(angle, t)` + N(0, sd) noise; the 20-session IC at t is
 * `meanAt(angle, t)` + the mean of the daily noises t−19..t (overlapping windows, as real 20-session
 * returns overlap). Both horizons carry the same level path, so "the IC drops at session 100" holds for
 * both scorecard horizons.
 */
export function icPaths(input: {
  readonly angles: readonly string[];
  readonly sessions: number;
  readonly sd: number;
  readonly seed: string;
  readonly meanAt: (angle: string, t: number) => number;
}): Map<string, { daily: number[]; h20: number[] }> {
  const rng = scopedPrng(input.seed);
  const out = new Map<string, { daily: number[]; h20: number[] }>();
  for (const a of input.angles) {
    const noise: number[] = [];
    for (let t = 0; t < input.sessions; t += 1) noise.push(input.sd * normal(rng));
    const daily = noise.map((z, t) => input.meanAt(a, t) + z);
    const h20: number[] = [];
    let s = 0;
    for (let t = 0; t < input.sessions; t += 1) {
      s += noise[t]!;
      if (t >= 20) s -= noise[t - 20]!;
      h20.push(input.meanAt(a, t) + s / Math.min(t + 1, 20));
    }
    out.set(a, { daily, h20 });
  }
  return out;
}

/** cortex_angle_day rows for sessions [from, to) of the paths (both horizons). */
export function rowsOf(
  paths: Map<string, { daily: number[]; h20: number[] }>,
  dates: readonly string[],
  from: number,
  to: number,
  horizons: readonly Horizon[] = [1, 20],
): AngleDayRow[] {
  const out: AngleDayRow[] = [];
  for (const [a, p] of paths) {
    for (let t = Math.max(0, from); t < to; t += 1) {
      if (horizons.includes(1)) out.push(row(dates[t]!, a, 1, p.daily[t]!));
      if (horizons.includes(20) && t >= 19) out.push(row(dates[t]!, a, 20, p.h20[t]!));
    }
  }
  return out;
}

export function compareRow(
  decisionD: string,
  delta20: number | null,
  extra: Partial<CompareRow> = {},
): CompareRow {
  const agree = delta20 === null ? 1 : 0;
  return {
    market: "ASX",
    decisionD,
    family: "F1",
    bookId: "B1",
    fixedRuleVersion: "F1.v2-mom",
    learnerRuleVersion: "F1.learn",
    learnerGeneration: 1,
    fixedCode: "AAA",
    learnerCode: agree ? "AAA" : "BBB",
    agree: agree as 0 | 1,
    fixedRet1Ppm: 0,
    learnerRet1Ppm: 0,
    fixedRet20Ppm: 0,
    learnerRet20Ppm: delta20 === null ? 0 : Math.round(delta20 * 1_000_000),
    maturedD: decisionD,
    regime: "RISK_ON",
    ...extra,
  };
}

export function event(
  d: string,
  seq: number,
  kind: LearnEvent["kind"],
  extra: Partial<LearnEvent> = {},
): LearnEvent {
  return {
    market: "ASX",
    d,
    seq,
    kind,
    family: null,
    angleId: null,
    generation: null,
    evidence: {},
    words: "x",
    reversesSeq: null,
    expiresD: null,
    ...extra,
  };
}
