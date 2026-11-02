// Pure text builders of the Decision Card page (M7 T13; UXN-037, 100, 102, 120 to 123, 126; UX-041;
// D-128, D-129, D-135 draft). Everything is a fixed template filled from the stored card: no LLM, no
// clock, no database. Each builder takes `t`, the mask step of the viewer (identity for an unmasked
// viewer, maskText for a masked one), and runs every piece of stored free text through it, so a code,
// a company name, a price or an exact date never reaches a masked viewer. Past tense for history
// ("did"), never "will"; no probability and no number that is not on the card or in the ledger.
import type { DecisionCard } from "@/lib/agents/cards";
import { numericValue } from "@/lib/learning/factorValue";
import { formatPpm } from "@/lib/view/format";
import { regimeLabel, validationLabel } from "@/lib/view/terms";

export type Mask = (s: string) => string;

const DECIMALS = 100; // threshold-ok: two decimals for a displayed ratio
const JUST_MET_FRACTION = 10; // threshold-ok: UXN-122 "within 10 % of the threshold"
const PPM_PER_POINT = 10_000; // threshold-ok: ppm in one percentage point

// ---- rule wording ----------------------------------------------------------------------------------

const RULE_WORDS: Readonly<Record<string, string>> = {
  atr_warm: "Enough price history to measure the usual daily swings",
  high_lookback: "The share price is at a new long-term high",
  volume_ratio: "Trading volume is above its usual level",
  rs_top_fraction: "The share has been rising faster than most others",
  day0_volume_ratio: "Trading volume on the news day was far above usual",
  close_above_sma_trend: "The share price is above its long-term trend",
  oversold: "The share has fallen sharply in the last few days",
  no_negative_event: "There has been no negative company news lately",
  close_above_prior_close: "The share closed higher than the day before",
  range_position: "The share closed near the top of the day's range",
  evidence_classes: "Several kinds of evidence point the same way",
  technical_or_event: "A price signal or a company announcement backs it up",
};

/** Plain words for a rule id; an unknown id is shown with spaces (and goes through the mask). */
export function ruleWords(id: string): string {
  if (Object.hasOwn(RULE_WORDS, id)) return RULE_WORDS[id]!;
  if (id.startsWith("event_")) return "A positive company announcement";
  return id.replaceAll("_", " ");
}

/** True for the rules that rest on a company announcement (their "Based on" line gets a news link). */
export const isNewsRule = (id: string): boolean =>
  id.startsWith("event_") || id === "technical_or_event" || id === "day0_volume_ratio";

const fmtNum = (n: number): string => String(Math.round(n * DECIMALS) / DECIMALS);

const OPS = [">=", "<=", ">", "<"] as const;
type Op = (typeof OPS)[number];
const OP_WORDS: Readonly<Record<Op, string>> = {
  ">=": "at least",
  "<=": "at most",
  ">": "above",
  "<": "below",
};

export function parseThreshold(th: string): { op: Op; value: number } | null {
  const s = th.trim();
  for (const op of OPS) {
    if (!s.startsWith(op)) continue;
    const v = numericValue(s.slice(op.length).trim());
    return v === null ? null : { op, value: v };
  }
  return null;
}

/** Margin to the threshold (positive = room left) and whether a passed rule was only just met (UXN-122). */
export function ruleMargin(
  value: string,
  threshold: string,
  pass: boolean,
): { margin: number; justMet: boolean } | null {
  const th = parseThreshold(threshold);
  const v = numericValue(value.trim());
  if (th === null || v === null) return null;
  const raw = th.op === ">=" || th.op === ">" ? v - th.value : th.value - v;
  const margin = Math.round(raw * DECIMALS) / DECIMALS; // two decimals: 6.1 against 10 is exactly 3.9
  const justMet =
    pass && th.value !== 0 && Math.abs(margin) * JUST_MET_FRACTION <= Math.abs(th.value);
  return { margin, justMet };
}

export type ChecklistRow = {
  label: string;
  value: string;
  /** "needed at least 1.5", or the stored threshold text; null when there is none to show. */
  needed: string | null;
  margin: string | null;
  pass: boolean;
  justMet: boolean;
};

