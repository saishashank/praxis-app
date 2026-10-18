// Decision Cards (M4 T9; AGT-110, AT-16; docs/M4_design.md 4.5, decisions 20 and 21; D-084, D-087).
//
// A card is built for every E01-E12 family signal, taken or not (decision 20); C2/C3 and exit orders
// only LINK to the matched signal's / entry's card. `card_json` is canonical JSON of schema v1 with
// NO probability field and NO free text: every number comes from a deterministic field builder in
// this file, fed by recorded inputs (`CardInputs`); the only wording is the fixed per-family thesis
// line, the fixed footnote template and the optional `card_note` (rules-only template by default,
// an LLM summary only through the router and only when it passes numeric grounding, LLM-034).
// `validateCard` is the AT-16 validator: exact JSON schema check, catalogue/limit checks and a rebuild
// from the inputs (every value must equal what the builders produce).
//
// Pure except the explicit DB helpers at the bottom (scenario lookup, card writers), which take an
// `Exec` so batch 2b can run them inside its transaction.
import type { Client } from "@libsql/client";
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";
import { feeFor, type CostProfile } from "@/lib/arena/costs";
import { slippageFill } from "@/lib/arena/slippage";
import { checkGrounding } from "@/lib/llm/grounding";
import type { LlmRouter } from "@/lib/llm/router";
import { divCeil, makeRational, mulRat, type Rational } from "@/lib/money/rational";
import type { Fraction } from "@/lib/replay/returns";
import type { AgentParams } from "./params";
import { initialStop } from "./families/exits";
import type { Candidate, CsRule, EventFact, ExitPlan, Family, RegimeLabel } from "./families/types";
import { roundHalfAway } from "./regime";
import { cardBreakers, BREAKER_CATALOGUE, type CardBreaker } from "./thesisBreakers";

export const CARD_SCHEMA_VERSION = 1;
export const CARD_NOTE_KIND = "summary";
export const CARD_TEMPLATE_VERSION = "card-summary-1";

/** Data-quality flags are exactly these five (AGT-110 s13). */
export const DATA_QUALITY_FLAGS = [
  "first-seen",
  "assumed-time",
  "quality-suspect",
  "survivorship-exposed",
  "stale-data",
] as const;

const PPM = 1_000_000n; // threshold-ok: parts per million
const PCT_BASE = 100n; // threshold-ok: nearest-rank percentile denominator
/** AGT-110: the scenario table is the 10th / 50th / 90th percentile. */
const PERCENTILES = [10, 50, 90] as const; // threshold-ok: AGT-110 scenario percentiles
const NOTE_MAX_OUTPUT_TOKENS = 400; // threshold-ok: LLM-0xx per-call output cap for card wording
/** Role that words card summaries (R2 analyst; LLM-050 drops card text before evening review). */
const NOTE_ROLE = "R2" as const;

/** Fixed thesis line per family: spec 7.4 wording, no numbers, never LLM-written. */
export const FAMILY_THESIS: Readonly<Record<Family, string>> = {
  F1: "Trend breakout: new long-term high on rising volume with top-tier relative strength.",
  F2: "Catalyst drift: a positive results or guidance event with a strong abnormal return.",
  F3: "Event drift: a positive price-sensitive event on heavy volume, continuing after day 0.",
  F4: "Mean reversion: an oversold close above the long-term trend.",
  F5: "Small-cap discovery: a volume surge on a positive event, closing near the day high.",
  F6: "Consensus: several independent evidence classes agree on the same code.",
};

const NOT_TAKEN =
  /^(rank|positions_full|holding|reentry_block|corporate_action|no_facts|gate|rejected:[a-z_,]+)$/;

// ---- types -------------------------------------------------------------------------------------

export type Detail = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export type CardEvent = {
  readonly source: string;
  readonly ann_id: string;
  readonly day0: string;
  readonly category: string;
  readonly polarity: string;
  readonly price_sensitive: boolean;
  readonly ar_ppm: number | null;
  readonly timed: boolean;
};

export type CardRule = {
  readonly rule: string;
  readonly value: string;
  readonly threshold: string;
  readonly pass: boolean;
};

export type CardExit = {
  readonly rule: string;
  readonly tag: "IS" | "CS";
  readonly via: string | null;
  readonly kind: string;
  readonly detail: Detail;
};

