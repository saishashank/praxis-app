export type CallField = "code" | "direction" | "date" | "horizon";
export type CallState = "complete" | "incomplete" | "not_trackable";
export type PriceBasis = "close" | "open" | "unspecified";
export type HorizonUnit = "sessions" | "days" | "weeks" | "months";
export type CallProposalCore = {
  market: string;
  code: string | null;
  direction: "long" | "short" | null;
  callD: string | null;
  horizonSessions: number | null;
  priceBasis: PriceBasis;
  targetMicro: number | null;
  stopMicro: number | null;
  state: CallState;
  missing: CallField[];
  reason: string;
  source: "rules" | "model";
};
export type CallUniverseIn = {
  market: string;
  codes: Iterable<string>;
  indexNames?: readonly string[];
};
export type CalendarIn = readonly { d: string; kind: string }[];
export type CallFacts = {
  codes: string[];
  long: boolean;
  short: boolean;
  dates: string[];
  horizons: { n: number; unit: HorizonUnit }[];
  open: boolean;
  close: boolean;
  target: number | null;
  stop: number | null;
  indexLike: boolean;
};
export type CallAnswer = {
  code: string;
  direction: "long" | "short" | "none";
  date: string;
  horizon_n: number;
  horizon_unit: HorizonUnit | "none";
  price_basis: PriceBasis;
};
export const CALL_FIELDS: readonly CallField[];
export const FIELD_WORDS: Readonly<Record<CallField, string>>;
export const CALL_ANSWER_SCHEMA: Readonly<Record<string, unknown>>;
export function priceMicro(text: string): number | null;
export function datesIn(text: string): string[];
export function horizonsIn(text: string): { n: number; unit: HorizonUnit }[];
export function candidateCodes(text: string): string[];
export function extractFacts(summary: string, universe: CallUniverseIn): CallFacts;
export function sessionsAfter(from: string, days: number, calendar: CalendarIn): number;
export function horizonSessions(
  h: { n: number; unit: HorizonUnit } | null,
  callD: string | null,
  calendar: CalendarIn,
): number | null;
export function proposeCallStructure(
  summary: string,
  universe: CallUniverseIn,
  calendar?: CalendarIn,
): CallProposalCore;
export function answerOf(p: CallProposalCore, facts?: CallFacts): CallAnswer;
export function rulesAnswer(
  summary: string,
  universe: CallUniverseIn,
  calendar?: CalendarIn,
): CallAnswer;
export function parseModelAnswer(
  summary: string,
  json: unknown,
  universe: CallUniverseIn,
  calendar?: CalendarIn,
): CallProposalCore | null;
