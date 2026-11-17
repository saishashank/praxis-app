// The SHOCK stop comparator (M23 T4; CXA-011, D-1638, D-1750). Pure and seeded: no database, no clock. The frozen plan is
// `docs/research/prereg/CXA-011.json`; the numbers below transcribe it and a test checks that the two agree. For one closed
// would-have hold that saw a SHOCK session it walks the stored plan twice with the app's own walker (`wouldHaveOutcome`): the
// base path as the app scores it today, and the tight path, the same walk with the stop level raised at the close of the first
// SHOCK session to the higher of the level in force and that close less one ATR(14), applied from the next session and filled by
// the same intraday stop model. Nothing here is read by a book, a rule, a gate or sizing: the comparator only records pairs.
import type { ViewBar } from "@/lib/agents/decisionView";
import { atrSeries, atrToMicro } from "@/lib/agents/indicators";
import { wouldHaveOutcome, type WouldHaveInput } from "@/lib/cortex/night";
import type { Micro } from "@/lib/money/micro";
import { percentile } from "@/lib/stats/bootstrap";
import { scopedPrng, STATS_MASTER_SEED } from "@/lib/stats/rng";
import { stationaryBlockBootstrap } from "@/lib/stats/stationaryBootstrap";
import { DEFAULT_REPLICATES, FAMILY_ALPHA, type EngineVerdict } from "../eventStudy";

/** The repo path of the frozen plan (the registry hash is the sha256 of this file's text). */
export const SHOCK_PLAN_PATH = "docs/research/prereg/CXA-011.json";

/** The six families the comparator follows, in the order of the plan. */
export const SHOCK_FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const;
export type ShockFamily = (typeof SHOCK_FAMILIES)[number];

export const shockLineage = (family: string): string => `shock_stops_${family}`;

/** The holds a family needs before its one look (D-1638). */
export const SHOCK_N = 30; // threshold-ok: D-1638 one look per family at 30 holds that saw a SHOCK session
/** The ATR period and multiple of the raised level (D-1638). */
export const SHOCK_ATR_PERIOD = 14; // threshold-ok: D-1638 ATR(14)
export const SHOCK_ATR_MULTIPLE = 1n; // threshold-ok: D-1638 one ATR below the SHOCK close
/** Expected bootstrap block, in clusters of first-SHOCK sessions (D-1750: a SHOCK spell is about three sessions long). */
export const SHOCK_BLOCK = 3; // threshold-ok: D-1750 expected block of the bootstrap
const PPM = 1_000_000n; // threshold-ok: parts per million
const ATR_BARS = 250; // threshold-ok: the same bar history the app's ATR reads (ATR_HISTORY)
const MIN_STATS = 6; // threshold-ok: decimal places kept in a stored aggregate

const microF = (v: bigint): number => Number(v) / 1_000_000; // threshold-ok: micro to units

/** Wilder ATR(14) of the last 250 bars in micro; null before 15 bars or when it is not positive. */
export function atr14Micro(bars: readonly ViewBar[]): Micro | null {
  const use = bars.slice(-ATR_BARS);
  if (use.length < SHOCK_ATR_PERIOD + 1) return null;
  const series = atrSeries(
    use.map((b) => microF(b.high)),
    use.map((b) => microF(b.low)),
    use.map((b) => microF(b.close)),
    SHOCK_ATR_PERIOD,
  );
  const last = series[series.length - 1];
  if (last === null || last === undefined || !(last > 0)) return null;
  return atrToMicro(last);
}

/** The raised stop level at a SHOCK close: the close less one ATR(14); null when no ATR can be formed or the level is not positive. */
export function shockLevel(history: readonly ViewBar[]): Micro | null {
  const close = history[history.length - 1]?.close;
  const atr = atr14Micro(history);
  if (close === undefined || atr === null) return null;
  const level = close - SHOCK_ATR_MULTIPLE * atr;
  return level > 0n ? level : null;
}

/** Net in parts per million of the entry fill value (price times quantity), rounded half away from zero. */
export function netPpm(net: Micro, fillMicro: Micro, qty: bigint): number {
  const value = fillMicro * qty;
  if (value <= 0n) throw new RangeError("the entry value must be positive");
  const num = net * PPM;
  const half = value / 2n;
  const q = num >= 0n ? (num + half) / value : -((-num + half) / value);
  return Number(q);
}

export type HoldPair = {
  /** The base path: the app's scoring today. */
  readonly base: { readonly exitD: string; readonly netMicro: Micro; readonly exitRule: string };
  /** The tight path: the same walk with the level raised after the first SHOCK session. */
  readonly tight: { readonly exitD: string; readonly netMicro: Micro; readonly exitRule: string };
  readonly basePpm: number;
  readonly tightPpm: number;
  readonly raisedTo: Micro;
};