export type CardScenario = {
  readonly insufficient_history: boolean;
  readonly n: number;
  readonly reason: string | null;
  readonly p10_ppm: number | null;
  readonly p50_ppm: number | null;
  readonly p90_ppm: number | null;
  readonly split_version: number | null;
  readonly as_of_roll_d: string | null;
  readonly variant: string;
  readonly rule_version: string;
};

export type DecisionCard = {
  readonly v: number;
  readonly market: string;
  readonly d: string;
  readonly code: string;
  readonly family: Family;
  readonly execution: string;
  readonly rule_version: string;
  readonly variant: string;
  readonly regime: RegimeLabel;
  readonly taken: boolean;
  readonly not_taken_reason: string | null;
  readonly thesis: string;
  readonly rules_fired: readonly CardRule[];
  readonly rank_score: string;
  readonly evidence: {
    readonly events: readonly CardEvent[];
    readonly insider_flow: "unknown" | { readonly score_q: number };
    readonly short_interest: "unknown" | "drop" | "no_drop";
    readonly data_quality_flags: readonly string[];
    readonly other_flags: readonly string[];
  };
  readonly thesis_breakers: readonly CardBreaker[];
  readonly exit_plan: readonly CardExit[];
  readonly sizing: {
    readonly available: boolean;
    readonly accepted: boolean | null;
    readonly reasons: readonly string[];
    readonly qty: string | null;
    readonly fill_price_micro: string | null;
    readonly order_value_micro: string | null;
    readonly half_size: boolean;
  };
  readonly cost: {
    readonly available: boolean;
    readonly reason: string | null;
    readonly entry_brokerage_micro: string | null;
    readonly entry_slippage_micro: string | null;
    readonly exit_brokerage_micro: string | null;
    readonly exit_slippage_micro: string | null;
    readonly cost_estimate_micro: string | null;
    readonly order_value_micro: string | null;
    readonly break_even_ppm: number | null;
  };
  readonly scenario: CardScenario;
  readonly footnote: string;
};

/** The development split of a lineage (lineage_split row reduced to what a card shows). */
export type SplitInfo = {
  readonly version: number;
  readonly devEndD: string | null;
  readonly deferredUntilD: string | null;
  /** The as-of roll date of the footnote: the split's data end. */
  readonly asOfD: string;
};

export type ScenarioInput = {
  readonly split: SplitInfo | null;
  /** Net returns (exact fractions) of the closed development-split ledger rows of the variant. */
  readonly nets: readonly Fraction[];
};

export type CardSizingInput = {
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly qty: bigint;
  readonly fillPriceMicro: bigint;
  readonly slipMicro: bigint;
  readonly brokerageMicro: bigint;
  readonly orderValueMicro: bigint;
  /** Reference (close) price on the fill-session basis and the 20-session ADV value. */
  readonly refPriceMicro: bigint;
  readonly advValueMicro: bigint;
};

export type CardInputs = {
  readonly signalId: string;
  readonly market: string;
  readonly d: string;
  readonly executionId: string;
  readonly candidate: Pick<
    Candidate,
    | "family"
    | "variant"
    | "ruleVersion"
    | "code"
    | "regime"
    | "rules"
    | "rankText"
    | "flags"
    | "halfSize"
    | "groupKey"
  >;
  readonly taken: boolean;
  readonly notTakenReason: string | null;
  /** Today's close on the fill-session price basis (post corporate-action terms). */
  readonly closeMicro: bigint;
  /** The signal's exit plan on the same basis. */
  readonly plan: ExitPlan;
  /** Events of the code relevant to the card (already windowed), sorted. */
  readonly events: readonly EventFact[];
  readonly insiderScoreQ: number | null;
  readonly shortDrop: boolean | "unknown";
  /** Day-0 low of the signal's own event group on the fill basis; null when none / unavailable. */
  readonly eventLowMicro: bigint | null;
  readonly sizing: CardSizingInput | null;
  readonly scenario: ScenarioInput;
  readonly params: AgentParams;
  /** Cohort cost profile and tick-cross factor (the exit leg is priced the way the entry was). */
  readonly costProfile: CostProfile;
  readonly tickCrossFactor: Rational;
};

// ---- field builders ----------------------------------------------------------------------------

const ratText = (r: Rational): string => `${r.num}/${r.den}`;
const ratOrNull = (r: Rational | null): string | null => (r === null ? null : ratText(r));
const microText = (v: bigint | null): string | null => (v === null ? null : v.toString());
const toPpm = (r: Rational): number => Number(roundHalfAway(mulRat(r, makeRational(PPM)))); // money-float-ok: ppm ratio, fits a safe integer