export function checklist(card: DecisionCard, t: Mask): ChecklistRow[] {
  return card.rules_fired.map((r) => {
    const label = t(ruleWords(r.rule));
    if (r.rule === "atr_warm") {
      return {
        label,
        value: r.pass ? "Yes" : "No",
        needed: null,
        margin: null,
        pass: r.pass,
        justMet: false,
      };
    }
    const th = parseThreshold(r.threshold);
    const m = ruleMargin(r.value, r.threshold, r.pass);
    const num = numericValue(r.value.trim());
    const value =
      r.value === "true"
        ? "Yes"
        : r.value === "false"
          ? "No"
          : num !== null
            ? fmtNum(num)
            : t(r.value);
    return {
      label,
      value,
      needed: th ? `${OP_WORDS[th.op]} ${fmtNum(th.value)}` : t(r.threshold),
      margin: m === null ? null : fmtNum(m.margin),
      pass: r.pass,
      justMet: m?.justMet ?? false,
    };
  });
}

// ---- validation label ------------------------------------------------------------------------------

const LABEL_MEANING: Readonly<Record<string, string>> = {
  UNVALIDATED: "this strategy is not yet proven better than luck",
  "PASSED-BACKTEST": "it worked on past test data but is not yet confirmed in live practice",
  "CONSISTENT-FORWARD": "live practice has so far matched the past tests",
  FAILED: "it did not hold up when it was tested",
  "NOT-DEMONSTRATED": "no real edge over luck has been found",
  UNVALIDATABLE: "there is not enough data to test it yet",
};

/** The label to show; a strategy with no stored label is treated as not proven (never as proven). */
export const labelOrDefault = (label: string | null): string => label ?? "UNVALIDATED";

export function validationMeaning(label: string | null): string {
  const l = labelOrDefault(label);
  return `${l} — ${LABEL_MEANING[l] ?? LABEL_MEANING.UNVALIDATED}`;
}

/** UXN-037: one line on the evidence level, in plain words. */
export function evidenceLine(label: string | null): string {
  const l = labelOrDefault(label);
  if (l === "UNVALIDATED") {
    return "This strategy is not proven yet — treat this as a learning example.";
  }
  return `Evidence level: ${validationLabel(l).shown}. ${LABEL_MEANING[l] ?? ""}`.trim();
}

const NEEDS_CAVEAT = new Set(["UNVALIDATED", "PASSED-BACKTEST"]);
export const PAST_ONLY_CAVEAT =
  "Based on past test data only — not yet confirmed in forward running";

// ---- "Based on" (UXN-037) ----------------------------------------------------------------------------

export type BasedOnItem = { text: string; newsId: string | null };

const MAX_BASED_ON = 3; // threshold-ok: UXN-037 shows two to three reasons
const MIN_BASED_ON = 2; // threshold-ok: UXN-037 shows two to three reasons

/**
 * Two or three one-line reasons from the fired rules (ordered by the size of their factor contribution
 * when there is one, else by rule order), then the market mood, then the family thesis. A reason that
 * rests on a company announcement carries that announcement's id (the page links it for an unmasked
 * viewer only, since company news is hidden from a masked one).
 */
export function basedOn(
  card: DecisionCard,
  t: Mask,
  effectByRule: ReadonlyMap<string, number> = new Map(),
): BasedOnItem[] {
  const newsId = card.evidence.events[0]?.ann_id ?? null;
  const passed = card.rules_fired
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.pass && x.r.rule !== "atr_warm");
  passed.sort(
    (a, b) =>
      Math.abs(effectByRule.get(b.r.rule) ?? 0) - Math.abs(effectByRule.get(a.r.rule) ?? 0) ||
      a.i - b.i,
  );
  const out: BasedOnItem[] = passed.slice(0, MAX_BASED_ON).map(({ r }) => ({
    text: `${t(ruleWords(r.rule))}.`,
    newsId: isNewsRule(r.rule) ? newsId : null,
  }));
  const mood = regimeLabel(card.regime).shown;
  if (out.length < MAX_BASED_ON) {
    out.push({ text: `The overall market mood is: ${mood}.`, newsId: null });
  }
  if (out.length < MIN_BASED_ON) out.push({ text: t(card.thesis), newsId: null });
  return out;
}