/**
 * Walks one closed hold twice. `input` is exactly what the app scored the decision with (`bars` are the sessions after the
 * decision night); `history` is the code's raw bars up to and including the decision night; `shockD` is the first SHOCK session
 * after the fill and before the exit. Null when the entry did not fill, the hold did not close, `shockD` is not a session of the
 * hold, or no raised level can be formed (nothing is recorded then).
 */
export function replayHold(
  input: Omit<WouldHaveInput, "raiseStop">,
  history: readonly ViewBar[],
  shockD: string,
): HoldPair | null {
  const base = wouldHaveOutcome(input);
  if (base === null || base.fillStatus !== "filled") return null;
  if (base.exitD === null || base.netMicro === null || base.exitRule === null) return null;
  if (base.fillMicro === null) return null;
  const at = input.bars.findIndex((b) => b.d === shockD);
  if (at < 0 || shockD >= base.exitD) return null;
  const seen = [...history, ...input.bars.slice(0, at + 1)];
  const level = shockLevel(seen);
  if (level === null) return null;
  const tight = wouldHaveOutcome({
    ...input,
    raiseStop: (bar) => (bar.d === shockD ? level : null),
  });
  if (tight === null || tight.fillStatus !== "filled") return null;
  if (tight.exitD === null || tight.netMicro === null || tight.exitRule === null) return null;
  return {
    base: { exitD: base.exitD, netMicro: base.netMicro, exitRule: base.exitRule },
    tight: { exitD: tight.exitD, netMicro: tight.netMicro, exitRule: tight.exitRule },
    basePpm: netPpm(base.netMicro, base.fillMicro, input.qty),
    tightPpm: netPpm(tight.netMicro, base.fillMicro, input.qty),
    raisedTo: level,
  };
}

/** One recorded hold as the look reads it: the first SHOCK session and the two nets in parts per million. */
export type ShockObs = {
  readonly dShock: string;
  readonly basePpm: number;
  readonly tightPpm: number;
};

export type ShockResult =
  | { readonly status: "below_sample"; readonly reason: string }
  | {
      readonly status: "looked";
      readonly verdict: EngineVerdict;
      readonly n: number;
      readonly clusters: number;
      readonly meanBasePpm: number;
      readonly meanTightPpm: number;
      readonly meanDiffPpm: number;
      readonly lowerPpm: number | null;
    };

const round6 = (v: number): number => Math.round(v * 10 ** MIN_STATS) / 10 ** MIN_STATS; // threshold-ok: 6 places kept

const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

/** The one look of a family on its recorded holds. Below the floor nothing is computed. Deterministic for a given input. */
export function evaluateShock(
  family: string,
  obs: readonly ShockObs[],
  opts: { readonly replicates?: number; readonly masterSeed?: bigint } = {},
): ShockResult {
  if (obs.length < SHOCK_N) return { status: "below_sample", reason: "too few recorded holds" };
  const dates = [...new Set(obs.map((o) => o.dShock))].sort();
  const ix = new Map(dates.map((x, i) => [x, i]));
  const diffs = obs.map((o) => o.tightPpm - o.basePpm);
  const rep = stationaryBlockBootstrap(
    { sessions: obs.map((o) => ix.get(o.dShock)!), sessionCount: dates.length },
    (rows: Int32Array): number => {
      let s = 0;
      for (let i = 0; i < rows.length; i += 1) s += diffs[rows[i]!]!;
      return rows.length === 0 ? Number.NaN : s / rows.length;
    },
    scopedPrng(`research:shock:${family}:boot`, opts.masterSeed ?? STATS_MASTER_SEED),
    {
      expectedBlock: SHOCK_BLOCK,
      maxHold: SHOCK_BLOCK,
      replicates: opts.replicates ?? DEFAULT_REPLICATES,
    },
  );
  const finite = Array.from(rep.values).filter((x) => Number.isFinite(x));
  const lower = finite.length === rep.values.length ? percentile(finite, FAMILY_ALPHA) : Number.NaN;
  const ok = Number.isFinite(lower);
  return {
    status: "looked",
    verdict: !ok ? "INCONCLUSIVE" : lower > 0 ? "PASS" : "NULL",
    n: obs.length,
    clusters: dates.length,
    meanBasePpm: round6(mean(obs.map((o) => o.basePpm))),
    meanTightPpm: round6(mean(obs.map((o) => o.tightPpm))),
    meanDiffPpm: round6(mean(diffs)),
    lowerPpm: ok ? round6(lower) : null,
  };
}

/** The aggregates stored with a family's look (numbers and words only; no code, no company). */
export function shockStats(
  family: string,
  r: Extract<ShockResult, { status: "looked" }>,
): Record<string, number | string | null> {
  return {
    family,
    kind: "paired difference, tight less base",
    direction: "above zero",
    n: r.n,
    clusters: r.clusters,
    blockSessions: SHOCK_BLOCK,
    level: FAMILY_ALPHA,
    meanBasePpm: r.meanBasePpm,
    meanTightPpm: r.meanTightPpm,
    meanDiffPpm: r.meanDiffPpm,
    lowerPpm: r.lowerPpm,
  };
}
