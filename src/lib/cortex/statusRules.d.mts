export type Interval = { point: number; lo: number; hi: number };
export type PooledCell = {
  n: number;
  blocks: number;
  nEff: number | null | undefined;
  lower90: number | null;
  byRegime: Record<string, { n: number; meanNet: number }>;
  [k: string]: unknown;
};
export type GateOpts = { cellMinSetups?: number; cellMinBlocks?: number; regimeMinSetups?: number };
export type GateVerdict =
  | { pass: true }
  | { pass: false; reason: "not_enough_history" | "bound_not_positive" | "regime_blocked" };
export type FamilyDecisionInput = {
  family: string;
  nEff: number | null;
  minNEff?: number;
  brierLo90: number | null;
  slopeUb90: number | null;
  cell: PooledCell | null;
  hideUb?: number;
  gateOpts?: GateOpts;
};
export type FamilyDecision = {
  family: string;
  status: "allowed" | "shadow";
  allowed: boolean;
  failed: string[];
  pHidden: boolean;
  evidence: Record<string, unknown>;
};
export type StatementDraft = {
  kind: "allowed_weak";
  text: string;
  nEffLive: 0;
  numbers: Record<string, unknown>;
};
export type LiveTestedInput = {
  family: string;
  fromD: string;
  nCases: number;
  nEffLive: number;
  ece: Interval;
  slope: Interval;
  intercept: Interval;
  skill: Interval;
  excess: Interval;
  survivorship: string;
};
export type LiveTestedDraft = {
  kind: "live_tested";
  family: string;
  publishable: boolean;
  criteria: Record<string, boolean>;
  text: string;
  nEffLive: number;
  numbers: Record<string, unknown>;
};
export const FAMILIES: readonly string[];
export const DEFAULT_MIN_NEFF_TRADE: number;
export const MIN_NEFF_TRADE_BOUNDS: readonly [number, number];
export const DEFAULT_HIDE_UB: number;
export const GATE_DEFAULTS: {
  cellMinSetups: number;
  cellMinBlocks: number;
  regimeMinSetups: number;
};
export const A_D5_08: string;
export const A_D5_08_MIN_LIVE_SESSIONS: number;
export const LINEAGES: number;
export const WEAK_LEVEL: number;
export const STRICT_LEVEL: number;
export const LIVE_TESTED_MIN_NEFF: number;
export const LIVE_PENDING_LABEL: string;
export const PROJECTION_TARGETS: readonly number[];
export function cellGate(cell: PooledCell, regime: string, opts?: GateOpts): GateVerdict;
export function regimeStable(
  cell: PooledCell,
  opts?: GateOpts,
): { stable: boolean; perRegime: ({ regime: string } & GateVerdict)[] };
export function slopeHiddenFromUb(ub: number | null | undefined, hideUb?: number): boolean;
export function decideFamily(input: FamilyDecisionInput): FamilyDecision;
export function capAngleStatus(angleId: string, requested: string, liveSessions: number): string;
export function luckChance(lineages?: number, level?: number): number;
export function luckFigure(
  ledgerCells: number,
  keyEdits?: number,
  q?: number,
): { trials: number; expected: number; text: string };
export function projectSessions(
  target: number,
  nEffLive: number,
  perSession: number | null | undefined,
): number | null;
export function allowedWeakStatement(input: {
  family: string;
  nEffLivePerSession: number | null;
}): StatementDraft;
export function liveTestedStatement(input: LiveTestedInput): LiveTestedDraft;
