// Thesis-breaker catalogue v1 (M4 T9; AGT-110, AGT-111; docs/M4_design.md 4.5). Machine-checkable
// conditions a Decision Card lists next to its thesis; they are EVALUATED in M5 (AGT-111), here they
// are only declared with their thresholds, every one read from AgentParams. A card lists the
// applicable ones in catalogue order, at most `thesis_breakers_max` (the first ones), at least
// `thesis_breakers_min` (the families' applicable sets are never smaller).
import { cmpRat, mulRat, ratFromInt, type Rational } from "@/lib/money/rational";
import type { AgentParams } from "./params";
import { roundHalfAway } from "./regime";
import type { Family } from "./schema";

export const BREAKER_IDS = [
  "TB-NEG",
  "TB-HALT",
  "TB-RAISE",
  "TB-EVLOW",
  "TB-SI",
  "TB-REGIME",
  "TB-SMA",
  "TB-KW",
] as const;
export type BreakerId = (typeof BREAKER_IDS)[number];

export type BreakerSpec = {
  readonly id: BreakerId;
  /** Machine-readable condition name (no free text). */
  readonly check: string;
  readonly families: readonly Family[];
};

const ALL: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

/** The catalogue in its fixed order (design 4.5). */
export const BREAKER_CATALOGUE: readonly BreakerSpec[] = [
  { id: "TB-NEG", check: "negative_price_sensitive_event", families: ALL },
  { id: "TB-HALT", check: "halt_suspension_or_query", families: ALL },
  { id: "TB-RAISE", check: "capital_raising_announced", families: ["F1", "F2", "F3", "F5", "F6"] },
  { id: "TB-EVLOW", check: "close_below_day0_low", families: ["F2", "F3", "F5"] },
  { id: "TB-SI", check: "short_interest_rise", families: ["F2", "F3", "F6"] },
  { id: "TB-REGIME", check: "regime_enters", families: ["F1", "F2", "F3", "F5", "F6"] },
  { id: "TB-SMA", check: "close_below_trend_sma", families: ["F1", "F4"] },
  { id: "TB-KW", check: "title_keyword", families: ["F2", "F3"] },
];

/** Title keywords of TB-KW (keyword-based: awaiting confirmation, hence amber, AGT-111). */
export const TB_KEYWORDS: readonly string[] = ["guidance downgrade", "withdrawn", "trading halt"];

/** Regime states that trigger TB-REGIME: SHOCK always, RISK-OFF also for F1 / F5 / F6. */
export function regimeTriggers(family: Family): readonly string[] {
  return family === "F1" || family === "F5" || family === "F6" ? ["RISK-OFF", "SHOCK"] : ["SHOCK"];
}

export type BreakerArgs = {
  readonly family: Family;
  /** Short-interest data is available for the code (DAT-125a); unavailable -> TB-SI is not listed. */
  readonly shortInterestAvailable: boolean;
};

/** The applicable breakers in catalogue order, cut to the card maximum. */
export function applicableBreakers(args: BreakerArgs, params: AgentParams): readonly BreakerSpec[] {
  const list = BREAKER_CATALOGUE.filter(
    (b) => b.families.includes(args.family) && (b.id !== "TB-SI" || args.shortInterestAvailable),
  );
  return list.slice(0, params.thesisBreakersMax);
}

export type BreakerValue = string | number | boolean | null | readonly string[];
/** One breaker on a card: a flat record of strings, whole numbers, booleans and string lists. */
export type CardBreaker = { readonly id: BreakerId; readonly check: string } & Readonly<
  Record<string, BreakerValue>
>;

export type BreakerLevels = {
  /** Today's close on the fill-session price basis (micro). */
  readonly closeMicro: bigint;
  /** Day-0 low of the signal's event on the same basis; null when unavailable. */
  readonly eventLowMicro: bigint | null;
};

/**
 * Amber level (AGT-111, design 4.5): a monitored value reads amber once only
 * `thesis_amber_fraction` of the distance from today's close to the trigger is left.
 */
export function amberLevelMicro(
  closeMicro: bigint,
  triggerMicro: bigint,
  fraction: Rational,
): bigint | null {
  if (closeMicro <= triggerMicro) return null;
  const left = mulRat(fraction, ratFromInt(closeMicro - triggerMicro));
  return triggerMicro + roundHalfAway(left);
}

/** The breaker as written on a card; every number comes from AgentParams or the levels. */
export function describeBreaker(
  spec: BreakerSpec,
  args: BreakerArgs,
  p: AgentParams,
  lv: BreakerLevels,
): CardBreaker {
  const base = { id: spec.id, check: spec.check };
  switch (spec.id) {
    case "TB-NEG":
      return { ...base, polarity: "negative", price_sensitive: true };
    case "TB-HALT":
      return { ...base, scope: "code" };
    case "TB-RAISE":
      return { ...base, kinds: ["capital_raising", "placement"] };
    case "TB-EVLOW": {
      const level = lv.eventLowMicro;
      const amber =
        level === null ? null : amberLevelMicro(lv.closeMicro, level, p.thesisAmberFraction);
      return {
        ...base,
        level_micro: level === null ? null : level.toString(),
        amber_at_micro: amber === null ? null : amber.toString(),
      };
    }
    case "TB-SI":
      return {
        ...base,
        rise_pp: `${p.f6.shortDropPp.num}/${p.f6.shortDropPp.den}`,
        sessions: p.windows.shortInterest,
      };
    case "TB-REGIME":
      return { ...base, states: regimeTriggers(args.family), amber: false };
    case "TB-SMA":
      return { ...base, period: p.windows.smaTrend };
    case "TB-KW":
      return { ...base, keywords: TB_KEYWORDS, status: "awaiting_confirmation", amber: true };
  }
}

/** The 3-5 breakers of a card. */
export function cardBreakers(args: BreakerArgs, p: AgentParams, lv: BreakerLevels): CardBreaker[] {
  return applicableBreakers(args, p).map((s) => describeBreaker(s, args, p, lv));
}

/** True when the amber fraction is a proper fraction (0, 1): the catalogue's amber level is defined. */
export function amberFractionValid(p: AgentParams): boolean {
  return (
    cmpRat(p.thesisAmberFraction, ratFromInt(0n)) > 0 &&
    cmpRat(p.thesisAmberFraction, ratFromInt(1n)) < 0
  );
}
