// Initial stop specs, exit plans and exit evaluation (M4 T7; spec 7.4 exits; design 2.6, decisions
// 17 and 18). A plan is plain data stored with the signal; `evaluateExit` is the pure function the
// 2b batch runs for every open trade at each close (CS exits for D+1, IS levels for stop_level).
// Exits are never blocked by a gate, a source being off or the regime (DAT-127): this module takes
// no regime and no source state at all. Price comparisons are exact (bigint micro, Rational).
import {
  addRat,
  cmpRat,
  divCeil,
  divFloor,
  makeRational,
  mulRat,
  ratFromInt,
  type Rational,
} from "@/lib/money/rational";
import type { AgentParams } from "../params";
import { roundHalfAway } from "../regime";
import type { Family } from "../schema";
import type {
  CsRule,
  CsTrigger,
  ExitEvaluation,
  ExitPlan,
  InitialStopRule,
  PositionState,
  SpecConstants,
  StopSpec,
  TrailRule,
} from "./types";

// ---- initial stop (computed from the actual fill, ARN-021) ----

/**
 * stop = max(fill - round_half_away(k * atr_micro), floor(fill * (1 - cap)), level_micro, 0), each
 * term only when present. Exact; no tick snap (D-076 precedent).
 */
export function initialStop(spec: StopSpec, fillMicro: bigint): bigint {
  let stop = 0n;
  if (spec.k !== null) {
    if (spec.atr_micro === null) throw new RangeError("stop spec has k but no atr_micro");
    const atrPart = fillMicro - roundHalfAway(mulRat(spec.k, ratFromInt(spec.atr_micro)));
    if (atrPart > stop) stop = atrPart;
  }
  if (spec.cap !== null) {
    const capPart = divFloor(fillMicro * (spec.cap.den - spec.cap.num), spec.cap.den);
    if (capPart > stop) stop = capPart;
  }
  if (spec.level_micro !== null && spec.level_micro > stop) stop = spec.level_micro;
  return stop;
}

/** F3: the order is cancelled at fill when the next open is at or above this raw micro price. */
export function gapCancelLevel(day0CloseMicro: bigint, maxGap: Rational): bigint {
  // open >= close0 * (1 + g)  <=>  open >= ceil(close0 * (1 + g)), exact for integer opens.
  return divCeil(day0CloseMicro * (maxGap.den + maxGap.num), maxGap.den);
}

export function gapCancelsAtFill(openMicro: bigint, maxOpenMicro: bigint): boolean {
  return openMicro >= maxOpenMicro;
}

// ---- plans ----

const initialRule = (spec: StopSpec): InitialStopRule => ({ id: "initial", via: null, spec });

export function f1Plan(p: AgentParams, atrMicro: bigint | null): ExitPlan {
  return {
    initialStops: [
      initialRule({ atr_micro: atrMicro, k: p.f1.initialStopAtr, cap: null, level_micro: null }),
    ],
    trails: [{ id: "trail", via: null, k: p.f1.trailAtr, activateGain: null }],
    cs: [
      {
        id: "time_stop",
        via: null,
        kind: "time_stop",
        sessions: p.f1.timeStop,
        minReturn: p.f1.minGain,
      },
      { id: "max_hold", via: null, kind: "time_stop", sessions: p.f1.maxHold, minReturn: null },
    ],
  };
}

export function f2Plan(p: AgentParams, atrMicro: bigint | null, eventLow: bigint | null): ExitPlan {
  const cs: CsRule[] = [
    { id: "guidance_down", via: null, kind: "negative_event", categories: ["guidance_down"] },
  ];
  if (eventLow !== null) {
    cs.push({ id: "below_event_low", via: null, kind: "close_below_level", levelMicro: eventLow });
  }
  cs.push({
    id: "time_stop",
    via: null,
    kind: "time_stop",
    sessions: p.f2.timeStop,
    minReturn: null,
  });
  return {
    initialStops: [
      initialRule({ atr_micro: atrMicro, k: p.f2.stopAtr, cap: null, level_micro: null }),
    ],
    trails: [],
    cs,
  };
}

export function f3Plan(p: AgentParams, atrMicro: bigint | null, day0Low: bigint): ExitPlan {
  return {
    initialStops: [initialRule({ atr_micro: atrMicro, k: null, cap: null, level_micro: day0Low })],
    trails: [{ id: "trail", via: null, k: p.f3.trailAtr, activateGain: p.f3.trailAfter }],
    cs: [
      {
        id: "time_stop",
        via: null,
        kind: "time_stop",
        sessions: p.f3.timeExit,
        minReturn: null,
      },
    ],
  };
}

export function f4Plan(p: AgentParams, atrMicro: bigint | null): ExitPlan {
  return {
    initialStops: [
      initialRule({ atr_micro: atrMicro, k: p.f4.stopAtr, cap: null, level_micro: null }),
    ],
    trails: [],
    cs: [
      { id: "close_above_sma", via: null, kind: "close_above_sma", period: p.windows.smaExit },
      {
        id: "time_stop",
        via: null,
        kind: "time_stop",
        sessions: p.f4.timeExit,
        minReturn: null,
      },
    ],
  };
}