const flagSet: ReadonlySet<string> = new Set(DATA_QUALITY_FLAGS);

export function buildEvents(events: readonly EventFact[]): CardEvent[] {
  return [...events]
    .sort((a, b) =>
      a.day0 < b.day0 ? -1 : a.day0 > b.day0 ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    .map((e) => {
      const cut = e.id.indexOf("|");
      return {
        source: e.id.slice(0, cut),
        ann_id: e.id.slice(cut + 1),
        day0: e.day0,
        category: e.category,
        polarity: String(e.polarity),
        price_sensitive: e.priceSensitive,
        ar_ppm: e.ar === null ? null : toPpm(e.ar),
        timed: e.timed,
      };
    });
}

export function buildFlags(
  flags: readonly string[],
  events: readonly EventFact[],
): { quality: string[]; other: string[] } {
  const all = new Set(flags);
  if (events.some((e) => !e.timed)) all.add("assumed-time");
  const quality = [...all].filter((f) => flagSet.has(f)).sort();
  const other = [...all].filter((f) => !flagSet.has(f)).sort();
  return { quality, other };
}

function csDetail(r: CsRule): Detail {
  switch (r.kind) {
    case "time_stop":
      return { sessions: r.sessions, min_return: ratOrNull(r.minReturn) };
    case "close_above_sma":
      return { period: r.period };
    case "negative_event":
      return { categories: r.categories === null ? null : [...r.categories].sort() };
    case "close_below_level":
      return { level_micro: r.levelMicro.toString() };
    case "volume_dry_up":
      return { ratio_below: ratText(r.ratioBelow), sessions: r.sessions };
  }
}

export function buildExitPlan(plan: ExitPlan, closeMicro: bigint): CardExit[] {
  const out: CardExit[] = [];
  for (const s of plan.initialStops) {
    out.push({
      rule: s.id,
      tag: "IS",
      via: s.via,
      kind: "initial_stop",
      detail: {
        atr_micro: microText(s.spec.atr_micro),
        k: ratOrNull(s.spec.k),
        cap: ratOrNull(s.spec.cap),
        level_micro: microText(s.spec.level_micro),
        stop_at_close_micro: initialStop(s.spec, closeMicro).toString(),
      },
    });
  }
  for (const t of plan.trails) {
    out.push({
      rule: t.id,
      tag: "IS",
      via: t.via,
      kind: "trail",
      detail: { k: ratText(t.k), activate_gain: ratOrNull(t.activateGain) },
    });
  }
  for (const c of plan.cs) {
    out.push({ rule: c.id, tag: "CS", via: c.via, kind: c.kind, detail: csDetail(c) });
  }
  return out;
}

/** Nearest-rank percentile (1-based rank ceil(p n / 100)) of sorted exact fractions, in ppm. */
export function nearestRankPpm(sorted: readonly Fraction[], pct: number): number {
  const rank = divCeil(BigInt(pct) * BigInt(sorted.length), PCT_BASE);
  const f = sorted[Number(rank) - 1]!; // money-float-ok: list index
  return toPpm(makeRational(f.num, f.den));
}

const cmpFraction = (a: Fraction, b: Fraction): number => {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
};

export function buildScenario(
  input: ScenarioInput,
  variant: string,
  ruleVersion: string,
  minN: number,
): CardScenario {
  const base = { variant, rule_version: ruleVersion };
  const split = input.split;
  if (split === null) {
    return {
      ...base,
      insufficient_history: true,
      n: 0,
      reason: "no development replay yet",
      p10_ppm: null,
      p50_ppm: null,
      p90_ppm: null,
      split_version: null,
      as_of_roll_d: null,
    };
  }
  const n = input.nets.length;
  const ctx = { ...base, split_version: split.version, as_of_roll_d: split.asOfD };
  const none = { p10_ppm: null, p50_ppm: null, p90_ppm: null };
  if (split.deferredUntilD !== null) {
    return {
      ...ctx,
      ...none,
      insufficient_history: true,
      n,
      reason: `splits deferred until ${split.deferredUntilD}`,
    };
  }
  if (n < minN) {
    return { ...ctx, ...none, insufficient_history: true, n, reason: `n < ${minN}` };
  }
  const sorted = [...input.nets].sort(cmpFraction);
  const [a, b, c] = PERCENTILES;
  return {
    ...ctx,
    insufficient_history: false,
    n,
    reason: null,
    p10_ppm: nearestRankPpm(sorted, a),
    p50_ppm: nearestRankPpm(sorted, b),
    p90_ppm: nearestRankPpm(sorted, c),
  };
}

/** The standing footnote (AGT-110 s11): development-split n and the as-of roll date. */
export function buildFootnote(s: CardScenario): string {
  if (s.split_version === null || s.as_of_roll_d === null) {
    return `Development-split replay: no split yet, n ${s.n}.`;
  }
  return `Development-split replay, n ${s.n}, split v${s.split_version}, as of ${s.as_of_roll_d}.`;
}

export function buildSizing(inputs: CardInputs): DecisionCard["sizing"] {
  const z = inputs.sizing;
  if (z === null) {
    return {
      available: false,
      accepted: null,
      reasons: [],
      qty: null,
      fill_price_micro: null,
      order_value_micro: null,
      half_size: inputs.candidate.halfSize,
    };
  }
  return {
    available: true,
    accepted: z.accepted,
    reasons: [...z.reasons],
    qty: z.qty.toString(),
    fill_price_micro: z.fillPriceMicro.toString(),
    order_value_micro: z.orderValueMicro.toString(),
    half_size: inputs.candidate.halfSize,
  };
}

/**
 * Round-trip cost (design 4.5): entry brokerage + entry slippage + exit brokerage + exit slippage
 * with the exit at today's close; break-even = cost / order value in ppm (rounded up).
 */
export function buildCost(inputs: CardInputs): DecisionCard["cost"] {
  const z = inputs.sizing;
  const off = (reason: string): DecisionCard["cost"] => ({
    available: false,
    reason,
    entry_brokerage_micro: null,
    entry_slippage_micro: null,
    exit_brokerage_micro: null,
    exit_slippage_micro: null,
    cost_estimate_micro: null,
    order_value_micro: null,
    break_even_ppm: null,
  });
  if (z === null) return off("not_sized");
  if (z.qty < 1n || z.orderValueMicro < 1n || z.refPriceMicro < 1n) return off("no_quantity");
  const quote = slippageFill(z.refPriceMicro, "sell", z.advValueMicro, inputs.tickCrossFactor);
  const exitValue = z.qty * quote.fillMicro;
  if (exitValue < 1n) return off("no_quantity");
  const entrySlip = z.qty * z.slipMicro;
  const exitSlip = z.qty * quote.slipMicro;
  const exitBrok = feeFor(inputs.costProfile, exitValue, "sell");
  const total = z.brokerageMicro + entrySlip + exitBrok + exitSlip;
  return {
    available: true,
    reason: null,
    entry_brokerage_micro: z.brokerageMicro.toString(),
    entry_slippage_micro: entrySlip.toString(),
    exit_brokerage_micro: exitBrok.toString(),
    exit_slippage_micro: exitSlip.toString(),
    cost_estimate_micro: total.toString(),
    order_value_micro: z.orderValueMicro.toString(),
    break_even_ppm: Number(divCeil(total * PPM, z.orderValueMicro)), // money-float-ok: ppm ratio, fits a safe integer
  };
}

/** Builds the card from its inputs: deterministic, no clock, no I/O. */
export function buildCard(inputs: CardInputs): DecisionCard {
  const c = inputs.candidate;
  const p = inputs.params;
  const flags = buildFlags(c.flags, inputs.events);
  const scenario = buildScenario(inputs.scenario, c.variant, c.ruleVersion, p.stats.scenarioMinN);
  return {
    v: CARD_SCHEMA_VERSION,
    market: inputs.market,
    d: inputs.d,
    code: c.code,
    family: c.family,
    execution: inputs.executionId,
    rule_version: c.ruleVersion,
    variant: c.variant,
    regime: c.regime,
    taken: inputs.taken,
    not_taken_reason: inputs.notTakenReason,
    thesis: FAMILY_THESIS[c.family],
    rules_fired: c.rules.map((r) => ({
      rule: r.id,
      value: r.value,
      threshold: r.threshold,
      pass: r.pass,
    })),
    rank_score: c.rankText,
    evidence: {
      events: buildEvents(inputs.events),
      insider_flow: inputs.insiderScoreQ === null ? "unknown" : { score_q: inputs.insiderScoreQ },
      short_interest:
        inputs.shortDrop === "unknown" ? "unknown" : inputs.shortDrop ? "drop" : "no_drop",
      data_quality_flags: flags.quality,
      other_flags: flags.other,
    },
    thesis_breakers: cardBreakers(
      { family: c.family, shortInterestAvailable: inputs.shortDrop !== "unknown" },
      p,
      { closeMicro: inputs.closeMicro, eventLowMicro: inputs.eventLowMicro },
    ),
    exit_plan: buildExitPlan(inputs.plan, inputs.closeMicro),
    sizing: buildSizing(inputs),
    cost: buildCost(inputs),
    scenario,
    footnote: buildFootnote(scenario),
  };
}

export type BuiltCard = {
  readonly id: string;
  readonly card: DecisionCard;
  readonly json: string;
  readonly sha: string;
};

export const cardIdOf = (signalId: string, executionId: string): string =>
  `card:${signalId}:${executionId}`;

export function finishCard(inputs: CardInputs): BuiltCard {
  const card = buildCard(inputs);
  const json = canonicalJson(card);
  return { id: cardIdOf(inputs.signalId, inputs.executionId), card, json, sha: sha256Hex(json) };
}

// ---- validator (AT-16) ---------------------------------------------------------------------------

type Check = (v: unknown, path: string, errors: string[]) => void;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const str: Check = (v, path, e) => {
  if (typeof v !== "string") e.push(`${path}: string expected`);
};
const int: Check = (v, path, e) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) e.push(`${path}: whole number expected`);
};
const bool: Check = (v, path, e) => {
  if (typeof v !== "boolean") e.push(`${path}: boolean expected`);
};
const micro: Check = (v, path, e) => {
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) e.push(`${path}: micro amount text expected`);
};
const nullable =
  (inner: Check): Check =>
  (v, path, e) => {
    if (v !== null) inner(v, path, e);
  };
