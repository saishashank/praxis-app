// Order plan: the exit plan and initial-stop recipe that travel with an entry order (M4 T8;
// docs/M4_design.md 2.6, 4.4; decisions 7 and 19). Batch 2b writes it as canonical JSON into the
// immutable `arena_order.stop_spec` column; batch 2a reads it at the fill (initial stop from the
// ACTUAL entry fill, ARN-021) and 2b reads it again every close to evaluate CS rules and recompute
// IS levels for the open trade. Everything is exact: bigint micro prices, Rational factors.
//
// `caThrough` is the decision date and `caApplied` the ids of the corporate actions (ex-date after
// it) that were already known and applied when the order was sized (design 4.4 step 4: 2b sizes on
// post-event terms). Orders without a plan (M3) are taken to be expressed as of their decision date
// with nothing applied. A split, consolidation or bonus issue with an ex-date after `caThrough`
// and on or before the fill session that was NOT applied (confirmed late) rescales the order at the
// fill; a disposal-type action cancels it (D-077 `order_qty_stale`).
import {
  cmpRat,
  makeRational,
  mulRat,
  parseRational,
  ratFromInt,
  type Rational,
} from "@/lib/money/rational";
import { quantityRatio, type CorpActionRecord } from "@/lib/arena/corpActions";
import { rebaseQty } from "@/lib/arena/ledger";
import { initialStop } from "./families/exits";
import type {
  CsRule,
  ExitPlan,
  Family,
  InitialStopRule,
  StopSpec,
  TrailRule,
} from "./families/types";
import { roundHalfAway } from "./regime";

export const ORDER_PLAN_VERSION = 1;

/** A control's relative CS level: close below (fill - round_half_away(k x atr)) (ARN-004 mapping). */
export type RelativeCs = {
  readonly id: string;
  readonly k: Rational;
  readonly atrMicro: bigint;
};

export type OrderPlan = {
  readonly family: Family;
  /** The family's data variant label of the signal (or of the matched signal for a control). */
  readonly variant: string;
  readonly ruleVersion: string;
  readonly caThrough: string;
  readonly caApplied: readonly string[];
  readonly plan: ExitPlan;
  readonly rel: readonly RelativeCs[];
};

// ---- text forms ---------------------------------------------------------------------------------

const ratText = (r: Rational): string => `${r.num}/${r.den}`;
const ratOf = (t: string): Rational => {
  const parts = t.split("/");
  return parts.length === 2 ? makeRational(BigInt(parts[0]!), BigInt(parts[1]!)) : parseRational(t);
};
const bigOrNull = (t: unknown): bigint | null => (t === null ? null : BigInt(String(t)));
const ratOrNull = (t: unknown): Rational | null => (t === null ? null : ratOf(String(t)));
const textOf = (v: bigint | null): string | null => (v === null ? null : v.toString());
const rText = (v: Rational | null): string | null => (v === null ? null : ratText(v));

function specJson(s: StopSpec): Record<string, unknown> {
  return {
    atr_micro: textOf(s.atr_micro),
    k: rText(s.k),
    cap: rText(s.cap),
    level_micro: textOf(s.level_micro),
  };
}

function specOf(o: Record<string, unknown>): StopSpec {
  return {
    atr_micro: bigOrNull(o.atr_micro),
    k: ratOrNull(o.k),
    cap: ratOrNull(o.cap),
    level_micro: bigOrNull(o.level_micro),
  };
}

function csJson(r: CsRule): Record<string, unknown> {
  const base = { id: r.id, via: r.via, kind: r.kind };
  switch (r.kind) {
    case "time_stop":
      return { ...base, sessions: r.sessions, min_return: rText(r.minReturn) };
    case "close_above_sma":
      return { ...base, period: r.period };
    case "negative_event":
      return { ...base, categories: r.categories === null ? null : [...r.categories] };
    case "close_below_level":
      return { ...base, level_micro: r.levelMicro.toString() };
    case "volume_dry_up":
      return { ...base, ratio_below: ratText(r.ratioBelow), sessions: r.sessions };
  }
}

