export const DEFAULT_AUTO_APPLY_SESSIONS: number;
export const DEFAULT_PRICE_TOLERANCE_PCT: number;
export const TYPES: readonly string[];
export const PRICE_TYPES: readonly string[];
export const SOURCES: readonly string[];
export const MAX_INFERRED_RATIO: number;
export function isQuantityType(type: string): boolean;
export function classOf(type: string): string;

export type Ratio = { n: bigint; d: bigint };
export function ratio(n: bigint | number, d: bigint | number): Ratio;
export function ratioMul(a: Ratio, b: Ratio): Ratio;
export function ratioToNumber(r: Ratio): number;
export function ratioToDecimal(r: Ratio, places?: number): string;

export function canonicalJson(v: unknown): string;
export function payloadProblem(type: string, payload: unknown): string | null;
export function factorFor(type: string, payload: unknown): Ratio | null;
export function entitlementCompensation(type: string, payload: unknown): Ratio | { n: 0n; d: 1n };

export type ValidCandidate = {
  code: string;
  type: string;
  ex_date: string;
  record_date: string | null;
  payload: Record<string, unknown>;
  source: string;
  ref: string | null;
};
export function validateCandidate(
  c: unknown,
): { ok: true; value: ValidCandidate } | { ok: false; reason: string };

export function observedRatio(price: { prevClose: number; exClose: number }): number;
export function priceConsistent(observed: number, factor: Ratio, tolerancePct: number): boolean;
export function inferRatio(
  observed: number,
  tolerancePct: number,
): { type: "split" | "consolidation"; payload: { new: number; old: number } } | null;

export function isPriceOnly(sources: readonly string[]): boolean;
export function adjCloseDisagrees(
  adj: { prevAdj: number; exAdj: number } | null | undefined,
  tolerancePct: number,
): boolean;
export function evidenceScore(sources: readonly string[], consistent: boolean): number;
export type GroupAction = { id: number; type: string; payload: unknown; sources: string[] };
export type Decision = {
  id: number;
  outcome: "auto_confirm" | "conflict";
  reasons: string[];
  score: number;
};
export function evaluateGroup(i: {
  actions: GroupAction[];
  price: { prevClose: number; exClose: number } | null;
  tolerancePct?: number;
  hasEffective?: boolean;
  adj?: { prevAdj: number; exAdj: number } | null;
}): { pending: true } | { pending: false; observed: number | null; decisions: Decision[] };

export type State =
  "none" | "pending" | "owner" | "blocked" | "confirmed" | "rejected" | "reversed";
export function parseNote(note: string | null | undefined): Record<string, unknown>;
export function stateOf(event: { status: string; note?: string | null } | null | undefined): {
  state: State;
  d: string | null;
};
export function isEffective(state: State): boolean;
export function isUnresolved(state: State): boolean;

type CalRows = readonly { d: string; kind: string }[];
export function sessionsElapsed(from: string, to: string, rows: CalRows): number;
export function autoApplyDue(
  queuedOn: string,
  today: string,
  rows: CalRows,
  sessions?: number,
): boolean;
export function autoApplyDate(queuedOn: string, rows: CalRows, sessions?: number): string | null;
export function pickBestEvidence(
  due: { id: number; score: number }[],
): { id: number; score: number } | null;

export function typeLabel(type: string): string;
export function describeTerms(type: string, payload: unknown): string;
export type FactorKind = "price" | "split";
export function factorKindOf(type: string): FactorKind;
export function refCloseMatches(
  stored: number | null | undefined,
  current: number | null | undefined,
): boolean;
export function reasonText(reason: string): string;