export function f5Plan(p: AgentParams, atrMicro: bigint | null, c: SpecConstants): ExitPlan {
  return {
    initialStops: [
      initialRule({
        atr_micro: atrMicro,
        k: p.f5.stopAtr,
        cap: p.f5.stopCap,
        level_micro: null,
      }),
    ],
    trails: [{ id: "trail", via: null, k: p.f5.trailAtr, activateGain: null }],
    cs: [
      {
        id: "volume_dry_up",
        via: null,
        kind: "volume_dry_up",
        ratioBelow: c.f5DryUpRatio,
        sessions: c.f5DryUpSessions,
      },
      { id: "negative_event", via: null, kind: "negative_event", categories: null },
      {
        id: "time_stop",
        via: null,
        kind: "time_stop",
        sessions: p.f5.timeStop,
        minReturn: null,
      },
    ],
  };
}

/**
 * F6: its own IS 2 x ATR and CS 20 sessions, plus the earliest exit of every contributing (a)/(b)
 * family: their rules are appended with the family as `via` and a family-prefixed id.
 */
export function f6Plan(
  p: AgentParams,
  atrMicro: bigint | null,
  contributors: readonly { readonly family: Family; readonly plan: ExitPlan }[],
): ExitPlan {
  const own: ExitPlan = {
    initialStops: [
      initialRule({ atr_micro: atrMicro, k: p.f6.stopAtr, cap: null, level_micro: null }),
    ],
    trails: [],
    cs: [
      {
        id: "time_stop",
        via: null,
        kind: "time_stop",
        sessions: p.f6.timeStop,
        minReturn: null,
      },
    ],
  };
  const sorted = [...contributors].sort((a, b) => (a.family < b.family ? -1 : 1));
  return {
    initialStops: [
      ...own.initialStops,
      ...sorted.flatMap((c) =>
        c.plan.initialStops.map((r) => ({ ...r, id: `${c.family}:${r.id}`, via: c.family })),
      ),
    ],
    trails: [
      ...own.trails,
      ...sorted.flatMap((c) =>
        c.plan.trails.map((r) => ({ ...r, id: `${c.family}:${r.id}`, via: c.family })),
      ),
    ],
    cs: [
      ...own.cs,
      ...sorted.flatMap((c) =>
        c.plan.cs.map((r) => ({ ...r, id: `${c.family}:${r.id}`, via: c.family }) as CsRule),
      ),
    ],
  };
}

// ---- evaluation ----

const ratText = (r: Rational): string => `${r.num}/${r.den}`;

function fire(rule: CsRule, detail: string): CsTrigger {
  return { rule: rule.id, via: rule.via, detail };
}

function evalCs(rule: CsRule, pos: PositionState): CsTrigger | null {
  switch (rule.kind) {
    case "time_stop": {
      if (pos.sessionsHeld < rule.sessions) return null;
      if (rule.minReturn === null) return fire(rule, `held ${pos.sessionsHeld}`);
      if (pos.fillMicro <= 0n) return null;
      const ret = makeRational(pos.closeMicro - pos.fillMicro, pos.fillMicro);
      return cmpRat(ret, rule.minReturn) < 0
        ? fire(rule, `held ${pos.sessionsHeld}, return ${ratText(ret)}`)
        : null;
    }
    case "close_above_sma":
      return pos.closeAboveExitSma === true ? fire(rule, `close above SMA(${rule.period})`) : null;
    case "negative_event": {
      const hit = pos.events.find(
        (e) =>
          e.polarity === -1 &&
          e.day0 >= pos.fillDay &&
          (rule.categories === null || rule.categories.includes(e.category)),
      );
      return hit === undefined ? null : fire(rule, `${hit.category} ${hit.day0}`);
    }
    case "close_below_level":
      return pos.closeMicro < rule.levelMicro
        ? fire(rule, `close ${pos.closeMicro} < ${rule.levelMicro}`)
        : null;
    case "volume_dry_up": {
      const tail = pos.volumeRatios.slice(-rule.sessions);
      if (rule.sessions < 1 || tail.length < rule.sessions) return null;
      const dry = tail.every((r) => r !== null && cmpRat(r, rule.ratioBelow) < 0);
      return dry ? fire(rule, `volume ratio below ${ratText(rule.ratioBelow)}`) : null;
    }
  }
}

function trailLevel(rule: TrailRule, pos: PositionState): bigint | null {
  if (pos.atrMicro === null) return null;
  if (rule.activateGain !== null) {
    const trigger = mulRat(ratFromInt(pos.fillMicro), addRat(ratFromInt(1n), rule.activateGain));
    if (cmpRat(ratFromInt(pos.highestCloseMicro), trigger) < 0) return null;
  }
  return pos.highestCloseMicro - roundHalfAway(mulRat(rule.k, ratFromInt(pos.atrMicro)));
}

/**
 * One open trade at the close of D: the CS rules that fire (the first in plan order is the exit to
 * create for D+1) and the IS trailing levels to append to stop_level. Pure; the same function for
 * live and replay; independent of regime and source state, so exits always continue.
 */
export function evaluateExit(pos: PositionState): ExitEvaluation {
  const triggered: CsTrigger[] = [];
  for (const rule of pos.plan.cs) {
    const t = evalCs(rule, pos);
    if (t !== null) triggered.push(t);
  }
  const isLevels: { rule: string; levelMicro: bigint }[] = [];
  for (const rule of pos.plan.trails) {
    const level = trailLevel(rule, pos);
    if (level !== null) isLevels.push({ rule: rule.id, levelMicro: level });
  }
  return {
    tradeId: pos.tradeId,
    code: pos.code,
    cs: triggered[0] ?? null,
    triggered,
    isLevels,
  };
}

/** All open trades, in trade-id order (deterministic). */
export function evaluatePositions(positions: readonly PositionState[]): ExitEvaluation[] {
  return [...positions]
    .sort((a, b) => (a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0))
    .map(evaluateExit);
}
