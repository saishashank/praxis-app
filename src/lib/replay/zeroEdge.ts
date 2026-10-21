// Zero-edge benchmark (M4 T14; design 4.11, decision 32; ARN-071, PRD-020). For one (family, rule
// version) it runs `zero_edge_trials` Monte-Carlo cohorts of a strategy with NO edge, seeded by
// `zero_edge_seed`, and states how often such a cohort would reach target, bust, stall or time out
// by luck alone -- the yardstick the cohort CIFs are shown against.
//
// The model is deliberately plain (it is a benchmark, not a second simulator): a flat cohort sees an
// entry opportunity with probability `entryRate` per session (the family's measured turnover) and
// puts all deployable cash into one position (cash buffer, brokerage and slippage as ARN-024a);
// the position earns a zero-mean daily return with the family's volatility and is closed after the
// family's mean holding period; every cost is paid on both sides (P5 brokerage by `feeFor`, a
// slippage in bps). Terminal rules are the cohort's own: target and bust on liquidation NAV, stall
// (floor, and parcel: a window with entry opportunities that never met the marketable parcel) and
// timeout. Floats are used inside the simulation (price paths are float by design, 2.1); the seed
// scope is `zeroedge:<family>:<rule version>` (2.8). Same input, same seed -> same numbers.
import { feeFor, getCostProfile } from "@/lib/arena/costs";
import type { CohortParams } from "@/lib/arena/cohort";
import { scopedPrng, uniform01 } from "@/lib/stats";

export type ZeroEdgeInput = {
  /** Family id, or `PRD-020` for the U1 median-volatility table (separate, decision 32). */
  readonly family: string;
  readonly ruleVersion: string;
  /** Daily volatility (fraction): median 20-session volatility of the development rows. */
  readonly dailyVol: number;
  /** P(entry opportunity on a flat session), measured from the replay. */
  readonly entryRate: number;
  /** Mean holding period in sessions (rounded, at least 1). */
  readonly meanHoldSessions: number;
  /** One-way slippage in basis points of value. */
  readonly slippageBps: number;
  readonly params: CohortParams;
  readonly trials: number;
  /** `zero_edge_seed`. */
  readonly seed: number;
};

export type ZeroEdgeResult = {
  readonly family: string;
  readonly ruleVersion: string;
  readonly scope: string;
  readonly trials: number;
  readonly seed: number;
  readonly inputs: {
    readonly dailyVol: number;
    readonly entryRate: number;
    readonly meanHoldSessions: number;
    readonly slippageBps: number;
  };
  readonly probability: Readonly<Record<"target" | "bust" | "stalled" | "timeout", number>>;
  /** Monte-Carlo standard error of each probability: sqrt(p (1 - p) / trials). */
  readonly mcSe: Readonly<Record<"target" | "bust" | "stalled" | "timeout", number>>;
  /** E[liquidation NAV at the end] - seed, micro-AUD (float mean) and its Monte-Carlo SE. */
  readonly meanNavMinusSeedMicro: number;
  readonly navMcSeMicro: number;
  /** Mean sessions to the end. */
  readonly meanSessions: number;
};

const MICRO = 1_000_000; // threshold-ok: micro-AUD per A$ (unit conversion)

const BPS_PER_UNIT = 10_000; // threshold-ok: basis points per unit (unit conversion)

function ratNumber(r: { readonly num: bigint; readonly den: bigint }): number {
  return Number(r.num) / Number(r.den);
}

/** Box-Muller pair from two uniforms (Math.log/sqrt/cos/sin: one V8 build gives one answer, 2.8). */
function normals(u1: number, u2: number): [number, number] {
  const r = Math.sqrt(2 * -Math.log(u1 > 0 ? u1 : Number.MIN_VALUE));
  const a = 2 * Math.PI * u2;
  return [r * Math.cos(a), r * Math.sin(a)];
}

