// Rule schema v1 (KB-010, M6 decision 32 / D-110, D-111): the declarative description of a family
// rule version and the loader check that rejects what the schema does not allow.
//
// A rule version's `spec_json` is a declarative description of the family (named conditions over the
// indicator and event vocabulary of AGT-020 / AGT-030, exit rules, sizing rule, regime gate, universe
// tiers) and its `params_json` holds the numbers the conditions reference. The simulator in
// ./rules.ts and ./exits.ts is the interpreter; in M6 parameters are the only degree of freedom
// (a challenger changes >= 1 B-key value within bounds; a structural change is a new lineage,
// FAM-101), so a version never needs a code change.
//
// Schema (KB-010):
//   condition  {field, op, value | param}   field from RULE_FIELDS, op from RULE_OPERATORS,
//                                           `param` names a Lane-B key of the family (ch.15 §15.3)
//   group      {logic: "AND" | "OR", items: [node, ...]}     explicit, never mixed at one level
//   count_of   {count_of: {n: number | {param}, items: [condition, ...]}}   true when >= n are true
//   action     {action: "enter" | "exit" | "size" | "gate", ...}
// Unknown fields, operators, keys or out-of-bounds param values are rejected at load.
//
// FAMILY_SPECS is the v1 rule table: one entry per family F1-F6 of spec 07 §7.4, kept in step with
// ./rules.ts and ./exits.ts (the tests check that its param references are exactly the family's
// Lane-B keys and that its literals equal the registry's fixed keys). docs/rule_schema.md is
// generated from this module by scripts/learning/genRuleSchema.mjs and checked by a test.
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import type { Family } from "../schema";

export const RULE_SCHEMA_VERSION = 1;