function csOf(o: Record<string, unknown>): CsRule {
  const id = String(o.id);
  const via = (o.via === null ? null : String(o.via)) as Family | null;
  switch (o.kind) {
    case "time_stop":
      return {
        id,
        via,
        kind: "time_stop",
        sessions: Number(o.sessions), // money-float-ok: session count in a stored rule
        minReturn: ratOrNull(o.min_return),
      };
    case "close_above_sma":
      return { id, via, kind: "close_above_sma", period: Number(o.period) }; // money-float-ok: session count in a stored rule
    case "negative_event":
      return {
        id,
        via,
        kind: "negative_event",
        categories: o.categories === null ? null : (o.categories as string[] as never),
      };
    case "close_below_level":
      return { id, via, kind: "close_below_level", levelMicro: BigInt(String(o.level_micro)) };
    case "volume_dry_up":
      return {
        id,
        via,
        kind: "volume_dry_up",
        ratioBelow: ratOf(String(o.ratio_below)),
        sessions: Number(o.sessions), // money-float-ok: session count in a stored rule
      };
    default:
      throw new TypeError(`unknown CS rule kind ${String(o.kind)}`);
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return value;
}

/** Canonical (key-sorted) JSON of a plan: the same plan always gives the same bytes. */
export function serializePlan(p: OrderPlan): string {
  return JSON.stringify(
    sortKeys({
      v: ORDER_PLAN_VERSION,
      family: p.family,
      variant: p.variant,
      rule_version: p.ruleVersion,
      ca_through: p.caThrough,
      ca_applied: [...p.caApplied].sort(),
      stops: p.plan.initialStops.map((s) => ({ id: s.id, via: s.via, ...specJson(s.spec) })),
      trails: p.plan.trails.map((t) => ({
        id: t.id,
        via: t.via,
        k: ratText(t.k),
        activate_gain: rText(t.activateGain),
      })),
      cs: p.plan.cs.map(csJson),
      rel: p.rel.map((r) => ({ id: r.id, k: ratText(r.k), atr_micro: r.atrMicro.toString() })),
    }),
  );
}

type Rec = Record<string, unknown>;

/** Parses `serializePlan` output; throws on anything else (a plan is never guessed). */
export function parsePlan(json: string): OrderPlan {
  const o = JSON.parse(json) as Rec;
  if (o.v !== ORDER_PLAN_VERSION || typeof o.ca_through !== "string" || !Array.isArray(o.stops)) {
    throw new TypeError("not an order plan");
  }
  const initialStops: InitialStopRule[] = (o.stops as Rec[]).map((s) => ({
    id: String(s.id),
    via: (s.via === null ? null : String(s.via)) as Family | null,
    spec: specOf(s),
  }));
  const trails: TrailRule[] = (o.trails as Rec[]).map((t) => ({
    id: String(t.id),
    via: (t.via === null ? null : String(t.via)) as Family | null,
    k: ratOf(String(t.k)),
    activateGain: ratOrNull(t.activate_gain),
  }));
  return {
    family: String(o.family) as Family,
    variant: String(o.variant),
    ruleVersion: String(o.rule_version),
    caThrough: o.ca_through,
    caApplied: Array.isArray(o.ca_applied) ? (o.ca_applied as unknown[]).map(String) : [],
    plan: { initialStops, trails, cs: (o.cs as Rec[]).map(csOf) },
    rel: (o.rel as Rec[]).map((r) => ({
      id: String(r.id),
      k: ratOf(String(r.k)),
      atrMicro: BigInt(String(r.atr_micro)),
    })),
  };
}

/** The `stop_spec` of an exit order: only the quantity basis and the rule that fired. */
export function exitOrderSpec(
  caThrough: string,
  caApplied: readonly string[],
  rule: string,
  via: Family | null,
): string {
  return JSON.stringify(
    sortKeys({
      v: ORDER_PLAN_VERSION,
      ca_through: caThrough,
      ca_applied: [...caApplied].sort(),
      exit_rule: rule,
      via,
    }),
  );
}

/**
 * The quantity basis of any stored stop_spec: the date and the ids of the actions already applied.
 * Without one (an M3 order) it is the decision date with nothing applied.
 */
export function caBasisOf(
  stopSpec: string | null,
  fallback: string,
): { readonly through: string; readonly applied: ReadonlySet<string> } {
  if (stopSpec === null) return { through: fallback, applied: new Set() };
  try {
    const o = JSON.parse(stopSpec) as Rec;
    return {
      through: typeof o.ca_through === "string" ? o.ca_through : fallback,
      applied: new Set(Array.isArray(o.ca_applied) ? (o.ca_applied as unknown[]).map(String) : []),
    };
  } catch {
    return { through: fallback, applied: new Set() };
  }
}

// ---- corporate-action crossing ------------------------------------------------------------------

const QUANTITY_TYPES = new Set(["split", "consolidation", "bonus_issue"]);
const DISPOSAL_TYPES = new Set(["merger_cash", "merger_scrip", "delisting"]);

export type Crossing = {
  /** Shares per share held after the crossed actions; 1 when none. */
  readonly ratio: Rational;
  /** Price multiplier (1 / ratio). */
  readonly priceFactor: Rational;
  /** A disposal-type action is crossed: an entry must not be placed. */
  readonly disposal: boolean;
  /** Ids of the crossed actions (quantity-changing and disposal types). */
  readonly ids: readonly string[];
};

/**
 * The confirmed actions of `code` with an ex-date in (fromExclusive, toInclusive]. Dividends and
 * rights change no quantity or order price here (they are cash effects in the ledger).
 */
export function crossing(
  actions: readonly CorpActionRecord[],
  code: string,
  fromExclusive: string,
  toInclusive: string,
  applied: ReadonlySet<string> = new Set(),
): Crossing {
  let ratio = makeRational(1n);
  let disposal = false;
  const ids: string[] = [];
  for (const a of actions) {
    if (a.code !== code || a.exDate <= fromExclusive || a.exDate > toInclusive) continue;
    if (applied.has(a.id)) continue;
    if (QUANTITY_TYPES.has(a.type)) {
      ratio = mulRat(ratio, quantityRatio(a));
      ids.push(a.id);
    } else if (DISPOSAL_TYPES.has(a.type)) {
      disposal = true;
      ids.push(a.id);
    }
  }
  return { ratio, priceFactor: makeRational(ratio.den, ratio.num), disposal, ids };
}

/** Whole shares after a re-base (floor), the same rule as the ledger (ARN-023). */
export function rescaleQty(qty: bigint, c: Crossing): bigint {
  return rebaseQty(qty, c.ratio);
}

/** A micro price level expressed through a price factor, rounded half away once. */
export function scaleMicro(value: bigint, factor: Rational): bigint {
  return roundHalfAway(mulRat(ratFromInt(value), factor));
}

/** True when the factor is exactly 1 (nothing crossed). */
export function isUnit(f: Rational): boolean {
  return cmpRat(f, makeRational(1n)) === 0;
}

function scaledSpec(s: StopSpec, factor: Rational): StopSpec {
  return {
    atr_micro: s.atr_micro === null ? null : scaleMicro(s.atr_micro, factor),
    k: s.k,
    cap: s.cap,
    level_micro: s.level_micro === null ? null : scaleMicro(s.level_micro, factor),
  };
}

/**
 * The initial IS level from the ACTUAL fill (ARN-021): the highest (tightest) level over the plan's
 * initial-stop rules, each computed by `initialStop`; at least one micro. `factor` rescales a plan
 * written before an ex-date that the order crossed.
 */
export function initialStopAtFill(
  plan: OrderPlan,
  fillMicro: bigint,
  factor: Rational = makeRational(1n),
): bigint {
  let level = 0n;
  for (const rule of plan.plan.initialStops) {
    const s = initialStop(scaledSpec(rule.spec, factor), fillMicro);
    if (s > level) level = s;
  }
  return level < 1n ? 1n : level;
}

/** The plan with every price level re-based through a price factor (an ex-date between bases). */
export function scalePlanPrices(plan: ExitPlan, factor: Rational): ExitPlan {
  if (isUnit(factor)) return plan;
  return {
    initialStops: plan.initialStops.map((r) => ({ ...r, spec: scaledSpec(r.spec, factor) })),
    trails: plan.trails,
    cs: plan.cs.map((r) =>
      r.kind === "close_below_level" ? { ...r, levelMicro: scaleMicro(r.levelMicro, factor) } : r,
    ),
  };
}
