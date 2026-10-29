// Fill model (spec 05 ARN-020, ARN-021, ARN-024a, ARN-026, ARN-030, ARN-032; M3 design 4.3 and
// 4.6; D-069/D-070/D-071). Pure functions: one raw bar in, one typed fill out.
//   entry and CS exit : fill at the session open, +/- slippage (rules `open` / `close_signal`)
//   IS exit           : open <= level -> open - slippage (`gap_open`);
//                       else low <= level -> level - slippage - 1 tick (`level`)
//   initial stop      : fill price - stop distance (set from the ACTUAL entry fill, ARN-021)
// Slippage and every tick rounding come from slippage.ts / money/tick.ts (adverse to the trader).
// The U1 quality gate blocks ENTRIES only (DAT-210): checked at creation and again here at fill;
// exits are never blocked by it. A halted code gets no fill (ARN-026).
import { type Micro } from "@/lib/money/micro";
import { MIN_PRICE_MICRO, tickFor, type Side } from "@/lib/money/tick";
import type { EntryDecision } from "@/lib/data/quality/gate";
import { feeFor, type CostProfile, type FeeContext } from "./costs";
import type { FillRule } from "./schema";
import {
  DEFAULT_TICK_CROSS_FACTOR,
  SLIPPAGE_BUCKETS,
  slippageFill,
  type SlippageBucket,
} from "./slippage";
import type { Rational } from "@/lib/money/rational";

/** A raw (unadjusted) session bar, micro-AUD per share. */
export type Bar = {
  readonly openMicro: Micro;
  readonly highMicro: Micro;
  readonly lowMicro: Micro;
  readonly closeMicro: Micro;
};

export function assertBar(bar: Bar): void {
  const { openMicro: o, highMicro: h, lowMicro: l, closeMicro: c } = bar;
  const positive = o > 0n && h > 0n && l > 0n && c > 0n;
  const ordered = l <= o && l <= c && h >= o && h >= c;
  if (!positive || !ordered)
    throw new RangeError("invalid bar: prices must be positive, low <= open/close <= high");
}

/** A simulated execution, shaped for the `fill` table (schema.ts FillRow, minus ids and dates). */
export type SimulatedFill = {
  readonly rule: FillRule;
  readonly side: Side;
  readonly qty: bigint;
  readonly refPriceMicro: Micro;
  /** |fill - reference| per share, including the extra tick of an in-range stop fill. */
  readonly slipMicro: Micro;
  readonly fillPriceMicro: Micro;
  readonly valueMicro: Micro;
  readonly brokerageMicro: Micro;
  readonly costProfile: string;
  readonly bar: Bar;
};

export type FillEnv = {
  readonly bar: Bar;
  /** 20-session ADV as traded value, micro-AUD (slippage bucket). */
  readonly advMicro: Micro;
  readonly profile: CostProfile;
  readonly feeContext?: FeeContext;
  readonly tickCrossFactor?: Rational;
  readonly buckets?: readonly SlippageBucket[];
};

function slipOf(env: FillEnv, ref: Micro, side: Side): Micro {
  return slippageFill(
    ref,
    side,
    env.advMicro,
    env.tickCrossFactor ?? DEFAULT_TICK_CROSS_FACTOR,
    env.buckets ?? SLIPPAGE_BUCKETS,
  ).fillMicro;
}

function build(
  env: FillEnv,
  rule: FillRule,
  side: Side,
  qty: bigint,
  ref: Micro,
  fillPrice: Micro,
): SimulatedFill {
  if (qty <= 0n) throw new RangeError("fill quantity must be a positive whole number of shares");
  if (fillPrice <= 0n) throw new RangeError("slippage consumes the whole price");
  const diff = fillPrice - ref;
  const value = qty * fillPrice;
  return {
    rule,
    side,
    qty,
    refPriceMicro: ref,
    slipMicro: diff < 0n ? -diff : diff,
    fillPriceMicro: fillPrice,
    valueMicro: value,
    brokerageMicro: feeFor(env.profile, value, side, env.feeContext),
    costProfile: env.profile.code,
    bar: env.bar,
  };
}

