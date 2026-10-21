// A3 regime (M4 T6; AGT-101; docs/M4_design.md 2.4, decision 17). Deterministic, from index bars.
//   vol20_D   = sample st. dev. (n - 1) of the last 20 daily log returns (float64, fixed order);
//   vol pct   = 100 x (count of vol20 over the trailing 1,260 sessions BEFORE D with value <= vol20_D) / 1,260
//               (an exact rational; compared with the thresholds without float);
//   fall5     = 1 - C_D / C_{D-5} (exact);   SMA200 and "close vs SMA" exact.
// Raw state: SHOCK if fall5 > 7 % or pct > 95; else RISK-OFF if close < SMA and pct > 70; else
// RISK-ON if close > SMA and pct < 50; else NEUTRAL. Hysteresis only on leaving a state: SHOCK is
// entered the day the raw state is SHOCK; any other change needs 3 consecutive sessions whose raw
// state differs from the current state and takes the raw state of the third. Before 1,260 + 20
// sessions of history the state is "unknown" (no family enters). All thresholds are AgentParams.
import { logReturns, microToFloat, smaExact, stdevFloat } from "./indicators";
import type { AgentParams } from "./params";
import type { DecisionView } from "./decisionView";
import { cmpRat, makeRational, ratFromInt, type Rational } from "@/lib/money/rational";

export type RegimeKnown = "SHOCK" | "RISK-OFF" | "RISK-ON" | "NEUTRAL";
export type RegimeLabel = RegimeKnown | "unknown";

export type RegimeResult = {
  readonly close_micro: bigint;
  readonly sma_micro: bigint | null;
  readonly vol20: number | null;
  /** 0..100, from integers (count x 100 / lookback). */
  readonly vol_pct: number | null;
  readonly fall5_ppm: number | null;
  readonly raw_state: RegimeLabel;
  readonly state: RegimeLabel;
  readonly exit_streak: number;
};

export type RegimeCarry = { readonly state: RegimeLabel; readonly exitStreak: number };

const PERCENT = 100n; // threshold-ok: percent scale of the volatility percentile
const PPM = 1_000_000n; // threshold-ok: parts-per-million display unit

/** Round half away from zero of a rational to an integer. */
export function roundHalfAway(r: Rational): bigint {
  const neg = r.num < 0n;
  const n = neg ? -r.num : r.num;
  const q = (2n * n + r.den) / (2n * r.den);
  return neg ? -q : q;
}

/** Sessions of index history needed for a non-unknown state at D (1,260 + 20 + the close of D). */
export function regimeWarmupCloses(p: AgentParams): number {
  return p.windows.regimeVolLookback + p.windows.vol + 1;
}

/** vol20 at every close index (null before `window` returns exist). */
export function volSeries(closes: readonly bigint[], window: number): (number | null)[] {
  const returns = logReturns(closes.map(microToFloat));
  const out: (number | null)[] = closes.map(() => null);
  for (let i = window; i < closes.length; i++) {
    out[i] = stdevFloat(returns.slice(i - window, i), window, 1);
  }
  return out;
}

type RawAt = Omit<RegimeResult, "state" | "exit_streak">;

