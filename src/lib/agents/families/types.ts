// A5 family rule interpreter: shared types (M4 T7; spec 07 section 7.4; docs/M4_design.md 4.3).
// The interpreter is a pure function of `FamilyInputs` (what the DecisionView returned for session
// D, already reduced to facts) and `AgentParams`. It never reads a clock, a database or a random
// source, so the live nightly batch (2b) and the replay engine call the same code (AGT-003).
// Price-domain values are exact (bigint micro / Rational); floats appear only for indicator values
// that are float by design (Wilder RSI/ATR, D-081).
import type { Rational } from "@/lib/money/rational";
import type { ViewBar } from "../decisionView";
import type { IndicatorRow } from "../indicators";
import type { PatternName } from "../patterns";
import type { RegimeLabel } from "../regime";
import type { EventCategory, Family, Polarity } from "../schema";

export type { Family, RegimeLabel, PatternName };

/** Universe tiers (ARN-010). Tier membership already carries the tier ADV / price minimums. */
export type Tier = "U1" | "U2" | "U3";

export type SourceMode = "on" | "off";

/** DAT-127 source gates that change family behaviour. */
export type Sources = { readonly asx: SourceMode; readonly asic: SourceMode };

/** One stored event row reduced to what the rules read (rule-derived values only, AGT-011a). */
export type EventFact = {
  /** `${source}|${ann_id}` */
  readonly id: string;
  readonly code: string;
  /** Day 0 session date (YYYY-MM-DD). Only events with day 0 <= D are passed in. */
  readonly day0: string;
  /** (code, day 0): "one event counts once". */
  readonly groupKey: string;
  readonly category: EventCategory;
  readonly priceSensitive: boolean;
  readonly polarity: Polarity;
  /** Exact day-0 abnormal return; null when day 0 has no bar. */
  readonly ar: Rational | null;
  /** Day-0 volume ratio, exact. */
  readonly volRatio: Rational | null;
  /** false = assumed time (untimed backfill), flagged on the signal. */
  readonly timed: boolean;
  /** Raw day-0 low in micro (F2 close-below-low exit); null when day 0 has no bar. */
  readonly day0LowMicro: bigint | null;
};

export type IndicatorFacts = Pick<
  IndicatorRow,
  | "closeAboveSmaLong"
  | "closeAboveSmaShort"
  | "atrMicro"
  | "atrWarm"
  | "rsiShort"
  | "rsiShortWarm"
  | "rsiLong"
  | "rsiLongWarm"
  | "returnLookback"
  | "isHigh"
  | "volumeRatio"
  | "adv"
  | "dayRangePosition"
>;

/** Everything the rules need to know about one code on session D. */
export type CodeFacts = {
  readonly code: string;
  readonly tier: Tier;
  /** D's raw bar (micro). */
  readonly bar: ViewBar;
  /** Halted / suspended today (announcement) or the halt proxy while ASX is off (DAT-127). */
  readonly halted: boolean;
  /** Adjusted closes, oldest first, last = D (factors with ex-date <= D, DAT-126). */
  readonly closesAdj: readonly bigint[];
  /** Raw bars, oldest first, last = D (at least the ARN-011 range window). */
  readonly rawBars: readonly ViewBar[];
  readonly ind: IndicatorFacts;
  readonly patterns?: Partial<Readonly<Record<PatternName, boolean | null>>>;
  /** AGT-105 score in quarter units; null = unknown (never 0). */
  readonly insiderScoreQ: number | null;
  /** F6 class (d): true / false, or "unknown" when a value is missing. */
  readonly shortDrop: boolean | "unknown";
  /** Sessions since a consolidation (ARN-011); null = none known. */
  readonly consolidationSessionsAgo: number | null;
  /** ARN-011 promotional pattern: a title matched the configured keyword list. */
  readonly promotional: boolean;
};