const list =
  (inner: Check): Check =>
  (v, path, e) => {
    if (!Array.isArray(v)) {
      e.push(`${path}: list expected`);
      return;
    }
    v.forEach((x, i) => inner(x, `${path}[${i}]`, e));
  };
const shape =
  (fields: Readonly<Record<string, Check>>): Check =>
  (v, path, e) => {
    if (!isObj(v)) {
      e.push(`${path}: object expected`);
      return;
    }
    for (const k of Object.keys(v)) if (!(k in fields)) e.push(`${path}.${k}: unknown field`);
    for (const [k, check] of Object.entries(fields)) {
      if (!(k in v)) e.push(`${path}.${k}: missing`);
      else check(v[k], `${path}.${k}`, e);
    }
  };
const oneOf =
  (...values: readonly unknown[]): Check =>
  (v, path, e) => {
    if (!values.includes(v)) e.push(`${path}: not one of ${values.map(String).join("|")}`);
  };
/** A flat detail record of strings, whole numbers, booleans, nulls and string lists. */
const detail: Check = (v, path, e) => {
  if (!isObj(v)) {
    e.push(`${path}: object expected`);
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    const ok =
      x === null ||
      typeof x === "string" ||
      typeof x === "boolean" ||
      (typeof x === "number" && Number.isSafeInteger(x)) ||
      (Array.isArray(x) && x.every((y) => typeof y === "string"));
    if (!ok) e.push(`${path}.${k}: flat value expected`);
  }
};