// ---- what past similar setups did (UXN-120) --------------------------------------------------------

export type PastSetups = {
  state: "enough" | "insufficient";
  /** The summary sentence, or the "not enough history" sentence. */
  summary: string;
  /** Further lines (profitable share, holding time); empty when there is not enough history. */
  lines: string[];
  caveat: string | null;
};

const pct1 = (ppm: number | null): string => formatPpm(ppm, { sign: "always", digits: 1 });

export function pastSetups(
  card: DecisionCard,
  label: string | null,
  profitable: { k: number; n: number; lower: number; upper: number; level: number } | null,
): PastSetups {
  const s = card.scenario;
  const caveat = NEEDS_CAVEAT.has(labelOrDefault(label)) ? PAST_ONLY_CAVEAT : null;
  if (s.insufficient_history || s.p10_ppm === null || s.p50_ppm === null || s.p90_ppm === null) {
    return {
      state: "insufficient",
      summary: `Not enough history to say yet (n = ${s.n}).`,
      lines: [],
      caveat,
    };
  }
  const lines: string[] = [];
  if (profitable !== null && profitable.n > 0) {
    const whole = (x: number): number => Math.round(x * 100); // threshold-ok: percent
    lines.push(
      `${whole(profitable.k / profitable.n)}% were profitable (${whole(profitable.level)}% range ` +
        `${whole(profitable.lower)}–${whole(profitable.upper)}%, n = ${profitable.n}).`,
    );
  }
  lines.push("Typical holding time: not measured yet.");
  return {
    state: "enough",
    summary:
      `In ${s.n} past similar setups the typical result was ${pct1(s.p50_ppm)} after costs; ` +
      `1 in 10 did worse than ${pct1(s.p10_ppm)} and 1 in 10 did better than ${pct1(s.p90_ppm)}.`,
    lines,
    caveat,
  };
}

// ---- scenario table (UXN-100) ----------------------------------------------------------------------

export const SCENARIO_SENTENCE =
  "These are the 10th, 50th and 90th percentile results of this strategy's own past similar " +
  "trades after costs: 1 in 10 did worse than the bad case and 1 in 10 did better than the good case.";

export type ScenarioRow = { label: string; percentile: string; value: string };

export function scenarioRows(card: DecisionCard): ScenarioRow[] | null {
  const s = card.scenario;
  if (s.insufficient_history || s.p10_ppm === null || s.p50_ppm === null || s.p90_ppm === null) {
    return null;
  }
  return [
    { label: "Bad case", percentile: "10th percentile", value: pct1(s.p10_ppm) },
    { label: "Typical", percentile: "50th percentile", value: pct1(s.p50_ppm) },
    { label: "Good case", percentile: "90th percentile", value: pct1(s.p90_ppm) },
  ];
}

// ---- factors (UXN-121, AGT-112) ----------------------------------------------------------------------

export type FactorBucketRow = {
  factor: string;
  bucket: number;
  edges: readonly number[];
  n: number;
  medianNetPpm: number | null;
  familyMedianPpm: number | null;
};

export type FactorItem = {
  label: string;
  today: string;
  n: number;
  /** Signed percentage points vs the family's typical result; null = "not enough history". */
  effect: string | null;
  effectPpm: number | null;
  /** Bar length, 0 to 100 (relative to the largest effect shown). */
  barPct: number;
};

export type Factors = { up: FactorItem[]; down: FactorItem[]; notEnough: FactorItem[] };

export const FACTOR_CAPTION =
  "Historical association in this system's own replays — not cause and effect; patterns in past data that may not repeat.";

const points = (ppm: number): string => {
  const p = Math.round(ppm / (PPM_PER_POINT / 10)) / 10; // threshold-ok: one decimal of a point
  return `${p > 0 ? "+" : ""}${p} points`;
};

/**
 * Today's value of every factor falls in a stored development-split bucket; a bucket with fewer than
 * `minN` past trades reads "not enough history" and has no bar. Descriptive only (AGT-112).
 */