/** KB-010: the fixed operator set. */
export const RULE_OPERATORS = [
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "crosses_above",
  "crosses_below",
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

/** KB-010: actions are tagged enter | exit | size | gate. */
export const RULE_ACTIONS = ["enter", "exit", "size", "gate"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const RULE_TIERS = ["U1", "U2", "U3"] as const;
export const RULE_REGIMES = ["RISK-ON", "NEUTRAL", "RISK-OFF", "SHOCK", "unknown"] as const;
export const EXIT_KINDS = ["IS", "CS"] as const;
export const GATE_EFFECTS = ["block_entry", "half_size", "cancel_at_fill"] as const;
export const RANK_ORDERS = ["asc", "desc"] as const;

export type FieldType = "number" | "bool" | "enum";
export type RuleField = {
  readonly name: string;
  readonly type: FieldType;
  /** Where the field is defined: AGT-020 (events), AGT-030 (indicators), DAT-170, position, class. */
  readonly source: string;
  readonly description: string;
  readonly values?: readonly string[];
};

/**
 * The allowed `field` vocabulary (KB-010 s13): the indicator and event fields of AGT-020 and
 * AGT-030, the position fields exits are written over, and the F6 evidence classes. Parameters are
 * never fields: they are `param` references to ch.15 §15.3 keys.
 */
export const RULE_FIELDS: readonly RuleField[] = [
  // AGT-030 indicators (adjusted closes, highs, lows)
  {
    name: "close_above_sma200",
    type: "bool",
    source: "AGT-030",
    description: "Close above SMA(200)",
  },
  { name: "close_above_sma5", type: "bool", source: "AGT-030", description: "Close above SMA(5)" },
  {
    name: "new_high_sessions",
    type: "number",
    source: "AGT-030",
    description:
      "Longest window, in sessions, for which today's close is at least the maximum close of the previous sessions (a 250-session high when it is 250 or more)",
  },
  {
    name: "volume_ratio",
    type: "number",
    source: "AGT-030",
    description: "Today's volume divided by the mean volume of the previous 20 sessions",
  },
  {
    name: "return_6m_top_fraction",
    type: "number",
    source: "AGT-030",
    description:
      "Share of the tier whose 6-month return is at or above this code's (0.2 = top 20 %)",
  },
  {
    name: "adv_filter_ok",
    type: "bool",
    source: "AGT-030",
    description: "The tier ADV and price minimums are met",
  },
  { name: "rsi2", type: "number", source: "AGT-030", description: "RSI(2), Wilder" },
  { name: "rsi14", type: "number", source: "AGT-030", description: "RSI(14), Wilder" },
  {
    name: "day_range_position",
    type: "number",
    source: "AGT-030",
    description: "(close - low) / (high - low), 0.5 if high = low",
  },
  {
    name: "close_above_prior_close",
    type: "bool",
    source: "AGT-030",
    description: "Close above the prior close",
  },
  // AGT-020 events
  {
    name: "event_polarity",
    type: "number",
    source: "AGT-020",
    description: "Polarity of the event group: -1, 0 or +1",
  },
  {
    name: "event_ar_day0_pct",
    type: "number",
    source: "AGT-020",
    description: "Day-0 abnormal return, percent",
  },
  {
    name: "event_volume_ratio_day0",
    type: "number",
    source: "AGT-020",
    description: "Day-0 volume ratio",
  },
  {
    name: "event_age_sessions",
    type: "number",
    source: "AGT-020",
    description: "Sessions since day 0 of the event",
  },
  {
    name: "event_price_sensitive",
    type: "bool",
    source: "AGT-020",
    description: "The event is price-sensitive",
  },
  {
    name: "event_catalyst_results_or_guidance_up",
    type: "bool",
    source: "AGT-020",
    description: "The event is a results or guidance-up event",
  },
  {
    name: "event_qualifies_f3",
    type: "bool",
    source: "AGT-020",
    description: "The event is results, contract win, guidance up or takeover target",
  },
  {
    name: "negative_event_last_3_sessions",
    type: "bool",
    source: "AGT-020",
    description: "A negative-polarity event in the last 3 sessions",
  },
  {
    name: "open_gap_above_day0_close_pct",
    type: "number",
    source: "AGT-020",
    description: "Next open above the day-0 close, percent",
  },
  // DAT-170 fundamentals (point-in-time, where available; a missing value does not pass the condition)
  {
    name: "eps_trailing_positive",
    type: "bool",
    source: "DAT-170",
    description: "Trailing earnings are positive",
  },
  {
    name: "pe_below_sector_median",
    type: "bool",
    source: "DAT-170",
    description: "P/E below the median of its GICS sector",
  },
  {
    name: "net_debt_ebitda",
    type: "number",
    source: "DAT-170",
    description: "Net debt divided by EBITDA",
  },
  // Position fields (exits)
  {
    name: "sessions_held",
    type: "number",
    source: "position",
    description: "Sessions since the entry fill",
  },
  {
    name: "return_since_entry_pct",
    type: "number",
    source: "position",
    description: "Close return since the entry fill, percent",
  },
  {
    name: "max_gain_since_entry_pct",
    type: "number",
    source: "position",
    description: "Highest close return since the entry fill, percent",
  },
  {
    name: "loss_atr_from_entry",
    type: "number",
    source: "position",
    description: "Fall of the low below the entry fill, in ATR(20) units",
  },
  {
    name: "loss_pct_from_entry",
    type: "number",
    source: "position",
    description: "Fall of the low below the entry fill, percent",
  },
  {
    name: "drawdown_atr_from_high_close",
    type: "number",
    source: "position",
    description: "Fall of the low below the highest close since entry, in ATR(20) units",
  },
  {
    name: "low_below_event_low",
    type: "bool",
    source: "position",
    description: "Intraday low below the day-0 low of the entry event",
  },
  {
    name: "close_below_event_low",
    type: "bool",
    source: "position",
    description: "Close below the day-0 low of the entry event",
  },
  {
    name: "guidance_down_since_entry",
    type: "bool",
    source: "position",
    description: "A guidance-down event since the entry fill",
  },
  {
    name: "negative_event_since_entry",
    type: "bool",
    source: "position",
    description: "A negative-polarity event since the entry fill",
  },
  {
    name: "volume_ratio_dry_up_sessions",
    type: "number",
    source: "position",
    description: "Consecutive sessions with volume ratio below the dry-up ratio",
  },
  {
    name: "contributing_family_exit",
    type: "bool",
    source: "position",
    description: "The earliest exit of any contributing (a)/(b) family has triggered",
  },
  // F6 evidence classes (spec 07 §7.4 F6)
  {
    name: "class_technical",
    type: "bool",
    source: "class (a)",
    description: "Evidence class (a): an F1 or F4 signal on the code",
  },
  {
    name: "class_event",
    type: "bool",
    source: "class (b)",
    description: "Evidence class (b): an F2, F3 or F5 signal on the code (one event counts once)",
  },
  {
    name: "class_insider_score",
    type: "number",
    source: "class (c)",
    description: "Evidence class (c): insider/flow score (known, not unknown)",
  },
  {
    name: "class_short_drop_pp",
    type: "number",
    source: "class (d)",
    description: "Evidence class (d): fall of short interest over 10 sessions, percentage points",
  },
  // Context
  {
    name: "regime",
    type: "enum",
    source: "AGT-101",
    description: "Regime state at the decision session",
    values: RULE_REGIMES,
  },
  {
    name: "tier",
    type: "enum",
    source: "DAT-130",
    description: "Universe tier of the code",
    values: RULE_TIERS,
  },
  {
    name: "arn011_pass",
    type: "bool",
    source: "ARN-011",
    description: "No ARN-011 filter blocks the entry",
  },
];

const FIELD_BY_NAME: ReadonlyMap<string, RuleField> = new Map(RULE_FIELDS.map((f) => [f.name, f]));

// ---- spec types ----------------------------------------------------------------------------------

export type ParamRef = { readonly param: string };
export type RuleCondition =
  | { readonly field: string; readonly op: RuleOperator; readonly value: number | boolean | string }
  | { readonly field: string; readonly op: RuleOperator; readonly param: string };
export type RuleGroup = { readonly logic: "AND" | "OR"; readonly items: readonly RuleNode[] };
export type RuleCountOf = {
  readonly count_of: { readonly n: number | ParamRef; readonly items: readonly RuleCondition[] };
};
export type RuleNode = RuleCondition | RuleGroup | RuleCountOf;

export type RuleActionSpec =
  | {
      readonly action: "gate";
      readonly id: string;
      readonly effect: (typeof GATE_EFFECTS)[number];
      readonly when: RuleNode;
    }
  | { readonly action: "enter"; readonly when: RuleNode }
  | {
      readonly action: "exit";
      readonly id: string;
      readonly kind: (typeof EXIT_KINDS)[number];
      readonly when: RuleNode;
    }
  | {
      readonly action: "size";
      readonly rule: "FAM-001";
      readonly half_size_regimes: readonly string[];
    };

export type RuleSpec = {
  readonly schema_version: typeof RULE_SCHEMA_VERSION;
  readonly family: Family;
  readonly universe: readonly (typeof RULE_TIERS)[number][];
  /** The Lane-B keys that parameterise this family (the keys of params_json). */
  readonly params: readonly string[];
  readonly actions: readonly RuleActionSpec[];
  readonly rank: { readonly field: string; readonly order: (typeof RANK_ORDERS)[number] };
};

// ---- the v1 rule table (spec 07 §7.4) ----------------------------------------------------------------

const c = (field: string, op: RuleOperator, value: number | boolean | string): RuleCondition => ({
  field,
  op,
  value,
});
const p = (field: string, op: RuleOperator, param: string): RuleCondition => ({ field, op, param });
const and = (...items: RuleNode[]): RuleGroup => ({ logic: "AND", items });
const or = (...items: RuleNode[]): RuleGroup => ({ logic: "OR", items });
/** Regime gate: an entry is allowed only in the states that are not blocked (spec 07 §7.4). */
const gateBlock = (id: string, blocked: readonly string[]): RuleActionSpec => ({
  action: "gate",
  id,
  effect: "block_entry",
  when: or(...RULE_REGIMES.filter((r) => !blocked.includes(r)).map((r) => c("regime", "==", r))),
});
const is = (id: string, when: RuleNode): RuleActionSpec => ({
  action: "exit",
  id,
  kind: "IS",
  when,
});
const cs = (id: string, when: RuleNode): RuleActionSpec => ({
  action: "exit",
  id,
  kind: "CS",
  when,
});
const sizeRule = (half: readonly string[] = []): RuleActionSpec => ({
  action: "size",
  rule: "FAM-001",
  half_size_regimes: half,
});

/** Lane-B keys shared by every family. */
const COMMON_KEYS = ["reentry_block"] as const;

function specOf(
  family: Family,
  universe: RuleSpec["universe"],
  keys: readonly string[],
  actions: readonly RuleActionSpec[],
  rank: RuleSpec["rank"],
): RuleSpec {
  return {
    schema_version: RULE_SCHEMA_VERSION,
    family,
    universe,
    params: [...keys, ...COMMON_KEYS].sort(),
    actions,
    rank,
  };
}

export const FAMILY_SPECS: Readonly<Record<Family, RuleSpec>> = {
  F1: specOf(
    "F1",
    ["U1", "U2"],
    [
      "f1_volume_ratio_min",
      "f1_rs_top_fraction",
      "f1_initial_stop_atr",
      "f1_trail_atr",
      "f1_time_stop",
      "f1_min_gain_pct",
      "f1_max_hold",
      "f1_high_lookback",
    ],
    [
      gateBlock("regime", ["RISK-OFF", "SHOCK", "unknown"]),
      {
        action: "enter",
        when: and(
          p("new_high_sessions", ">=", "f1_high_lookback"),
          p("volume_ratio", ">=", "f1_volume_ratio_min"),
          p("return_6m_top_fraction", "<=", "f1_rs_top_fraction"),
          c("adv_filter_ok", "==", true),
        ),
      },
      is("initial-stop", p("loss_atr_from_entry", ">=", "f1_initial_stop_atr")),
      is("trailing-stop", p("drawdown_atr_from_high_close", ">=", "f1_trail_atr")),
      cs(
        "slow-gain",
        and(
          p("sessions_held", ">=", "f1_time_stop"),
          p("return_since_entry_pct", "<", "f1_min_gain_pct"),
        ),
      ),
      cs("max-hold", p("sessions_held", ">=", "f1_max_hold")),
      sizeRule(),
    ],
    { field: "return_6m_top_fraction", order: "asc" },
  ),
  F2: specOf(
    "F2",
    ["U1", "U2"],
    [
      "f2_event_ar_min_pct",
      "f2_lookback_sessions",
      "f2_stop_atr",
      "f2_time_stop",
      "event_polarity_threshold_pct",
    ],
    [
      gateBlock("regime", ["SHOCK", "unknown"]),
      {
        action: "enter",
        when: and(
          c("eps_trailing_positive", "==", true),
          c("pe_below_sector_median", "==", true),
          c("net_debt_ebitda", "<", 2), // threshold-ok: spec 07 §7.4 F2 net debt/EBITDA < 2
          c("event_catalyst_results_or_guidance_up", "==", true),
          c("event_polarity", "==", 1),
          p("event_ar_day0_pct", ">=", "f2_event_ar_min_pct"),
          p("event_age_sessions", "<=", "f2_lookback_sessions"),
        ),
      },
      is("initial-stop", p("loss_atr_from_entry", ">=", "f2_stop_atr")),
      cs("guidance-down", c("guidance_down_since_entry", "==", true)),
      cs("event-low", c("close_below_event_low", "==", true)),
      cs("time-exit", p("sessions_held", ">=", "f2_time_stop")),
      sizeRule(),
    ],
    { field: "event_ar_day0_pct", order: "desc" },
  ),
  F3: specOf(
    "F3",
    ["U1", "U2"],
    [
      "f3_event_ar_min_pct",
      "f3_volume_ratio_min",
      "f3_max_gap_pct",
      "f3_trail_after_pct",
      "f3_trail_atr",
      "f3_time_exit",
      "event_polarity_threshold_pct",
    ],
    [
      gateBlock("regime", ["SHOCK", "unknown"]),
      {
        action: "gate",
        id: "gap-cancel",
        effect: "cancel_at_fill",
        when: p("open_gap_above_day0_close_pct", "<", "f3_max_gap_pct"),
      },
      {
        action: "enter",
        when: and(
          c("event_price_sensitive", "==", true),
          c("event_qualifies_f3", "==", true),
          c("event_polarity", "==", 1),
          p("event_ar_day0_pct", ">=", "f3_event_ar_min_pct"),
          p("event_volume_ratio_day0", ">=", "f3_volume_ratio_min"),
        ),
      },
      is("event-low", c("low_below_event_low", "==", true)),
      is(
        "trailing-stop",
        and(
          p("max_gain_since_entry_pct", ">=", "f3_trail_after_pct"),
          p("drawdown_atr_from_high_close", ">=", "f3_trail_atr"),
        ),
      ),
      cs("time-exit", p("sessions_held", ">=", "f3_time_exit")),
      sizeRule(),
    ],
    { field: "event_ar_day0_pct", order: "desc" },
  ),
  F4: specOf(
    "F4",
    ["U1"],
    ["f4_rsi2_max", "f4_rsi14_max", "f4_time_exit", "f4_stop_atr", "event_polarity_threshold_pct"],
    [
      gateBlock("regime", ["unknown"]),
      {
        action: "enter",
        when: and(
          c("close_above_sma200", "==", true),
          or(p("rsi2", "<", "f4_rsi2_max"), p("rsi14", "<", "f4_rsi14_max")),
          c("negative_event_last_3_sessions", "==", false),
        ),
      },
      cs("sma5", c("close_above_sma5", "==", true)),
      cs("time-exit", p("sessions_held", ">=", "f4_time_exit")),
      is("initial-stop", p("loss_atr_from_entry", ">=", "f4_stop_atr")),
      sizeRule(["SHOCK"]),
    ],
    { field: "rsi2", order: "asc" },
  ),
  F5: specOf(
    "F5",
    ["U2", "U3"],
    [
      "f5_volume_ratio_min",
      "f5_ar_min_pct",
      "f5_range_pos_min",
      "f5_stop_atr",
      "f5_stop_cap_pct",
      "f5_trail_atr",
      "f5_time_stop",
      "event_polarity_threshold_pct",
    ],
    [
      gateBlock("regime", ["RISK-OFF", "SHOCK", "unknown"]),
      {
        action: "enter",
        when: and(
          p("volume_ratio", ">=", "f5_volume_ratio_min"),
          c("event_price_sensitive", "==", true),
          c("event_polarity", "==", 1),
          p("event_ar_day0_pct", ">=", "f5_ar_min_pct"),
          c("close_above_prior_close", "==", true),
          p("day_range_position", ">=", "f5_range_pos_min"),
          c("adv_filter_ok", "==", true),
          c("arn011_pass", "==", true),
        ),
      },
      is("initial-stop", p("loss_atr_from_entry", ">=", "f5_stop_atr")),
      is("stop-cap", p("loss_pct_from_entry", ">=", "f5_stop_cap_pct")),
      is("trailing-stop", p("drawdown_atr_from_high_close", ">=", "f5_trail_atr")),
      cs("volume-dry-up", c("volume_ratio_dry_up_sessions", ">=", 3)), // threshold-ok: equals f5_dry_up_sessions (checked by a test)
      cs("negative-event", c("negative_event_since_entry", "==", true)),
      cs("time-exit", p("sessions_held", ">=", "f5_time_stop")),
      sizeRule(),
    ],
    { field: "volume_ratio", order: "desc" },
  ),
  F6: specOf(
    "F6",
    ["U1", "U2"],
    [
      "f6_min_classes",
      "f6_insider_min",
      "f6_short_drop_pp",
      "f6_stop_atr",
      "f6_time_stop",
      "insider_score_weights",
      "insider_window_sessions",
      "event_polarity_threshold_pct",
    ],
    [
      gateBlock("regime", ["RISK-OFF", "SHOCK", "unknown"]),
      {
        action: "enter",
        when: and(
          {
            count_of: {
              n: { param: "f6_min_classes" },
              items: [
                c("class_technical", "==", true),
                c("class_event", "==", true),
                p("class_insider_score", ">=", "f6_insider_min"),
                p("class_short_drop_pp", ">=", "f6_short_drop_pp"),
              ],
            },
          },
          or(c("class_technical", "==", true), c("class_event", "==", true)),
        ),
      },
      is("initial-stop", p("loss_atr_from_entry", ">=", "f6_stop_atr")),
      cs("time-exit", p("sessions_held", ">=", "f6_time_stop")),
      cs("contributing-exit", c("contributing_family_exit", "==", true)),
      sizeRule(),
    ],
    { field: "class_insider_score", order: "desc" },
  ),
};

/** The Lane-B keys of each family, as the specs declare them. */
export const FAMILY_PARAM_KEYS: Readonly<Record<Family, readonly string[]>> = {
  F1: FAMILY_SPECS.F1.params,
  F2: FAMILY_SPECS.F2.params,
  F3: FAMILY_SPECS.F3.params,
  F4: FAMILY_SPECS.F4.params,
  F5: FAMILY_SPECS.F5.params,
  F6: FAMILY_SPECS.F6.params,
};

// ---- the loader check -------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Deepest nesting of groups the loader accepts (D-111). */
const MAX_DEPTH = 6; // threshold-ok: loader nesting limit, not a rule
const FAMILIES: readonly string[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

/** [min, max] of a Lane-B key, or null when it is not a ranged key. */
export function paramBounds(key: string): readonly [number, number] | null {
  const def = (CONFIG_KEYS as Record<string, { range?: readonly [number, number] }>)[key];
  return def?.range ?? null;
}

type Ctx = {
  errors: string[];
  declared: ReadonlySet<string>;
  params: Readonly<Record<string, unknown>> | null;
};

function checkParamRef(key: unknown, where: string, ctx: Ctx): void {
  if (typeof key !== "string") {
    ctx.errors.push(`${where}: param must be a key name`);
    return;
  }
  if (!ctx.declared.has(key)) {
    ctx.errors.push(`${where}: param ${key} is not declared in params`);
    return;
  }
  const b = paramBounds(key);
  if (b === null) {
    ctx.errors.push(`${where}: param ${key} has no bounds in ch.15`);
    return;
  }
  if (ctx.params !== null) {
    const v = ctx.params[key];
    if (typeof v !== "number" || !Number.isFinite(v))
      ctx.errors.push(`${where}: ${key} has no numeric value`);
    else if (v < b[0] || v > b[1])
      ctx.errors.push(`${where}: ${key}=${v} outside bounds ${b[0]}..${b[1]}`);
  }
}

function checkCondition(n: Record<string, unknown>, where: string, ctx: Ctx): void {
  const keys = Object.keys(n).sort().join(",");
  if (keys !== "field,op,param" && keys !== "field,op,value") {
    ctx.errors.push(`${where}: a condition has exactly field, op and one of value or param`);
    return;
  }
  const field = typeof n.field === "string" ? FIELD_BY_NAME.get(n.field) : undefined;
  if (field === undefined) ctx.errors.push(`${where}: unknown field ${String(n.field)}`);
  if (!(RULE_OPERATORS as readonly unknown[]).includes(n.op)) {
    ctx.errors.push(`${where}: unknown operator ${String(n.op)}`);
  } else if (
    (n.op === "crosses_above" || n.op === "crosses_below") &&
    field !== undefined &&
    field.type !== "number"
  ) {
    ctx.errors.push(`${where}: ${String(n.op)} needs a numeric field`);
  }
  if ("param" in n) {
    if (field !== undefined && field.type !== "number")
      ctx.errors.push(`${where}: a param reference needs a numeric field`);
    checkParamRef(n.param, where, ctx);
    return;
  }
  const v = n.value;
  if (field === undefined) return;
  if (field.type === "number" && !(typeof v === "number" && Number.isFinite(v))) {
    ctx.errors.push(`${where}: ${field.name} compares with a number`);
  } else if (field.type === "bool" && typeof v !== "boolean") {
    ctx.errors.push(`${where}: ${field.name} compares with true or false`);
  } else if (field.type === "enum") {
    if (typeof v !== "string" || !(field.values ?? []).includes(v)) {
      ctx.errors.push(
        `${where}: ${field.name} compares with one of ${(field.values ?? []).join(", ")}`,
      );
    }
  }
}

function checkNode(n: unknown, where: string, ctx: Ctx, depth: number): void {
  if (depth > MAX_DEPTH) {
    ctx.errors.push(`${where}: nested more than ${MAX_DEPTH} levels`);
    return;
  }
  if (!isObj(n)) {
    ctx.errors.push(`${where}: a node is an object`);
    return;
  }
  if ("logic" in n || "items" in n) {
    const ks = Object.keys(n).sort().join(",");
    if (ks !== "items,logic") {
      ctx.errors.push(
        `${where}: a group has exactly logic and items (AND and OR are never mixed at one level)`,
      );
      return;
    }
    if (n.logic !== "AND" && n.logic !== "OR") ctx.errors.push(`${where}: logic is AND or OR`);
    if (!Array.isArray(n.items) || n.items.length < 1) {
      ctx.errors.push(`${where}: a group has at least one item`);
      return;
    }
    n.items.forEach((x, i) => checkNode(x, `${where}.items[${i}]`, ctx, depth + 1));
    return;
  }
  if ("count_of" in n) {
    if (Object.keys(n).length !== 1 || !isObj(n.count_of)) {
      ctx.errors.push(`${where}: count_of stands alone`);
      return;
    }
    const co = n.count_of;
    if (Object.keys(co).sort().join(",") !== "items,n") {
      ctx.errors.push(`${where}: count_of has exactly n and items`);
      return;
    }
    const items = Array.isArray(co.items) ? co.items : [];
    if (items.length < 1) ctx.errors.push(`${where}: count_of lists at least one condition`);
    items.forEach((x, i) => {
      if (isObj(x) && ("logic" in x || "count_of" in x))
        ctx.errors.push(`${where}.items[${i}]: count_of lists conditions only`);
      else checkNode(x, `${where}.items[${i}]`, ctx, depth + 1);
    });
    if (isObj(co.n)) {
      if (Object.keys(co.n).join(",") !== "param")
        ctx.errors.push(`${where}: n is a number or {param}`);
      else checkParamRef(co.n.param, `${where}.n`, ctx);
    } else if (!(
      typeof co.n === "number" &&
      Number.isInteger(co.n) &&
      co.n >= 1 &&
      co.n <= items.length
    )) {
      ctx.errors.push(`${where}: n is a whole number from 1 to the number of conditions`);
    }
    return;
  }
  checkCondition(n, where, ctx);
}

/**
 * Loader check of a rule spec (KB-010 s11/s13). Returns the problems found; an empty list means the
 * spec conforms. With `params` (the params_json of the version) every referenced value is also
 * checked against its ch.15 bounds. Never throws.
 */
export function validateRuleSpec(
  spec: unknown,
  params: Readonly<Record<string, unknown>> | null = null,
): string[] {
  const errors: string[] = [];
  if (!isObj(spec)) return ["spec must be an object"];
  const keys = Object.keys(spec).sort().join(",");
  if (keys !== "actions,family,params,rank,schema_version,universe") {
    errors.push("spec has exactly schema_version, family, universe, params, actions and rank");
    return errors;
  }
  if (spec.schema_version !== RULE_SCHEMA_VERSION)
    errors.push(`schema_version must be ${RULE_SCHEMA_VERSION}`);
  if (typeof spec.family !== "string" || !FAMILIES.includes(spec.family))
    errors.push("unknown family");
  const uni = spec.universe;
  if (
    !Array.isArray(uni) ||
    uni.length < 1 ||
    !uni.every((t) => (RULE_TIERS as readonly unknown[]).includes(t))
  ) {
    errors.push(`universe must list tiers from ${RULE_TIERS.join(", ")}`);
  }
  const declared = new Set<string>();
  if (!Array.isArray(spec.params)) errors.push("params must list the family's Lane-B keys");
  else {
    for (const k of spec.params) {
      if (
        typeof k !== "string" ||
        (CONFIG_KEYS as Record<string, { editable: string }>)[k]?.editable !== "B"
      ) {
        errors.push(`params: ${String(k)} is not a Lane-B key`);
      } else declared.add(k);
    }
    if (typeof spec.family === "string" && FAMILIES.includes(spec.family)) {
      const want = FAMILY_PARAM_KEYS[spec.family as Family];
      for (const k of want) if (!declared.has(k)) errors.push(`params: missing ${k}`);
      for (const k of declared)
        if (!want.includes(k)) errors.push(`params: ${k} is not a key of ${spec.family}`);
    }
  }
  const rank = spec.rank;
  if (!isObj(rank) || Object.keys(rank).sort().join(",") !== "field,order")
    errors.push("rank has exactly field and order");
  else {
    if (typeof rank.field !== "string" || !FIELD_BY_NAME.has(rank.field))
      errors.push(`rank: unknown field ${String(rank.field)}`);
    if (!(RANK_ORDERS as readonly unknown[]).includes(rank.order))
      errors.push("rank: order is asc or desc");
  }
  const ctx: Ctx = { errors, declared, params };
  if (!Array.isArray(spec.actions) || spec.actions.length < 1) {
    errors.push("actions must be a non-empty list");
    return errors;
  }
  let enters = 0;
  let exits = 0;
  let sizes = 0;
  spec.actions.forEach((a, i) => {
    const where = `actions[${i}]`;
    if (!isObj(a)) {
      errors.push(`${where}: an action is an object`);
      return;
    }
    if (!(RULE_ACTIONS as readonly unknown[]).includes(a.action)) {
      errors.push(`${where}: unknown action ${String(a.action)}`);
      return;
    }
    const ks = Object.keys(a).sort().join(",");
    switch (a.action) {
      case "enter":
        enters += 1;
        if (ks !== "action,when") errors.push(`${where}: enter has exactly action and when`);
        else checkNode(a.when, `${where}.when`, ctx, 0);
        break;
      case "exit":
        exits += 1;
        if (ks !== "action,id,kind,when")
          errors.push(`${where}: exit has exactly action, id, kind and when`);
        else {
          if (!(EXIT_KINDS as readonly unknown[]).includes(a.kind))
            errors.push(`${where}: kind is IS or CS`);
          checkNode(a.when, `${where}.when`, ctx, 0);
        }
        break;
      case "gate":
        if (ks !== "action,effect,id,when")
          errors.push(`${where}: gate has exactly action, id, effect and when`);
        else {
          if (!(GATE_EFFECTS as readonly unknown[]).includes(a.effect))
            errors.push(`${where}: unknown gate effect`);
          checkNode(a.when, `${where}.when`, ctx, 0);
        }
        break;
      case "size":
        sizes += 1;
        if (ks !== "action,half_size_regimes,rule" || a.rule !== "FAM-001") {
          errors.push(`${where}: size has exactly action, rule FAM-001 and half_size_regimes`);
        } else if (
          !Array.isArray(a.half_size_regimes) ||
          !a.half_size_regimes.every((r) => (RULE_REGIMES as readonly unknown[]).includes(r))
        ) {
          errors.push(`${where}: half_size_regimes lists regime states`);
        }
        break;
    }
  });
  if (enters !== 1) errors.push("exactly one enter action is required");
  if (exits < 1) errors.push("at least one exit action is required");
  if (sizes !== 1) errors.push("exactly one size action is required");
  return errors;
}

/** Canonical JSON of a spec (what rule_version.spec_json stores). */
export function ruleSpecJson(family: Family): string {
  return JSON.stringify(FAMILY_SPECS[family]);
}

// ---- generated reference ----------------------------------------------------------------------------

const cell = (s: string): string => s.replace(/\|/g, "\\|");

/** The text of docs/rule_schema.md: generated, never hand-edited (scripts/learning/genRuleSchema.mjs). */
export function renderRuleSchemaDoc(): string {
  const out: string[] = [];
  out.push("# Rule schema v1 (generated)");
  out.push("");
  out.push(
    "<!-- Generated by scripts/learning/genRuleSchema.mjs from src/lib/agents/families/ruleSchema.ts. Do not edit by hand; a test fails when this file is stale. -->",
  );
  out.push("");
  out.push(
    "KB-010: a family rule version is a declarative specification; parameters are the only degree of freedom in M6 (a structural change is a new lineage, FAM-101). The loader rejects unknown fields, operators and keys, mixed AND/OR at one level, and parameter values outside their ch.15 bounds.",
  );
  out.push("");
  out.push("## Shape");
  out.push("");
  out.push(
    "- condition: `{field, op, value}` or `{field, op, param}`; `param` names a Lane-B key of the family.",
  );
  out.push(
    '- group: `{logic: "AND" | "OR", items: [...]}`; groups are explicit, one logic per group.',
  );
  out.push(
    "- count_of: `{count_of: {n: number | {param}, items: [condition, ...]}}`, true when at least n conditions are true.",
  );
  out.push(
    `- actions: ${RULE_ACTIONS.map((a) => `\`${a}\``).join(", ")}; exits are tagged \`IS\` (intraday stop) or \`CS\` (close signal).`,
  );
  out.push(`- operators: ${RULE_OPERATORS.map((o) => `\`${o}\``).join(", ")}.`);
  out.push(
    `- universe tiers: ${RULE_TIERS.join(", ")}; regime states: ${RULE_REGIMES.join(", ")}.`,
  );
  out.push("");
  out.push("## Field vocabulary");
  out.push("");
  out.push("| Field | Type | Source | Meaning |");
  out.push("|---|---|---|---|");
  for (const f of RULE_FIELDS) {
    const t = f.type === "enum" ? `enum (${(f.values ?? []).join(", ")})` : f.type;
    out.push(`| \`${f.name}\` | ${cell(t)} | ${f.source} | ${cell(f.description)} |`);
  }
  out.push("");
  out.push("## Parameters per family (Lane-B keys and their ch.15 bounds)");
  for (const fam of FAMILIES as Family[]) {
    const spec = FAMILY_SPECS[fam];
    out.push("");
    out.push(`### ${fam}`);
    out.push("");
    out.push(
      `Universe: ${spec.universe.join(", ")}. Rank: \`${spec.rank.field}\` ${spec.rank.order}.`,
    );
    out.push("");
    out.push("| Key | Default | Bounds | Unit |");
    out.push("|---|---|---|---|");
    for (const k of spec.params) {
      const def = (
        CONFIG_KEYS as Record<
          string,
          { default: unknown; unit: string; range?: readonly [number, number] }
        >
      )[k];
      const b = def.range === undefined ? "object" : `${def.range[0]} to ${def.range[1]}`;
      out.push(`| \`${k}\` | ${cell(JSON.stringify(def.default))} | ${b} | ${cell(def.unit)} |`);
    }
    out.push("");
    out.push("```json");
    out.push(JSON.stringify(spec, null, 2));
    out.push("```");
  }
  out.push("");
  return out.join("\n");
}

/** Keys the specs reference, for tests and the seed. */
export const ALL_SPEC_KEYS: readonly ConfigKey[] = [
  ...new Set(Object.values(FAMILY_PARAM_KEYS).flat()),
].sort() as ConfigKey[];