const FORBIDDEN_KEY = /prob|confidence|chance|likelihood|odds/i;

function forbiddenKeys(v: unknown, path: string, e: string[]): void {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenKeys(x, `${path}[${i}]`, e));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEY.test(k))
        e.push(`${path}.${k}: probabilities and confidence are not allowed`);
      forbiddenKeys(x, `${path}.${k}`, e);
    }
  }
}

const SCHEMA: Check = shape({
  v: oneOf(CARD_SCHEMA_VERSION),
  market: str,
  d: str,
  code: str,
  family: oneOf("F1", "F2", "F3", "F4", "F5", "F6"),
  execution: str,
  rule_version: str,
  variant: str,
  regime: oneOf("SHOCK", "RISK-OFF", "RISK-ON", "NEUTRAL", "unknown"),
  taken: bool,
  not_taken_reason: nullable(str),
  thesis: str,
  rules_fired: list(shape({ rule: str, value: str, threshold: str, pass: bool })),
  rank_score: str,
  evidence: shape({
    events: list(
      shape({
        source: str,
        ann_id: str,
        day0: str,
        category: str,
        polarity: str,
        price_sensitive: bool,
        ar_ppm: nullable(int),
        timed: bool,
      }),
    ),
    insider_flow: (v, path, e) => {
      if (v !== "unknown") shape({ score_q: int })(v, path, e);
    },
    short_interest: oneOf("unknown", "drop", "no_drop"),
    data_quality_flags: list(oneOf(...DATA_QUALITY_FLAGS)),
    other_flags: list(str),
  }),
  thesis_breakers: list((v, path, e) => {
    if (!isObj(v)) e.push(`${path}: object expected`);
    else {
      oneOf(...BREAKER_CATALOGUE.map((b) => b.id))(v.id, `${path}.id`, e);
      str(v.check, `${path}.check`, e);
      detail(v, path, e);
    }
  }),
  exit_plan: list(
    shape({ rule: str, tag: oneOf("IS", "CS"), via: nullable(str), kind: str, detail }),
  ),
  sizing: shape({
    available: bool,
    accepted: nullable(bool),
    reasons: list(str),
    qty: nullable(micro),
    fill_price_micro: nullable(micro),
    order_value_micro: nullable(micro),
    half_size: bool,
  }),
  cost: shape({
    available: bool,
    reason: nullable(str),
    entry_brokerage_micro: nullable(micro),
    entry_slippage_micro: nullable(micro),
    exit_brokerage_micro: nullable(micro),
    exit_slippage_micro: nullable(micro),
    cost_estimate_micro: nullable(micro),
    order_value_micro: nullable(micro),
    break_even_ppm: nullable(int),
  }),
  scenario: shape({
    insufficient_history: bool,
    n: int,
    reason: nullable(str),
    p10_ppm: nullable(int),
    p50_ppm: nullable(int),
    p90_ppm: nullable(int),
    split_version: nullable(int),
    as_of_roll_d: nullable(str),
    variant: str,
    rule_version: str,
  }),
  footnote: str,
});

