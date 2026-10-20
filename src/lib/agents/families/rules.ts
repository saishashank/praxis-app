// Family entry rules F1-F6 (M4 T7; spec 07 section 7.4; design 4.3). One pure function per family
// turns the facts of session D into candidates (entry rules held and no gate stopped them) and
// blocked records (entry rules held but a regime gate, a source gate, a halt or an ARN-011 filter
// stopped them; they get a card with the reason). Every threshold is read from AgentParams
// (or the injectable ARN-011 / spec constants); price-domain comparisons are exact.
import {
  cmpRat,
  makeRational,
  mulRat,
  ratFromInt,
  subRat,
  type Rational,
} from "@/lib/money/rational";
import type { Family } from "../schema";
import { applyArn011 } from "./arn011";
import {
  F2_CATEGORIES,
  F3_CATEGORIES,
  FAMILY_RULE_VERSION,
  NEEDS_ASX,
  REGIME_BLOCKS,
} from "./constants";
import {
  compareCandidates,
  floatRat,
  geq,
  rankText,
  ratOrNull,
  ratText,
  trace,
  type EvalContext,
  type EventGroupFact,
} from "./context";
import { f1Plan, f2Plan, f3Plan, f4Plan, f5Plan, f6Plan, gapCancelLevel } from "./exits";
import type {
  BlockedCandidate,
  Candidate,
  CodeFacts,
  ExitPlan,
  RuleTrace,
  StopSpec,
  Tier,
} from "./types";

export type Evaluated = { readonly cand: Candidate; readonly reasons: readonly string[] };

const ONE = ratFromInt(1n);
const QUARTER_UNITS = 4n; // threshold-ok: insider/flow score is stored in quarter units (0.25 = 1)
const EVIDENCE_CLASSES = 4; // threshold-ok: F6 has four evidence classes (a)-(d)

// ---- helpers ----

function inTiers(c: CodeFacts, tiers: readonly Tier[]): boolean {
  return tiers.includes(c.tier);
}

function stopSpecOf(plan: ExitPlan): StopSpec {
  return plan.initialStops[0]!.spec;
}

function atrUsable(c: CodeFacts): boolean {
  return c.ind.atrWarm && c.ind.atrMicro !== null;
}

/**
 * D-081: a Wilder RSI is usable only when it is warm, finite and the last (period + 1) closes are
 * not all equal. TA-Lib returns RSI = 0 for a flat series, which would pass "RSI < 10" with no
 * information behind it; a stale oversold reading on a series that has stopped moving is refused too.
 */
export function rsiUsable(
  value: number | null,
  warm: boolean,
  closes: readonly bigint[],
  period: number,
): value is number {
  if (value === null || !warm || !Number.isFinite(value)) return false;
  if (closes.length < period + 1) return false;
  const tail = closes.slice(-(period + 1));
  return tail.some((x) => x !== tail[0]);
}

function bestGroup(
  groups: readonly EventGroupFact[],
  accept: (g: EventGroupFact) => boolean,
  score: (g: EventGroupFact) => Rational,
): EventGroupFact | null {
  let best: EventGroupFact | null = null;
  let bestScore: Rational | null = null;
  for (const g of groups) {
    if (!accept(g)) continue;
    const s = score(g);
    if (
      best === null ||
      bestScore === null ||
      cmpRat(s, bestScore) > 0 ||
      (cmpRat(s, bestScore) === 0 && g.sessionsAgo < best.sessionsAgo)
    ) {
      best = g;
      bestScore = s;
    }
  }
  return best;
}

const hasNegative = (g: EventGroupFact): boolean => g.members.some((m) => m.polarity === -1);

function eventTrace(id: string, g: EventGroupFact | null, window: string): RuleTrace {
  return trace(id, g !== null, g === null ? "none" : `${g.key} ar=${ratOrNull(g.ar)}`, window);
}

/** Gate reasons common to every family (regime, ASX source, halt, ARN-011 for U2/U3). */
function gateReasons(
  family: Family,
  c: CodeFacts,
  ctx: EvalContext,
): { reasons: string[]; flags: string[] } {
  const reasons = new Set<string>();
  const flags: string[] = [];
  const regime = ctx.inputs.regime;
  if (REGIME_BLOCKS[family].includes(regime)) reasons.add(`regime_${regime}`);
  if (NEEDS_ASX.has(family) && ctx.inputs.sources.asx === "off") reasons.add("source_off:asx");
  if (!NEEDS_ASX.has(family) && ctx.inputs.sources.asx === "off") flags.push("halt-proxy");
  if (c.halted) reasons.add("halted");
  if (c.tier !== "U1") {
    const r = applyArn011(c, ctx);
    for (const f of r.failed) reasons.add(`arn011:${f}`);
    flags.push(...r.flags);
  }
  return { reasons: [...reasons].sort(), flags };
}

