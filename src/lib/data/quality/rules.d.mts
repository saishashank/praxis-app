export const DEFAULT_SUSPECT_MOVE_PCT: number;
export const DEFAULT_U1_GATE_PCT: number;
export const DEFAULT_REFETCH_DIFF_PCT: number;
export const TIERS: readonly ["U1", "U2", "U3"];

export type Severity = "warning" | "error" | "critical";
export type RuleDef = { id: string; severity: Severity; blocks: boolean };
export type Finding = {
  rule: string;
  severity: string;
  blocks_entries: boolean;
  detail: Record<string, unknown>;
};
export type Bar = { o: number; h: number; l: number; c: number; volume: number };

export const RULES: {
  ohlc_inconsistent: RuleDef;
  price_not_positive: RuleDef;
  volume_negative: RuleDef;
  not_trading_day: RuleDef;
  duplicate_bar: RuleDef;
  suspect_move: RuleDef;
  zero_volume_u1: RuleDef;
  identical_ohlcv: RuleDef;
  refetch_diff: RuleDef;
  missing_bar: RuleDef;
  u1_gate: RuleDef;
};
export const RULE_IDS: string[];
export const REEVALUATED_IDS: string[];
export const REJECT_RULE: Record<string, RuleDef>;
export const PCT_BOUNDS: {
  refetch_diff_flag: [number, number];
  suspect_move: [number, number];
  u1_quality_gate: [number, number];
};

export function evaluateBar(i: {
  bar: Bar;
  prev?: Bar | null;
  tradingDay?: boolean;
  tier?: string;
  halted?: boolean;
  explained?: boolean;
  suspectMovePct?: number;
}): Finding[];
export function evaluateRefetch(maxDiffPct: number, thresholdPct?: number): Finding[];
export function evaluateMissing(i?: { rejectReasons?: string[] }): Finding[];
export function evaluateRejects(reasons: string[]): Finding[];
export type TierScore = { expected: number; valid: number; score: number; empty: boolean };
export function tierScore(expected: number, valid: number): TierScore;
export function gateFails(u1: { expected: number; valid: number }, gatePct?: number): boolean;
export function scoreDay(i: {
  expected: { code: string; tier: string }[];
  invalid: ReadonlySet<string>;
  gatePct?: number;
}): { tiers: Record<string, TierScore & { gate_pass: boolean }>; gateFailed: boolean };
export function gateFinding(u1: { expected: number; valid: number }, gatePct?: number): Finding;
export function boundedPct(raw: unknown, def: number, bounds: [number, number]): number;
export function qualityConfigFrom(raw: {
  refetch_diff_flag?: unknown;
  suspect_move?: unknown;
  u1_quality_gate?: unknown;
}): { refetchDiffPct: number; suspectMovePct: number; u1GatePct: number };