export type FamilyInputs = {
  readonly market: string;
  /** The session being decided. */
  readonly d: string;
  readonly regime: RegimeLabel;
  /** Trading sessions up to and including D, oldest first. */
  readonly sessions: readonly string[];
  readonly sources: Sources;
  /** false = no announcement coverage for D (replay before the backfill): F4 runs without its event filter. */
  readonly eventCoverage: boolean;
  readonly codes: readonly CodeFacts[];
  /** Events of the tracked codes with day 0 <= D, published before cut-off(D). */
  readonly events: readonly EventFact[];
  /** Candle patterns that have PASSED ARN-074 (none in M4). */
  readonly passedPatterns?: ReadonlySet<PatternName>;
};

export type FamilyOptions = {
  /** F1 opt-in to U2 (default off, REQ 2.5). */
  readonly u2OptInF1?: boolean;
  /** Replay validation variants F1-U1, F2-no-fundamentals-U1, F3-U1: U1 only. */
  readonly restrictToU1?: boolean;
  readonly arn011?: Arn011Thresholds;
  readonly constants?: SpecConstants;
  /** Which families to output (default all). F6 always computes its components internally. */
  readonly families?: readonly Family[];
  /**
   * Leave-one-input-class-out replay (ARN-076): F6 evidence classes (a)-(d) treated as unavailable.
   * An unavailable class lowers F6's requirement exactly as a missing data source does (decision 14)
   * and the variant is labelled `F6-loco-<classes>`. Never set by the live batch.
   */
  readonly f6DisabledClasses?: readonly string[];
};

/** ARN-011 thresholds (Owner-only). No registry keys exist yet: see D-085 (missing keys). */
export type Arn011Thresholds = {
  readonly gainSessions: number;
  readonly gainMax: Rational;
  readonly oneDayGain: Rational;
  readonly volumeRatioMax: Rational;
  readonly placementWindow: number;
  readonly placementsMax: number;
  readonly raiseWindow: number;
  readonly queryWindow: number;
  readonly consolidationWindow: number;
  readonly rangeFraction: Rational;
  readonly rangeDaysWindow: number;
  readonly rangeDaysMin: number;
};

/** Spec values that have no registry key yet (reported as missing keys, D-085). */
export type SpecConstants = {
  /** F5 CS: volume ratio below this ... */
  readonly f5DryUpRatio: Rational;
  /** ... for this many consecutive sessions. */
  readonly f5DryUpSessions: number;
};

// ---------------------------------------------------------------------------------------------
// Stops and exits (design 2.6): data the 2b batch executes
// ---------------------------------------------------------------------------------------------

/**
 * Initial stop spec: stop = max(fill - round_half_away(k * atr_micro) [if k], floor(fill * (1 - cap))
 * [if cap], level_micro [if level]); see `initialStop`.
 */
export type StopSpec = {
  readonly atr_micro: bigint | null;
  readonly k: Rational | null;
  /** Largest loss as a positive fraction (F5: 1/5). */
  readonly cap: Rational | null;
  readonly level_micro: bigint | null;
};

export type InitialStopRule = {
  readonly id: string;
  /** Contributing family for an F6 position, else null. */
  readonly via: Family | null;
  readonly spec: StopSpec;
};

/** IS trailing stop: highest close since entry - k * ATR; active only after `activateGain` if set. */
export type TrailRule = {
  readonly id: string;
  readonly via: Family | null;
  readonly k: Rational;
  readonly activateGain: Rational | null;
};

export type CsRule =
  | {
      readonly id: string;
      readonly via: Family | null;
      readonly kind: "time_stop";
      /** Sessions held (the entry fill session counts as 1). */
      readonly sessions: number;
      /** When set the exit needs close/fill - 1 < minReturn (F1: 40 sessions and < +5 %). */
      readonly minReturn: Rational | null;
    }
  | {
      readonly id: string;
      readonly via: Family | null;
      readonly kind: "close_above_sma";
      readonly period: number;
    }
  | {
      readonly id: string;
      readonly via: Family | null;
      readonly kind: "negative_event";
      /** null = any category with polarity -1; day 0 must be on or after the entry fill session. */
      readonly categories: readonly EventCategory[] | null;
    }
  | {
      readonly id: string;
      readonly via: Family | null;
      readonly kind: "close_below_level";
      readonly levelMicro: bigint;
    }
  | {
      readonly id: string;
      readonly via: Family | null;
      readonly kind: "volume_dry_up";
      readonly ratioBelow: Rational;
      readonly sessions: number;
    };