export function zeroEdge(input: ZeroEdgeInput): ZeroEdgeResult {
  const { params, trials } = input;
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError("trials must be positive");
  if (!(input.dailyVol >= 0)) throw new RangeError("volatility cannot be negative");
  if (!(input.entryRate >= 0 && input.entryRate <= 1))
    throw new RangeError("entry rate is a probability");
  const scope = `zeroedge:${input.family}:${input.ruleVersion}`;
  const rng = scopedPrng(scope, BigInt(input.seed));
  const profile = getCostProfile(params.costProfile);
  const fee = (valueAud: number, side: "buy" | "sell"): number => {
    const micro = Math.round(valueAud * MICRO);
    return micro > 0 ? Number(feeFor(profile, BigInt(micro), side)) / MICRO : 0;
  };
  const slip = input.slippageBps / BPS_PER_UNIT;
  const seed = Number(params.seedMicro) / MICRO;
  const target = seed * ratNumber(params.terminal.targetMultiple);
  const bust = seed * ratNumber(params.terminal.bustFraction);
  const floor = Number(params.terminal.stallFloorMicro) / MICRO;
  const parcel = Number(params.minParcelMicro) / MICRO;
  const buffer = ratNumber(params.cashBuffer);
  const hold = Math.max(1, Math.round(input.meanHoldSessions));
  const timeout = params.terminal.timeoutSessions;
  const stallSessions = params.terminal.stallSessions;
  const parcelWindow = params.terminal.stallParcelRejections;

  const ends = { target: 0, bust: 0, stalled: 0, timeout: 0 };
  let navSum = 0;
  let navSq = 0;
  let sessionSum = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    let nav = seed; // cash when flat
    let value = 0; // position value when held
    let held = 0;
    let pending = 0; // value of an entry decided at the last close, filling at this open
    let floorStreak = 0;
    let quiet = 0; // sessions with no position and no accepted order
    let rejects = 0; // parcel rejections inside the quiet run
    let spare: number | null = null;
    let end: "target" | "bust" | "stalled" | "timeout" | null = null;
    let liq = seed;
    let s = 1;
    for (; s <= timeout && end === null; s += 1) {
      if (pending > 0) {
        value = pending * (1 - slip);
        nav -= pending + fee(pending, "buy");
        // nav now holds the cash left after buying; the position is carried in `value`
        pending = 0;
        held = 0;
      }
      if (value > 0) {
        let z: number;
        if (spare !== null) {
          z = spare;
          spare = null;
        } else {
          const pair = normals(uniform01(rng), uniform01(rng));
          z = pair[0];
          spare = pair[1];
        }
        value *= Math.max(0, 1 + input.dailyVol * z);
        held += 1;
        if (held >= hold || value <= 0) {
          nav += value * (1 - slip) - (value > 0 ? fee(value, "sell") : 0);
          value = 0;
          held = 0;
        }
      }
      liq = value > 0 ? nav + value * (1 - slip) - fee(value, "sell") : nav;
      const flat = value <= 0;
      floorStreak = flat && liq < floor ? floorStreak + 1 : 0;
      if (liq >= target) end = "target";
      else if (liq <= bust) end = "bust";
      else if (floorStreak >= stallSessions) end = "stalled";
      else if (quiet >= parcelWindow && rejects >= 1) end = "stalled";
      else if (s >= timeout) end = "timeout";
      if (end !== null) break;
      if (flat) {
        quiet += 1;
        if (uniform01(rng) < input.entryRate) {
          const pre = nav - nav * buffer;
          const deployable = pre - fee(pre > 0 ? pre : 0, "buy");
          const ok = deployable / (1 + slip) >= parcel;
          if (ok) {
            pending = deployable / (1 + slip);
            quiet = 0;
            rejects = 0;
          } else {
            rejects += 1;
          }
        }
      } else {
        quiet = 0;
        rejects = 0;
      }
    }
    const kind = end ?? "timeout";
    ends[kind] += 1;
    const delta = (liq - seed) * MICRO;
    navSum += delta;
    navSq += delta * delta;
    sessionSum += Math.min(s, timeout);
  }
  const probability = {
    target: ends.target / trials,
    bust: ends.bust / trials,
    stalled: ends.stalled / trials,
    timeout: ends.timeout / trials,
  };
  const se = (p: number): number => Math.sqrt((p * (1 - p)) / trials);
  const meanNav = navSum / trials;
  const variance =
    trials > 1 ? Math.max(0, (navSq - trials * meanNav * meanNav) / (trials - 1)) : 0;
  return {
    family: input.family,
    ruleVersion: input.ruleVersion,
    scope,
    trials,
    seed: input.seed,
    inputs: {
      dailyVol: input.dailyVol,
      entryRate: input.entryRate,
      meanHoldSessions: input.meanHoldSessions,
      slippageBps: input.slippageBps,
    },
    probability,
    mcSe: {
      target: se(probability.target),
      bust: se(probability.bust),
      stalled: se(probability.stalled),
      timeout: se(probability.timeout),
    },
    meanNavMinusSeedMicro: meanNav,
    navMcSeMicro: Math.sqrt(variance / trials),
    meanSessions: sessionSum / trials,
  };
}