type Build = {
  family: Family;
  variant: string;
  c: CodeFacts;
  ctx: EvalContext;
  rank: readonly (Rational | null)[];
  plan: ExitPlan;
  rules: readonly RuleTrace[];
  groupKey?: string | null;
  classes?: readonly string[] | null;
  contributors?: readonly Family[];
  maxOpenMicro?: bigint | null;
  halfSize?: boolean;
  flags?: readonly string[];
};

function build(b: Build): Evaluated {
  const gate = gateReasons(b.family, b.c, b.ctx);
  const flags = [...gate.flags, ...(b.flags ?? [])].sort();
  const cand: Candidate = {
    d: b.ctx.inputs.d,
    family: b.family,
    variant: b.variant,
    ruleVersion: b.ctx.ruleVersions[b.family] ?? FAMILY_RULE_VERSION[b.family],
    code: b.c.code,
    tier: b.c.tier,
    regime: b.ctx.inputs.regime,
    halfSize: b.halfSize === true,
    rank: b.rank,
    rankText: rankText(b.rank),
    adv: b.c.ind.adv,
    groupKey: b.groupKey ?? null,
    classes: b.classes ?? null,
    contributors: b.contributors ?? [],
    maxOpenMicro: b.maxOpenMicro ?? null,
    stopSpec: stopSpecOf(b.plan),
    plan: b.plan,
    rules: b.rules,
    flags,
  };
  return { cand, reasons: gate.reasons };
}

const allPass = (rules: readonly RuleTrace[]): boolean => rules.every((r) => r.pass);

// ---- F1 trend / breakout ----

export function evaluateF1(ctx: EvalContext): Evaluated[] {
  const p = ctx.p;
  const variant = ctx.restrictToU1 ? "F1-U1" : "F1";
  const tiers: Tier[] = ctx.u2OptInF1 && !ctx.restrictToU1 ? ["U1", "U2"] : ["U1"];
  const topCut = subRat(ONE, p.f1.rsTopFraction);
  const out: Evaluated[] = [];
  for (const c of ctx.codes) {
    if (!inTiers(c, tiers)) continue;
    const pct = ctx.returnPercentile.get(c.code) ?? null;
    const rules: RuleTrace[] = [
      trace("atr_warm", atrUsable(c), String(c.ind.atrMicro), "ATR warm"),
      trace(
        "high_lookback",
        c.ind.isHigh === true,
        String(c.ind.isHigh),
        `${p.f1.highLookback}-session high`,
      ),
      trace(
        "volume_ratio",
        geq(c.ind.volumeRatio, p.f1.volumeRatioMin),
        ratOrNull(c.ind.volumeRatio),
        `>= ${ratText(p.f1.volumeRatioMin)}`,
      ),
      trace(
        "rs_top_fraction",
        pct !== null && cmpRat(pct, topCut) >= 0,
        ratOrNull(pct),
        `>= ${ratText(topCut)}`,
      ),
    ];
    if (!allPass(rules)) continue;
    out.push(
      build({
        family: "F1",
        variant,
        c,
        ctx,
        rank: [pct],
        plan: f1Plan(p, c.ind.atrMicro),
        rules,
      }),
    );
  }
  return out;
}

// ---- F2 quality-value with catalyst (fundamentals BLOCKED-DATA, decision 15) ----