/** Entry (buy) at the session open: open + slippage, rounded up onto the tick grid. */
export function fillEntryAtOpen(env: FillEnv, qty: bigint): SimulatedFill {
  assertBar(env.bar);
  return build(env, "open", "buy", qty, env.bar.openMicro, slipOf(env, env.bar.openMicro, "buy"));
}

/** CS exit (sell): evaluated at the close, filled at the next open - slippage (ARN-021). */
export function fillCloseSignalExit(env: FillEnv, qty: bigint): SimulatedFill {
  assertBar(env.bar);
  return build(
    env,
    "close_signal",
    "sell",
    qty,
    env.bar.openMicro,
    slipOf(env, env.bar.openMicro, "sell"),
  );
}

/**
 * IS exit (sell). Returns null when the stop is not reached this session.
 *   open <= level            -> fill at open - slippage (rule gap_open)
 *   else low <= level        -> fill at level - slippage - 1 tick (rule level)
 * `afterOpen` is for a stop that becomes active only after the open (the initial stop in the
 * entry session, ARN-021): the open cannot gap through it, so only the low test applies.
 * `exDividendMicro` (FAM-007, D-219; M14 WP2) is the cash dividend per share going ex on this session.
 * Only on that session, the trigger tests use open + dividend and low + dividend against the level (the
 * share is worth the dividend less after the ex-date open); the raw level is not re-based and stays in
 * force unchanged from the next session. A gap fill stays at open - slippage. A level fill is at
 * (level - dividend) - slippage - 1 tick, floored as in D-184. Absent or 0n = v1 behaviour.
 */
export function fillIntradayStop(
  env: FillEnv,
  qty: bigint,
  levelMicro: Micro,
  options: { readonly afterOpen?: boolean; readonly exDividendMicro?: Micro } = {},
): SimulatedFill | null {
  assertBar(env.bar);
  if (levelMicro <= 0n) throw new RangeError("stop level must be positive");
  const { openMicro, lowMicro } = env.bar;
  const div = options.exDividendMicro ?? 0n;
  if (div < 0n) throw new RangeError("ex-date dividend must not be negative");
  if (options.afterOpen !== true && openMicro + div <= levelMicro) {
    return build(env, "gap_open", "sell", qty, openMicro, slipOf(env, openMicro, "sell"));
  }
  if (lowMicro + div <= levelMicro) {
    // FAM-007: the level in the ex-date price terms; 0n dividend = the raw level (v1)
    const eff = levelMicro - div; // >= the low, so positive
    // D-184: never below the lowest price on the grid (a A$0.001-0.002 stop would go to zero)
    const below = slipOf(env, eff, "sell") - tickFor(eff);
    const fill = below < MIN_PRICE_MICRO ? MIN_PRICE_MICRO : below;
    return build(env, "level", "sell", qty, eff, fill);
  }
  return null;
}

/**
 * Initial stop from the ACTUAL entry fill (ARN-021): fill price - stop distance. Never from the
 * open or the signal price. The stop must stay above zero.
 */
export function initialStopFromFill(fillPriceMicro: Micro, stopDistanceMicro: Micro): Micro {
  if (stopDistanceMicro <= 0n) throw new RangeError("stop distance must be positive");
  const stop = fillPriceMicro - stopDistanceMicro;
  if (stop <= 0n) throw new RangeError("stop distance leaves a non-positive stop level");
  return stop;
}

/**
 * Which exit stands when a CS and an IS exit both apply to one position (ARN-021, D-071 ruling on
 * TST101-034). The CS exit fills at the open, so it is earlier than any intraday stop and wins
 * over a `level` IS fill. A `gap_open` IS fill is also at the open: the order is ambiguous, so the
 * worse (lower) fill is taken; equal prices keep the IS fill.
 */
