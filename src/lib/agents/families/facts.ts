// Builders that reduce stored data to the facts the family rules read (M4 T7). Pure helpers used by
// the 2b batch (from the DecisionView) and by the replay engine alike, and by the synthetic AT-15
// fixtures. The rules themselves never see a database or a view.
import type { ViewBar } from "../decisionView";
import { arOf } from "../events";
import {
  computeIndicatorRow,
  DEFAULT_INDICATOR_PARAMS,
  type Bar,
  type IndicatorParams,
} from "../indicators";
import type { AgentParams } from "../params";
import type { EventRow } from "../schema";
import { makeRational } from "@/lib/money/rational";
import type { CodeFacts, EventFact, Tier } from "./types";

const PPM = 1_000_000n; // threshold-ok: parts-per-million storage unit of vol_ratio_ppm

/** The A4 parameters from the resolved agent parameters (one source of windows). */
export function indicatorParamsFrom(p: AgentParams): IndicatorParams {
  return {
    atrPeriod: p.windows.atr,
    rsiShortPeriod: p.windows.rsiShort,
    rsiLongPeriod: p.windows.rsiLong,
    smaShortPeriod: p.windows.smaExit,
    smaLongPeriod: p.windows.smaTrend,
    returnLookback: p.windows.returnWindow,
    highLookback: p.f1.highLookback,
    volumeWindow: p.windows.volumeRatio,
    advWindow: p.windows.adv,
    warmupMultiple: DEFAULT_INDICATOR_PARAMS.warmupMultiple,
  };
}

export type CodeFactsInput = {
  readonly code: string;
  readonly tier: Tier;
  /** Adjusted bars (factors with ex-date <= D), oldest first, last = D. */
  readonly adjusted: readonly Bar[];
  /** Raw bars aligned with `adjusted` (same length). */
  readonly raw: readonly ViewBar[];
  readonly halted?: boolean;
  readonly insiderScoreQ?: number | null;
  readonly shortDrop?: boolean | "unknown";
  readonly consolidationSessionsAgo?: number | null;
  readonly promotional?: boolean;
  readonly patterns?: CodeFacts["patterns"];
};

export function buildCodeFacts(input: CodeFactsInput, p: AgentParams): CodeFacts {
  if (input.adjusted.length === 0 || input.adjusted.length !== input.raw.length) {
    throw new RangeError("adjusted and raw bars must be aligned and non-empty");
  }
  const row = computeIndicatorRow(
    input.adjusted,
    input.raw.map((b) => b.close),
    indicatorParamsFrom(p),
  );
  return {
    code: input.code,
    tier: input.tier,
    bar: input.raw[input.raw.length - 1]!,
    halted: input.halted ?? false,
    closesAdj: input.adjusted.map((b) => b.close),
    rawBars: input.raw,
    ind: {
      closeAboveSmaLong: row.closeAboveSmaLong,
      closeAboveSmaShort: row.closeAboveSmaShort,
      atrMicro: row.atrMicro,
      atrWarm: row.atrWarm,
      rsiShort: row.rsiShort,
      rsiShortWarm: row.rsiShortWarm,
      rsiLong: row.rsiLong,
      rsiLongWarm: row.rsiLongWarm,
      returnLookback: row.returnLookback,
      isHigh: row.isHigh,
      volumeRatio: row.volumeRatio,
      adv: row.adv,
      dayRangePosition: row.dayRangePosition,
    },
    patterns: input.patterns,
    insiderScoreQ: input.insiderScoreQ ?? null,
    shortDrop: input.shortDrop ?? "unknown",
    consolidationSessionsAgo: input.consolidationSessionsAgo ?? null,
    promotional: input.promotional ?? false,
  };
}

/** A stored event row as the rules read it (rule-derived fields only, AGT-011a). */
export function eventFactFromRow(row: EventRow, day0LowMicro: bigint | null): EventFact {
  return {
    id: `${row.source}|${row.ann_id}`,
    code: row.code,
    day0: row.day0_d,
    groupKey: row.group_key,
    category: row.category,
    priceSensitive: row.price_sensitive === 1,
    polarity: row.polarity,
    ar: arOf(row),
    volRatio: row.vol_ratio_ppm === null ? null : makeRational(BigInt(row.vol_ratio_ppm), PPM),
    timed: row.timed === 1,
    day0LowMicro,
  };
}