export function evaluateF2(ctx: EvalContext): Evaluated[] {
  const p = ctx.p;
  const variant = ctx.restrictToU1 ? "F2-no-fundamentals-U1" : "F2-no-fundamentals";
  const tiers: Tier[] = ctx.restrictToU1 ? ["U1"] : ["U1", "U2"];
  const out: Evaluated[] = [];
  for (const c of ctx.codes) {
    if (!inTiers(c, tiers)) continue;
    const groups = ctx.groupsByCode.get(c.code) ?? [];
    const g = bestGroup(
      groups,
      (x) =>
        x.sessionsAgo < p.f2.lookbackSessions &&
        x.members.some((m) => m.polarity === 1 && F2_CATEGORIES.some((k) => k === m.category)) &&
        !hasNegative(x) &&
        geq(x.ar, p.f2.eventArMin),
      (x) => x.ar ?? ratFromInt(0n),
    );
    const rules: RuleTrace[] = [
      trace("atr_warm", atrUsable(c), String(c.ind.atrMicro), "ATR warm"),
      eventTrace(
        "event_results_or_guidance_up",
        g,
        `AR >= ${ratText(p.f2.eventArMin)}, day 0 in last ${p.f2.lookbackSessions} sessions`,
      ),
    ];
    if (g === null || !allPass(rules)) continue;
    const flags = g.members.some((m) => !m.timed) ? ["assumed-time"] : [];
    out.push(
      build({
        family: "F2",
        variant,
        c,
        ctx,
        rank: [g.ar],
        plan: f2Plan(p, c.ind.atrMicro, g.day0LowMicro),
        rules,
        groupKey: g.key,
        flags: g.day0LowMicro === null ? [...flags, "event-low-unavailable"] : flags,
      }),
    );
  }
  return out;
}

// ---- F3 event drift ----

export function evaluateF3(ctx: EvalContext): Evaluated[] {
  const p = ctx.p;
  const variant = ctx.restrictToU1 ? "F3-U1" : "F3";
  const tiers: Tier[] = ctx.restrictToU1 ? ["U1"] : ["U1", "U2"];
  const out: Evaluated[] = [];
  for (const c of ctx.codes) {
    if (!inTiers(c, tiers)) continue;
    const groups = ctx.groupsByCode.get(c.code) ?? [];
    const g = bestGroup(
      groups,
      (x) =>
        x.sessionsAgo < 1 &&
        x.members.some(
          (m) =>
            m.priceSensitive && m.polarity === 1 && F3_CATEGORIES.some((k) => k === m.category),
        ) &&
        !hasNegative(x) &&
        geq(x.ar, p.f3.eventArMin) &&
        geq(x.volRatio, p.f3.volumeRatioMin),
      (x) => mulRat(x.ar ?? ratFromInt(0n), x.volRatio ?? ratFromInt(0n)),
    );
    const rules: RuleTrace[] = [
      eventTrace(
        "event_price_sensitive_positive",
        g,
        `AR >= ${ratText(p.f3.eventArMin)}, day 0 = D`,
      ),
      trace(
        "day0_volume_ratio",
        g !== null && geq(g.volRatio, p.f3.volumeRatioMin),
        g === null ? "none" : ratOrNull(g.volRatio),
        `>= ${ratText(p.f3.volumeRatioMin)}`,
      ),
    ];
    if (g === null || !allPass(rules)) continue;
    const score = mulRat(g.ar ?? ratFromInt(0n), g.volRatio ?? ratFromInt(0n));
    const flags = g.members.some((m) => !m.timed) ? ["assumed-time"] : [];
    out.push(
      build({
        family: "F3",
        variant,
        c,
        ctx,
        rank: [score],
        // day 0 is D: the day-0 low and close are D's raw bar
        plan: f3Plan(p, c.ind.atrMicro, c.bar.low),
        rules,
        groupKey: g.key,
        maxOpenMicro: gapCancelLevel(c.bar.close, p.f3.maxGap),
        flags,
      }),
    );
  }
  return out;
}

// ---- F4 mean reversion / validated patterns ----