export function factorItems(
  card: DecisionCard,
  rows: readonly FactorBucketRow[],
  minN: number,
  t: Mask,
): Factors & { effectByRule: Map<string, number> } {
  const byFactor = new Map<string, FactorBucketRow[]>();
  for (const r of rows) byFactor.set(r.factor, [...(byFactor.get(r.factor) ?? []), r]);
  const effectByRule = new Map<string, number>();
  const items: Array<FactorItem & { effectPpm: number | null }> = [];
  for (const rule of card.rules_fired) {
    const list = byFactor.get(rule.rule);
    const v = numericValue(rule.value.trim());
    if (!list || v === null) continue;
    const bucket = 1 + list[0]!.edges.filter((e) => v > e).length;
    const row = list.find((x) => x.bucket === bucket);
    if (!row) continue;
    const enough = row.n >= minN && row.medianNetPpm !== null && row.familyMedianPpm !== null;
    const effect = enough ? row.medianNetPpm! - row.familyMedianPpm! : null;
    if (effect !== null) effectByRule.set(rule.rule, effect);
    items.push({
      label: t(ruleWords(rule.rule)),
      today: fmtNum(v),
      n: row.n,
      effect: effect === null ? null : points(effect),
      effectPpm: effect,
      barPct: 0,
    });
  }
  const maxAbs = Math.max(1, ...items.map((i) => Math.abs(i.effectPpm ?? 0)));
  for (const i of items) {
    i.barPct =
      i.effectPpm === null ? 0 : Math.max(1, Math.round((Math.abs(i.effectPpm) * 100) / maxAbs)); // threshold-ok: percent
  }
  const by = (a: FactorItem, b: FactorItem): number =>
    Math.abs(b.effectPpm ?? 0) - Math.abs(a.effectPpm ?? 0) || (a.label < b.label ? -1 : 1);
  return {
    up: items.filter((i) => (i.effectPpm ?? 0) > 0).sort(by),
    down: items.filter((i) => (i.effectPpm ?? 0) < 0).sort(by),
    notEnough: items.filter((i) => i.effectPpm === null),
    effectByRule,
  };
}

// ---- M14 wording: skip reasons, flags and event details (D-241) ------------------------------------

const NOT_TAKEN_WORDS: Readonly<Record<string, string>> = {
  skipped_stop_distance: "the stop would have been too far below the entry price",
  skipped_cost_gate:
    "trading costs would have eaten the usual gain of this kind of setup (cost gate)",
  second_position:
    "the first position of the night is in the same industry or moves too much like this one",
  abstain_shock: "the market was in a sharp shock and the order would have been below two parcels",
  index_change: "the share was joining or leaving a stock-market index around the news",
};

/** Plain words for a reason an order was not placed; an older reason is returned unchanged. */
export function notTakenText(reason: string): string {
  return Object.hasOwn(NOT_TAKEN_WORDS, reason) ? NOT_TAKEN_WORDS[reason]! : reason;
}

const FLAG_WORDS: Readonly<Record<string, string>> = {
  cost_gate_unmeasured:
    "Too few past results to check whether costs would eat the gain, so the cost check was not applied",
  industry_unknown:
    "The industry of this share is not known, so only how it moves with the other position was checked",
  corr_unknown:
    "Not enough price history to compare its moves with the other position, so only the industry was checked",
  event_reversed_next_close:
    "The share price reversed at the next close after the news (shown for information)",
};

/** Plain words for a card flag; an older flag is shown with spaces, as before. */
export function flagText(flag: string): string {
  return Object.hasOwn(FLAG_WORDS, flag) ? FLAG_WORDS[flag]! : flag.replaceAll("_", " ");
}

const EVENT_DETAIL_WORDS: Readonly<Record<string, string>> = {
  query_response: "Response to an ASX query",
  guidance_maintained: "Guidance maintained",
};

/** Plain words for an event detail (the nullable `event.category_detail`); null when none. */
export function eventDetailText(detail: string | null | undefined): string | null {
  return detail !== null && detail !== undefined && Object.hasOwn(EVENT_DETAIL_WORDS, detail)
    ? EVENT_DETAIL_WORDS[detail]!
    : null;
}

// ---- "What could hurt this" (UXN-123) ------------------------------------------------------------------

export type Headwind = { kind: string; text: string };