/** JSON-schema-style check of a stored `card_json` value plus the AGT-110 content rules. */
export function checkCard(card: unknown, p: AgentParams): string[] {
  const errors: string[] = [];
  SCHEMA(card, "card", errors);
  forbiddenKeys(card, "card", errors);
  if (errors.length > 0) return errors;
  const c = card as DecisionCard;
  const tb = c.thesis_breakers;
  if (tb.length < p.thesisBreakersMin || tb.length > p.thesisBreakersMax) {
    errors.push(
      `thesis_breakers: ${tb.length} outside ${p.thesisBreakersMin}-${p.thesisBreakersMax}`,
    );
  }
  const order = BREAKER_CATALOGUE.map((b) => b.id as string);
  let last = -1;
  for (const b of tb) {
    const spec = BREAKER_CATALOGUE.find((s) => s.id === b.id)!;
    if (!spec.families.includes(c.family))
      errors.push(`thesis_breakers.${b.id}: not for ${c.family}`);
    const at = order.indexOf(b.id);
    if (at <= last) errors.push("thesis_breakers: not in catalogue order");
    last = at;
  }
  if (c.thesis !== FAMILY_THESIS[c.family]) errors.push("thesis: not the family line");
  if (c.taken !== (c.not_taken_reason === null)) errors.push("not_taken_reason: set iff not taken");
  if (c.not_taken_reason !== null && !NOT_TAKEN.test(c.not_taken_reason)) {
    errors.push("not_taken_reason: unknown reason");
  }
  const s = c.scenario;
  if (s.insufficient_history) {
    if (s.reason === null) errors.push("scenario: insufficient history needs a reason");
    if (s.p10_ppm !== null || s.p50_ppm !== null || s.p90_ppm !== null) {
      errors.push("scenario: insufficient history shows no percentiles");
    }
  } else {
    if (s.n < p.stats.scenarioMinN)
      errors.push("scenario: n below the minimum must read insufficient history");
    const { p10_ppm: a, p50_ppm: b, p90_ppm: d } = s;
    if (a === null || b === null || d === null || !(a <= b && b <= d)) {
      errors.push("scenario: percentiles must be present and ordered");
    }
  }
  if (c.footnote !== buildFootnote(s)) errors.push("footnote: not the standing template");
  return errors;
}