export function evaluateF4(ctx: EvalContext): Evaluated[] {
  const p = ctx.p;
  const covered = ctx.inputs.eventCoverage && ctx.inputs.sources.asx === "on";
  const variant = covered ? "F4" : "F4-no-event-filter";
  const passed = ctx.inputs.passedPatterns ?? new Set();
  const out: Evaluated[] = [];
  for (const c of ctx.codes) {
    if (c.tier !== "U1") continue;
    const ind = c.ind;
    const rsi2Ok = rsiUsable(ind.rsiShort, ind.rsiShortWarm, c.closesAdj, p.windows.rsiShort);
    const rsi14Ok = rsiUsable(ind.rsiLong, ind.rsiLongWarm, c.closesAdj, p.windows.rsiLong);
    const rsi2 = rsi2Ok ? ind.rsiShort! : null;
    const rsi14 = rsi14Ok ? ind.rsiLong! : null;
    const patternHit = [...passed].sort().some((name) => c.patterns?.[name] === true);
    const oversold =
      (rsi2 !== null && rsi2 < p.f4.rsi2Max) ||
      (rsi14 !== null && rsi14 < p.f4.rsi14Max) ||
      patternHit;
    const groups = ctx.groupsByCode.get(c.code) ?? [];
    const negEvent = groups.some((g) => g.sessionsAgo < p.windows.f4EventWindow && hasNegative(g));
    const rules: RuleTrace[] = [
      trace("atr_warm", atrUsable(c), String(ind.atrMicro), "ATR warm"),
      trace(
        "close_above_sma_trend",
        ind.closeAboveSmaLong === true,
        String(ind.closeAboveSmaLong),
        `close > SMA(${p.windows.smaTrend})`,
      ),
      trace(
        "oversold",
        oversold,
        `rsi2=${rsi2 === null ? "unusable" : rsi2} rsi14=${rsi14 === null ? "unusable" : rsi14} pattern=${patternHit}`,
        `RSI(${p.windows.rsiShort}) < ${p.f4.rsi2Max} or RSI(${p.windows.rsiLong}) < ${p.f4.rsi14Max}`,
      ),
      trace(
        "no_negative_event",
        ctx.f4EventFilterOff === true || !covered || !negEvent,
        covered ? String(negEvent) : "not applicable: no event coverage",
        `no - polarity event in last ${p.windows.f4EventWindow} sessions`,
      ),
    ];
    if (!allPass(rules)) continue;
    out.push(
      build({
        family: "F4",
        variant,
        c,
        ctx,
        rank: [rsi2 === null ? null : floatRat(-rsi2)],
        plan: f4Plan(p, ind.atrMicro),
        rules,
        halfSize: ctx.inputs.regime === "SHOCK",
      }),
    );
  }
  return out;
}

// ---- F5 small/mid-cap discovery ----

export function evaluateF5(ctx: EvalContext): Evaluated[] {
  const p = ctx.p;
  const out: Evaluated[] = [];
  for (const c of ctx.codes) {
    if (!inTiers(c, ["U2", "U3"])) continue;
    const groups = ctx.groupsByCode.get(c.code) ?? [];
    const g = bestGroup(
      groups,
      (x) =>
        x.sessionsAgo < 1 &&
        x.members.some((m) => m.priceSensitive && m.polarity === 1) &&
        !hasNegative(x) &&
        geq(x.ar, p.f5.arMin),
      (x) => x.ar ?? ratFromInt(0n),
    );
    const n = c.closesAdj.length;
    const upDay = n >= 2 && c.closesAdj[n - 1]! > c.closesAdj[n - 2]!;
    const rules: RuleTrace[] = [
      trace("atr_warm", atrUsable(c), String(c.ind.atrMicro), "ATR warm"),
      trace(
        "volume_ratio",
        geq(c.ind.volumeRatio, p.f5.volumeRatioMin),
        ratOrNull(c.ind.volumeRatio),
        `>= ${ratText(p.f5.volumeRatioMin)}`,
      ),
      eventTrace("event_price_sensitive_positive", g, `AR >= ${ratText(p.f5.arMin)}, day 0 = D`),
      trace(
        "close_above_prior_close",
        upDay,
        n >= 2 ? `${c.closesAdj[n - 1]} vs ${c.closesAdj[n - 2]}` : "no prior close",
        "close > prior close",
      ),
      trace(
        "range_position",
        cmpRat(c.ind.dayRangePosition, p.f5.rangePosMin) >= 0,
        ratText(c.ind.dayRangePosition),
        `>= ${ratText(p.f5.rangePosMin)}`,
      ),
    ];
    if (g === null || !allPass(rules)) continue;
    const flags = g.members.some((m) => !m.timed) ? ["assumed-time"] : [];
    out.push(
      build({
        family: "F5",
        variant: "F5",
        c,
        ctx,
        rank: [c.ind.volumeRatio],
        plan: f5Plan(p, c.ind.atrMicro, ctx.constants),
        rules,
        groupKey: g.key,
        flags,
      }),
    );
  }
  return out;
}

// ---- F6 multi-agent consensus ----

type Components = ReadonlyMap<string, readonly Candidate[]>;

/**
 * Component signals whose entry rules held, by code. Their gate reasons are a subset of F6's
 * (regime sets, ASX source, halt and ARN-011 apply to F6 at least as strictly), so counting a
 * gated component as evidence never creates an F6 entry; it only lets a blocked F6 be logged.
 */