function rawAt(
  closes: readonly bigint[],
  vols: readonly (number | null)[],
  i: number,
  p: AgentParams,
): RawAt {
  const close = closes[i]!;
  const lookback = p.windows.regimeVolLookback;
  const sma =
    i + 1 >= p.regime.smaSessions
      ? smaExact(closes.slice(i + 1 - p.regime.smaSessions, i + 1), p.regime.smaSessions)
      : null;
  const base = i >= p.windows.regimeFall ? closes[i - p.windows.regimeFall]! : null;
  const fall = base !== null && base > 0n ? makeRational(base - close, base) : null;
  const fall5_ppm = fall === null ? null : Number(roundHalfAway(mulPpm(fall)));
  const vol = vols[i] ?? null;
  const warm = i >= lookback + p.windows.vol;
  let count: number | null = null;
  if (warm && vol !== null) {
    count = 0;
    for (let j = i - lookback; j < i; j++) {
      const v = vols[j];
      if (v === null || v === undefined) {
        count = null;
        break;
      }
      if (v <= vol) count += 1;
    }
  }
  const base_: RawAt = {
    close_micro: close,
    sma_micro: sma === null ? null : roundHalfAway(sma),
    vol20: vol,
    vol_pct: count === null ? null : Number(BigInt(count) * PERCENT) / lookback,
    fall5_ppm,
    raw_state: "unknown",
  };
  if (sma === null || fall === null || count === null) return base_;
  const pct = makeRational(BigInt(count) * PERCENT, BigInt(lookback));
  const closeRat = ratFromInt(close);
  let raw: RegimeKnown = "NEUTRAL";
  if (cmpRat(fall, p.regime.fall5) > 0 || cmpRat(pct, p.regime.volPctShock) > 0) raw = "SHOCK";
  else if (cmpRat(closeRat, sma) < 0 && cmpRat(pct, p.regime.volPctRiskOff) > 0) raw = "RISK-OFF";
  else if (cmpRat(closeRat, sma) > 0 && cmpRat(pct, p.regime.volPctRiskOn) < 0) raw = "RISK-ON";
  return { ...base_, raw_state: raw };
}

function mulPpm(r: Rational): Rational {
  return makeRational(r.num * PPM, r.den);
}

/** One hysteresis step (pure). `prev` null = no earlier state. */
export function stepRegime(
  prev: RegimeCarry | null,
  raw: RegimeLabel,
  exitHysteresis: number,
): RegimeCarry {
  if (raw === "unknown") return { state: "unknown", exitStreak: 0 };
  if (prev === null || prev.state === "unknown") return { state: raw, exitStreak: 0 };
  if (raw === prev.state) return { state: raw, exitStreak: 0 };
  if (raw === "SHOCK") return { state: "SHOCK", exitStreak: 0 }; // entered immediately
  const streak = prev.exitStreak + 1;
  if (streak >= exitHysteresis) return { state: raw, exitStreak: 0 };
  return { state: prev.state, exitStreak: streak };
}

/** The whole series (oldest first), hysteresis carried from the first session. */
export function regimeSeries(closes: readonly bigint[], p: AgentParams): RegimeResult[] {
  const vols = volSeries(closes, p.windows.vol);
  const out: RegimeResult[] = [];
  let carry: RegimeCarry | null = null;
  for (let i = 0; i < closes.length; i++) {
    const raw = rawAt(closes, vols, i, p);
    carry = stepRegime(carry, raw.raw_state, p.regime.exitHysteresis);
    out.push({ ...raw, state: carry.state, exit_streak: carry.exitStreak });
  }
  return out;
}

/**
 * The regime of the last close. With a carried state (yesterday's regime_daily row) it is one
 * hysteresis step; without one it replays the series from its start, which gives the same answer
 * when the carried row came from the same series.
 */
export function regimeForLast(
  closes: readonly bigint[],
  p: AgentParams,
  prior: RegimeCarry | null,
): RegimeResult {
  if (closes.length === 0) throw new RangeError("no index closes");
  if (prior === null) return regimeSeries(closes, p)[closes.length - 1]!;
  const vols = volSeries(closes, p.windows.vol);
  const raw = rawAt(closes, vols, closes.length - 1, p);
  const carry = stepRegime(prior, raw.raw_state, p.regime.exitHysteresis);
  return { ...raw, state: carry.state, exit_streak: carry.exitStreak };
}

/** Reads the index bars through the view (all <= D) and classifies D. */
export async function computeRegime(
  view: DecisionView,
  indexCode: string,
  p: AgentParams,
  version: number,
): Promise<{ d: string; result: RegimeResult } | null> {
  const need = regimeWarmupCloses(p);
  const bars = await view.indexBars(indexCode, need);
  const last = bars[bars.length - 1];
  if (last === undefined) return null;
  const prior = await view.priorRegime(version);
  const carry: RegimeCarry | null =
    prior === null ? null : { state: prior.state as RegimeLabel, exitStreak: prior.exit_streak };
  const closes = bars.map((b) => b.close);
  return { d: last.d, result: regimeForLast(closes, p, carry) };
}