/**
 * The AT-16 validator: schema + content rules, and (with `inputs`) the property "every number in
 * `card_json` is produced by a deterministic field builder": the card must equal, byte for byte, the
 * card rebuilt from the recorded inputs.
 */
export function validateCard(card: unknown, p: AgentParams, inputs?: CardInputs): string[] {
  const errors = checkCard(card, p);
  if (errors.length > 0 || inputs === undefined) return errors;
  if (canonicalJson(card) !== canonicalJson(buildCard(inputs))) {
    errors.push("card: differs from the card rebuilt from its inputs");
  }
  return errors;
}

// ---- card note (rules-only text, optional router summary) -----------------------------------------

export type CardNote = {
  readonly kind: string;
  readonly text: string;
  readonly provider: string | null;
  readonly model_id: string | null;
  readonly fallback_depth: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly prompt_sha: string | null;
};

/** Rules-only wording: only fields (and the fixed thesis line) of the card itself. */
export function rulesNoteText(card: DecisionCard): string {
  const parts = [
    `${card.code} ${card.family} ${card.execution} (${card.rule_version}, ${card.variant}), regime ${card.regime}.`,
    card.thesis,
    `Rank score ${card.rank_score}.`,
  ];
  if (card.cost.available) {
    parts.push(
      `Round-trip cost ${card.cost.cost_estimate_micro} micro-AUD, break-even ${card.cost.break_even_ppm} ppm.`,
    );
  }
  const s = card.scenario;
  parts.push(
    s.insufficient_history
      ? `Scenario: insufficient history (${s.reason}).`
      : `Scenario net return p10 ${s.p10_ppm}, p50 ${s.p50_ppm}, p90 ${s.p90_ppm} ppm (n ${s.n}).`,
  );
  parts.push(`Thesis-breakers: ${card.thesis_breakers.map((b) => b.id).join(", ")}.`);
  return parts.join(" ");
}

export const rulesNote = (card: DecisionCard): CardNote => ({
  kind: CARD_NOTE_KIND,
  text: rulesNoteText(card),
  provider: null,
  model_id: null,
  fallback_depth: "rules-only",
  tokens_in: 0,
  tokens_out: 0,
  prompt_sha: null,
});

type NoteAnswer = { text: string };

function parseNote(v: unknown): NoteAnswer | null {
  if (!isObj(v) || typeof v.text !== "string" || v.text.length === 0) return null;
  return { text: v.text };
}

/** The router request for a card summary: facts = the card, rules answer = the template text. */
export function noteRequest(card: DecisionCard) {
  return {
    role: NOTE_ROLE,
    market: card.market,
    d: card.d,
    nightly: true,
    templateVersion: CARD_TEMPLATE_VERSION,
    task: 'Summarise this Decision Card in two plain sentences for a retail investor. Use only the facts given; do not state probabilities, forecasts or numbers that are not in FACTS. Answer as JSON {"text": string}.',
    facts: card,
    parse: parseNote,
    rules: { text: rulesNoteText(card) } as NoteAnswer,
    maxOutputTokens: NOTE_MAX_OUTPUT_TOKENS,
  };
}

/**
 * The card's note. Without a router, or when the router falls back, it is the rules-only template.
 * An LLM answer reaches this point only after the router's JSON-schema and numeric-grounding checks
 * against the card (LLM-034); it is checked again here (defence in depth).
 */
export async function cardNote(card: DecisionCard, router?: LlmRouter): Promise<CardNote> {
  if (router === undefined) return rulesNote(card);
  const r = await router.route(noteRequest(card));
  if (!r.llmUsed || !checkGrounding(r.value.text, card).ok) return rulesNote(card);
  const last = r.attempts[r.attempts.length - 1];
  return {
    kind: CARD_NOTE_KIND,
    text: r.value.text,
    provider: last?.provider ?? r.source,
    model_id: null,
    fallback_depth: String(r.attempts.length - 1),
    tokens_in: r.call.tokensIn,
    tokens_out: r.call.tokensOut,
    prompt_sha: r.call.promptShas[r.call.promptShas.length - 1] ?? null,
  };
}

// ---- database helpers ----------------------------------------------------------------------------------

type Exec = Pick<Client, "execute">;

export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardError";
  }
}

/**
 * Scenario inputs from the development signal ledger (decision 21): closed `ledger_row` rows of the
 * lineage `<market>:<family>` whose signal has the card's rule version and variant, entered and
 * exited on or before the split's development end; net return = (proceeds - cost) / cost with
 * proceeds = shares sold (re-based by splits) x exit fill - exit brokerage + cash dividends (D-091).
 */