export function componentsByCode(evaluated: readonly Evaluated[]): Components {
  const map = new Map<string, Candidate[]>();
  for (const e of evaluated) {
    const list = map.get(e.cand.code);
    if (list === undefined) map.set(e.cand.code, [e.cand]);
    else list.push(e.cand);
  }
  return map;
}

/**
 * F6 variants by data availability (decision 14): all four classes -> F6 needs min_classes; one
 * evidence class unavailable -> needs min_classes - 1 of the rest; both unavailable -> (a) and (b).
 * In every case at least one of (a)/(b) is needed.
 */
export function evaluateF6(ctx: EvalContext, comps: Components): Evaluated[] {
  const p = ctx.p;
  const out: Evaluated[] = [];
  for (const c of ctx.codes) {
    if (!inTiers(c, ["U1", "U2"])) continue;
    const own = comps.get(c.code) ?? [];
    const off = ctx.f6Disabled;
    const a = off.has("a") ? [] : own.filter((x) => x.family === "F1" || x.family === "F4");
    const b = off.has("b")
      ? []
      : own.filter((x) => x.family === "F2" || x.family === "F3" || x.family === "F5");
    const insiderAvail = c.insiderScoreQ !== null && !off.has("c");
    const shortAvail =
      ctx.inputs.sources.asic === "on" && c.shortDrop !== "unknown" && !off.has("d");
    const classC =
      insiderAvail &&
      cmpRat(makeRational(BigInt(c.insiderScoreQ!), QUARTER_UNITS), p.f6.insiderMin) >= 0;
    const classD = shortAvail && c.shortDrop === true;
    const classes = [
      ...(a.length > 0 ? ["a"] : []),
      ...(b.length > 0 ? ["b"] : []),
      ...(classC ? ["c"] : []),
      ...(classD ? ["d"] : []),
    ];
    const available =
      (off.has("a") ? 0 : 1) +
      (off.has("b") ? 0 : 1) +
      (insiderAvail ? 1 : 0) +
      (shortAvail ? 1 : 0);
    const missing = EVIDENCE_CLASSES - available;
    const required = missing === 0 ? p.f6.minClasses : Math.min(p.f6.minClasses - 1, available);
    const variant =
      off.size > 0
        ? `F6-loco-${[...off].sort().join("")}`
        : !insiderAvail && !shortAvail
          ? "F6-no-insider-no-short-interest"
          : !insiderAvail
            ? "F6-no-insider"
            : !shortAvail
              ? "F6-no-short-interest"
              : "F6";
    const rules: RuleTrace[] = [
      trace("atr_warm", atrUsable(c), String(c.ind.atrMicro), "ATR warm"),
      trace(
        "evidence_classes",
        classes.length >= required,
        classes.join(","),
        `>= ${required} of ${available}`,
      ),
      trace(
        "technical_or_event",
        a.length + b.length > 0,
        `a=${a.length} b=${b.length}`,
        "(a) or (b)",
      ),
    ];
    if (!allPass(rules)) continue;
    const contributors = [...new Set([...a, ...b].map((x) => x.family))].sort() as Family[];
    const plan = f6Plan(
      p,
      c.ind.atrMicro,
      [...a, ...b].map((x) => ({ family: x.family, plan: x.plan })),
    );
    out.push(
      build({
        family: "F6",
        variant,
        c,
        ctx,
        rank: [
          ratFromInt(BigInt(classes.length)),
          c.insiderScoreQ === null ? null : makeRational(BigInt(c.insiderScoreQ), QUARTER_UNITS),
        ],
        plan,
        rules,
        classes,
        contributors,
        flags: [
          ...(missing > 0 ? ["data-variant"] : []),
          ...b.flatMap((x) => (x.groupKey === null ? [] : [`event:${x.groupKey}`])),
        ],
      }),
    );
  }
  return out;
}

// ---- split and sort ----

export function splitEvaluated(list: readonly Evaluated[]): {
  candidates: Candidate[];
  blocked: BlockedCandidate[];
} {
  const candidates: Candidate[] = [];
  const blocked: BlockedCandidate[] = [];
  for (const e of list) {
    if (e.reasons.length === 0) candidates.push(e.cand);
    else blocked.push({ ...e.cand, reasons: e.reasons });
  }
  candidates.sort(compareCandidates);
  blocked.sort(compareCandidates);
  return { candidates, blocked };
}
