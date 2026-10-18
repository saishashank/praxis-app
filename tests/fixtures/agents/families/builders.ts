// Synthetic AT-15 fixtures for the family rule interpreter (M4 T7; design decision 35). Public
// synthetic codes (ZZ prefix), generated deterministically in code: no market data, no files.
// Prices are integer micro-AUD; one tick of a series is 10,000 micro (A$0.01).
import type { ViewBar } from "@/lib/agents/decisionView";
import { buildCodeFacts } from "@/lib/agents/families/facts";
import type {
  CodeFacts,
  EventFact,
  ExitPlan,
  FamilyInputs,
  PositionState,
  Tier,
} from "@/lib/agents/families/types";
import type { AgentParams } from "@/lib/agents/params";
import type { EventCategory, Polarity } from "@/lib/agents/schema";
import { makeRational, parseRational, type Rational } from "@/lib/money/rational";

/** The decision session of every scenario (a Friday). */
export const D = "2026-10-16";
export const SESSIONS_N = 300;
export const CENT = 10_000n; // A$0.01 in micro
export const DOLLAR = 1_000_000n;

/** `n` weekday dates ending at `d`, oldest first (no holidays: a synthetic calendar). */
export function sessionList(d: string, n: number): string[] {
  const out: string[] = [];
  const cur = new Date(`${d}T00:00:00Z`);
  while (out.length < n) {
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return out.reverse();
}

export const SESSIONS = sessionList(D, SESSIONS_N);

export type SeriesSpec = {
  /** Close of session i (0 = oldest). */
  readonly close: (i: number) => bigint;
  readonly volume?: (i: number) => bigint;
  /** Half range around max/min(open, close); default one cent. */
  readonly spread?: bigint;
  readonly n?: number;
  /** Overrides for the last bar (the decision session). */
  readonly last?: Partial<Pick<ViewBar, "open" | "high" | "low" | "close" | "volume">>;
};

export function makeBars(spec: SeriesSpec): ViewBar[] {
  const n = spec.n ?? SESSIONS_N;
  const dates = sessionList(D, n);
  const spread = spec.spread ?? CENT;
  const vol = spec.volume ?? (() => 1_000_000n);
  const bars: ViewBar[] = [];
  for (let i = 0; i < n; i++) {
    const close = spec.close(i);
    const open = i === 0 ? close : spec.close(i - 1);
    const hi = (open > close ? open : close) + spread;
    const lo = (open < close ? open : close) - spread;
    bars.push({ d: dates[i]!, open, high: hi, low: lo, close, volume: vol(i) });
  }
  if (spec.last !== undefined) bars[n - 1] = { ...bars[n - 1]!, ...spec.last };
  return bars;
}

export function factsOf(
  code: string,
  tier: Tier,
  bars: readonly ViewBar[],
  p: AgentParams,
  extra: Partial<Parameters<typeof buildCodeFacts>[0]> = {},
): CodeFacts {
  return buildCodeFacts({ code, tier, adjusted: bars, raw: bars, ...extra }, p);
}

/** A gently rising series: A$1.00 + step per session. */
export const rising =
  (step: bigint, start = DOLLAR) =>
  (i: number): bigint =>
    start + BigInt(i) * step;

/** A near-flat series that wobbles inside a 4-cent band (return about zero). */
export const wobble =
  (base: bigint) =>
  (i: number): bigint =>
    base + BigInt(i % 5) * CENT;

/** Volumes: `base` shares every session except the last, which is `last`. */
export const volumes =
  (base: bigint, last: bigint, n = SESSIONS_N) =>
  (i: number): bigint =>
    i === n - 1 ? last : base;

/** Peers whose 6-month returns are all below the leader's (a tier of `count` codes). */
export function peers(
  prefix: string,
  tier: Tier,
  count: number,
  p: AgentParams,
  bases: readonly bigint[] = [],
): CodeFacts[] {
  const out: CodeFacts[] = [];
  for (let i = 0; i < count; i++) {
    const base = bases[i] ?? 2n * DOLLAR + BigInt(i) * CENT;
    out.push(factsOf(`${prefix}${i}`, tier, makeBars({ close: wobble(base) }), p));
  }
  return out;
}

export function override(c: CodeFacts, patch: Partial<Omit<CodeFacts, "ind">> & { ind?: Partial<CodeFacts["ind"]> }): CodeFacts {
  return { ...c, ...patch, ind: { ...c.ind, ...(patch.ind ?? {}) } };
}

export function rat(text: string): Rational {
  return parseRational(text);
}

export function ev(o: {
  code: string;
  day0?: string;
  category: EventCategory;
  polarity: Polarity;
  priceSensitive?: boolean;
  ar?: string | null;
  vol?: string | null;
  low?: bigint | null;
  timed?: boolean;
  seq?: number;
}): EventFact {
  const day0 = o.day0 ?? D;
  return {
    id: `ASX|${o.code}-${day0}-${o.seq ?? 0}`,
    code: o.code,
    day0,
    groupKey: `${o.code}:${day0}`,
    category: o.category,
    priceSensitive: o.priceSensitive ?? true,
    polarity: o.polarity,
    ar: o.ar === undefined || o.ar === null ? null : parseRational(o.ar),
    volRatio: o.vol === undefined || o.vol === null ? null : parseRational(o.vol),
    timed: o.timed ?? true,
    day0LowMicro: o.low === undefined ? null : o.low,
  };
}

export function inputsOf(
  codes: readonly CodeFacts[],
  over: Partial<FamilyInputs> = {},
): FamilyInputs {
  return {
    market: "AU",
    d: D,
    regime: "RISK-ON",
    sessions: SESSIONS,
    sources: { asx: "on", asic: "on" },
    eventCoverage: true,
    codes,
    events: [],
    ...over,
  };
}

/** A session `ago` sessions before D. */
export const dayAgo = (ago: number): string => SESSIONS[SESSIONS.length - 1 - ago]!;

export function position(plan: ExitPlan, over: Partial<PositionState> = {}): PositionState {
  return {
    tradeId: "T1",
    code: "ZZA",
    family: "F1",
    plan,
    fillDay: dayAgo(5),
    fillMicro: 2n * DOLLAR,
    sessionsHeld: 5,
    closeMicro: 2n * DOLLAR,
    highestCloseMicro: 2n * DOLLAR,
    atrMicro: 50n * CENT,
    closeAboveExitSma: false,
    volumeRatios: [],
    events: [],
    ...over,
  };
}

export const frac = (num: bigint, den: bigint): Rational => makeRational(num, den);