export function headwinds(
  card: DecisionCard,
  label: string | null,
  warnings: ReadonlyArray<{ id: string; status: "green" | "amber" | "red"; value: string }>,
  t: Mask,
): Headwind[] {
  const out: Headwind[] = [];
  if (card.cost.available && card.cost.break_even_ppm !== null) {
    out.push({
      kind: "Costs",
      text: `Costs take a bite: the trade has to gain ${formatPpm(card.cost.break_even_ppm, { digits: 2 })} just to break even.`,
    });
  }
  if (card.sizing.available && card.sizing.half_size) {
    out.push({
      kind: "Thin trading",
      text: "The position was cut to half size because the share trades thinly.",
    });
  }
  for (const reason of card.sizing.reasons) {
    out.push({ kind: "Sizing", text: `Sizing note: ${t(reason)}.` });
  }
  for (const w of warnings) {
    if (w.status === "green") continue;
    out.push({
      kind: w.status === "red" ? "Warning sign triggered" : "Warning sign to watch",
      text: `${t(w.id)}: ${t(w.value)}`,
    });
  }
  for (const f of [...card.evidence.data_quality_flags, ...card.evidence.other_flags]) {
    out.push({ kind: "Data flag", text: t(flagText(f)) });
  }
  if (card.scenario.insufficient_history) {
    out.push({
      kind: "Little history",
      text: `Only ${card.scenario.n} past similar setups: too few to judge.`,
    });
  }
  // The validation label is always there, so the block is never empty.
  out.push({ kind: "Evidence", text: validationMeaning(label) });
  return out;
}

// ---- "Why?" (UXN-102): rules-only ---------------------------------------------------------------------

export const WHY_LABEL = "Rules-only (AI unavailable today)";

export function whyLines(
  card: DecisionCard,
  rows: readonly ChecklistRow[],
  warnings: ReadonlyArray<{ id: string; status: "green" | "amber" | "red" }>,
  t: Mask,
): string[] {
  const lines = [t(card.thesis)];
  lines.push(
    rows.every((r) => r.pass)
      ? "Every rule on the checklist was met."
      : "Some rules on the checklist were not met; see the list.",
  );
  lines.push(`The overall market mood is: ${regimeLabel(card.regime).shown}.`);
  const live = warnings.filter((w) => w.status !== "green").map((w) => t(w.id));
  lines.push(
    live.length === 0
      ? "None of the warning signs has been triggered."
      : `Warning signs to watch: ${live.join(", ")}.`,
  );
  lines.push(
    card.taken
      ? "The strategy placed a practice order."
      : `The strategy did not place an order: ${t(notTakenText(card.not_taken_reason ?? "reason not recorded"))}.`,
  );
  return lines;
}

// ---- afterwards (UXN-126) ----------------------------------------------------------------------------

export type Afterwards = { state: "open" | "closed"; text: string };

/** net / cost in ppm, truncated toward zero, from exact bigint amounts. */
export function netPpm(proceeds: bigint, cost: bigint): number | null {
  if (cost <= 0n) return null;
  return Number(((proceeds - cost) * 1_000_000n) / cost); // threshold-ok: ppm scale, result is a ppm ratio
}

export function afterwards(
  card: DecisionCard,
  closed: { net: number; day: string | null } | null,
  open: boolean,
): Afterwards | null {
  if (closed === null) {
    return open
      ? {
          state: "open",
          text: "This setup is still open. The result will be shown here when it closes.",
        }
      : null;
  }
  const s = card.scenario;
  const result = `${pct1(closed.net)} after costs`;
  const when = closed.day === null ? "" : ` (closed ${closed.day})`;
  if (s.insufficient_history || s.p10_ppm === null || s.p90_ppm === null) {
    return {
      state: "closed",
      text: `The simulated result was ${result}${when}. There was not enough history to compare it with a usual range.`,
    };
  }
  const verdict =
    closed.net < s.p10_ppm
      ? "worse than 9 in 10 past setups"
      : closed.net > s.p90_ppm
        ? "better than 9 in 10 past setups"
        : "inside the usual range";
  return { state: "closed", text: `The simulated result was ${result}${when}: ${verdict}.` };
}