export function selectExit(
  cs: SimulatedFill | null,
  is: SimulatedFill | null,
): SimulatedFill | null {
  if (cs === null) return is;
  if (is === null) return cs;
  if (is.rule === "level") return cs;
  return cs.fillPriceMicro < is.fillPriceMicro ? cs : is;
}

// ---- quality gate and halts -----------------------------------------------------------------

export type GatePhase = "creation" | "fill";
export type GateRefusal = {
  /** At creation the buy is rejected; at fill a pending buy is cancelled (design 4.6). */
  readonly status: "rejected" | "cancelled";
  readonly reason: "gate";
  /** The gate's own reason (no_quality_score, u1_gate_failed, code_blocked). */
  readonly detail: string;
};

/** DAT-210 for ENTRIES only: null when allowed, else the refusal. A missing decision is a block. */
export function gateRefusal(
  decision: EntryDecision | undefined,
  phase: GatePhase,
): GateRefusal | null {
  if (decision !== undefined && decision.allowed) return null;
  return {
    status: phase === "creation" ? "rejected" : "cancelled",
    reason: "gate",
    detail: decision === undefined ? "no_gate_decision" : decision.reason,
  };
}

export type OrderToFill =
  | {
      readonly kind: "entry";
      readonly qty: bigint;
      /** M3 orders: the initial stop is the fill price minus this distance. */
      readonly stopDistanceMicro?: bigint;
      /** M4 orders: the initial stop computed from the ACTUAL fill (the order plan, ARN-021). */
      readonly stopFrom?: (fillPriceMicro: bigint) => bigint;
    }
  | { readonly kind: "exit_cs"; readonly qty: bigint }
  | { readonly kind: "exit_is"; readonly qty: bigint; readonly levelMicro: bigint };

export type FillOrderEnv = FillEnv & {
  /** Universe snapshot / suspension flag: no fills on a halted code (ARN-026). */
  readonly halted?: boolean;
  /** Gate decision for the code, consulted for entries only. */
  readonly gate?: EntryDecision;
};

export type FillOutcome =
  | {
      readonly status: "filled";
      readonly fill: SimulatedFill;
      readonly initialStopMicro: bigint | null;
    }
  | { readonly status: "cancelled"; readonly reason: "gate" | "halted"; readonly detail: string }
  | { readonly status: "unfilled"; readonly reason: "halted" | "stop_not_reached" };

/**
 * Fill one pending order against its session bar.
 *  - entry: gate re-checked at fill, then halt check, then fill at the open; the outcome carries
 *    the initial stop computed from the actual fill;
 *  - exit_cs / exit_is: the gate is never consulted (exits always process); a halted code stays
 *    unfilled (retried next session); an IS stop not reached stays unfilled.
 */
export function fillOrder(order: OrderToFill, env: FillOrderEnv): FillOutcome {
  if (order.kind === "entry") {
    const refusal = gateRefusal(env.gate, "fill");
    if (refusal !== null) return { status: "cancelled", reason: "gate", detail: refusal.detail };
    if (env.halted === true) return { status: "cancelled", reason: "halted", detail: "halted" };
    const fill = fillEntryAtOpen(env, order.qty);
    if (order.stopFrom !== undefined) {
      const stop = order.stopFrom(fill.fillPriceMicro);
      if (stop <= 0n) throw new RangeError("initial stop must be positive");
      return { status: "filled", fill, initialStopMicro: stop };
    }
    if (order.stopDistanceMicro === undefined) {
      throw new RangeError("an entry order needs a stop distance or a stop rule");
    }
    return {
      status: "filled",
      fill,
      initialStopMicro: initialStopFromFill(fill.fillPriceMicro, order.stopDistanceMicro),
    };
  }
  if (env.halted === true) return { status: "unfilled", reason: "halted" };
  if (order.kind === "exit_cs") {
    return { status: "filled", fill: fillCloseSignalExit(env, order.qty), initialStopMicro: null };
  }
  const fill = fillIntradayStop(env, order.qty, order.levelMicro);
  return fill === null
    ? { status: "unfilled", reason: "stop_not_reached" }
    : { status: "filled", fill, initialStopMicro: null };
}