export type ExitPlan = {
  readonly initialStops: readonly InitialStopRule[];
  readonly trails: readonly TrailRule[];
  readonly cs: readonly CsRule[];
};

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

export type RuleTrace = {
  readonly id: string;
  readonly pass: boolean;
  /** The value read, as exact text. */
  readonly value: string;
  readonly threshold: string;
};

export type Candidate = {
  readonly d: string;
  readonly family: Family;
  /** Data variant label (ARN-082). */
  readonly variant: string;
  readonly ruleVersion: string;
  readonly code: string;
  readonly tier: Tier;
  readonly regime: RegimeLabel;
  /** F4 in SHOCK: half size, subject to the parcel (FAM-001). */
  readonly halfSize: boolean;
  /** Higher is better, compared left to right; null = unknown, sorts last. */
  readonly rank: readonly (Rational | null)[];
  readonly rankText: string;
  /** Tie-break (FAM-001): higher ADV first. */
  readonly adv: Rational | null;
  readonly groupKey: string | null;
  /** F6: the evidence classes that agree, sorted. */
  readonly classes: readonly string[] | null;
  /** F6: contributing families of classes (a)/(b). */
  readonly contributors: readonly Family[];
  /** F3: cancel at fill if the next open is at or above this raw micro price. */
  readonly maxOpenMicro: bigint | null;
  readonly stopSpec: StopSpec;
  readonly plan: ExitPlan;
  readonly rules: readonly RuleTrace[];
  readonly flags: readonly string[];
};

/** Entry rules held but a gate or ARN-011 filter stopped the entry: logged with the reason. */
export type BlockedCandidate = Candidate & { readonly reasons: readonly string[] };

export type BlockedData = {
  readonly family: Family;
  readonly status: "BLOCKED-DATA";
  readonly conditions: readonly string[];
  readonly note: string;
};

export type FamilyOutput = {
  readonly d: string;
  readonly candidates: readonly Candidate[];
  readonly blocked: readonly BlockedCandidate[];
  readonly blockedData: readonly BlockedData[];
};

// ---------------------------------------------------------------------------------------------
// Open positions (exits and stop recomputation)
// ---------------------------------------------------------------------------------------------

export type PositionState = {
  readonly tradeId: string;
  readonly code: string;
  readonly family: Family;
  readonly plan: ExitPlan;
  /** Entry fill session and price (raw micro). */
  readonly fillDay: string;
  readonly fillMicro: bigint;
  /** Sessions held counting the entry fill session as 1, as of D. */
  readonly sessionsHeld: number;
  readonly closeMicro: bigint;
  /** Highest raw close since entry, D included. */
  readonly highestCloseMicro: bigint;
  readonly atrMicro: bigint | null;
  /** D's close vs the exit SMA (F4 CS); null in warm-up. */
  readonly closeAboveExitSma: boolean | null;
  /** Volume ratios of the last sessions, oldest first, ending D (F5 dry-up). */
  readonly volumeRatios: readonly (Rational | null)[];
  /** Events of the code with day 0 <= D. */
  readonly events: readonly EventFact[];
};

export type CsTrigger = {
  readonly rule: string;
  readonly via: Family | null;
  readonly detail: string;
};

export type ExitEvaluation = {
  readonly tradeId: string;
  readonly code: string;
  /** The CS exit to create for D+1: the first rule of the plan that fired, else null. */
  readonly cs: CsTrigger | null;
  readonly triggered: readonly CsTrigger[];
  /** IS levels to append to stop_level for D (active from the next session). */
  readonly isLevels: readonly { readonly rule: string; readonly levelMicro: bigint }[];
};