export async function loadScenarioInput(
  db: Exec,
  q: { market: string; family: string; ruleVersion: string; variant: string },
): Promise<ScenarioInput> {
  const sp = await db.execute({
    sql: `SELECT version, dev_end_d, deferred_until_d, data_end_d FROM lineage_split
          WHERE lineage_id = ? ORDER BY version DESC LIMIT 1`,
    args: [`${q.market}:${q.family}`],
  });
  if (sp.rows.length === 0) return { split: null, nets: [] };
  const r = sp.rows[0]!;
  const split: SplitInfo = {
    version: Number(r.version), // money-float-ok: version number
    devEndD: r.dev_end_d === null ? null : String(r.dev_end_d),
    deferredUntilD: r.deferred_until_d === null ? null : String(r.deferred_until_d),
    asOfD: String(r.data_end_d),
  };
  if (split.devEndD === null) return { split, nets: [] };
  const rows = await db.execute({
    sql: `SELECT l.qty, l.qty_out, l.fill_in_micro, l.fill_out_micro, l.brok_in_micro, l.brok_out_micro,
            l.dividend_micro
          FROM ledger_row l JOIN signal s ON s.id = l.signal_id
          WHERE s.market = ? AND s.family = ? AND s.rule_version = ? AND s.variant = ?
            AND l.exit_d IS NOT NULL AND l.entry_d <= ? AND l.exit_d <= ?
          ORDER BY l.id`,
    args: [q.market, q.family, q.ruleVersion, q.variant, split.devEndD, split.devEndD],
  });
  const nets = rows.rows.map((x) => {
    const qty = BigInt(String(x.qty));
    const cost = qty * BigInt(String(x.fill_in_micro)) + BigInt(String(x.brok_in_micro));
    const proceeds =
      BigInt(String(x.qty_out)) * BigInt(String(x.fill_out_micro)) -
      BigInt(String(x.brok_out_micro)) +
      BigInt(String(x.dividend_micro));
    return { num: proceeds - cost, den: cost };
  });
  return { split, nets };
}

export type CardLink = { readonly orderId: string | null; readonly cohortId: string | null };

/**
 * Inserts the card (append-only). Idempotent: an existing card of the same cohort must have the
 * same sha or the run raises; a card first written by another cohort of the same execution is kept.
 * Returns true when a row was written.
 */
export async function putCard(
  db: Exec,
  built: BuiltCard,
  link: CardLink,
  signalId: string,
  decidedAt: string,
): Promise<boolean> {
  const card = built.card;
  const res = await db.execute({
    sql: `INSERT INTO decision_card (id, signal_id, execution_id, cohort_id, taken, not_taken_reason,
            order_id, card_json, card_sha, schema_version, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      built.id,
      signalId,
      card.execution,
      link.cohortId,
      card.taken ? 1 : 0,
      card.not_taken_reason,
      link.orderId,
      built.json,
      built.sha,
      CARD_SCHEMA_VERSION,
      decidedAt,
    ],
  });
  if (res.rowsAffected > 0) return true;
  const stored = await db.execute({
    sql: "SELECT cohort_id, card_sha FROM decision_card WHERE id = ?",
    args: [built.id],
  });
  if (stored.rows.length === 0)
    throw new CardError(`decision_card: a different row holds ${built.id}`);
  const row = stored.rows[0]!;
  const sameCohort = (row.cohort_id === null ? null : String(row.cohort_id)) === link.cohortId;
  if (sameCohort && String(row.card_sha) !== built.sha) {
    throw new CardError(`decision_card: stored card differs for ${built.id}`);
  }
  return false;
}

/** Inserts the card note; an existing note is kept (a rerun never rewrites wording). */
export async function putCardNote(db: Exec, cardId: string, n: CardNote): Promise<boolean> {
  const res = await db.execute({
    sql: `INSERT INTO card_note (card_id, kind, text, provider, model_id, fallback_depth,
            tokens_in, tokens_out, prompt_sha)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      cardId,
      n.kind,
      n.text,
      n.provider,
      n.model_id,
      n.fallback_depth,
      n.tokens_in,
      n.tokens_out,
      n.prompt_sha,
    ],
  });
  return res.rowsAffected > 0;
}
