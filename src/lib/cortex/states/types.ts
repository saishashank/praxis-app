// Cortex state machines: shared types (M15 C3b; docs/M15_design.md 2 "C3b", 3 `cortex_state`, 3a;
// CTX-015, CTX-016, CTX-043, CTX-044, CTX-055; D-261, D-272, D-279). Every machine here is a pure
// function of the as-of view at session index `t`, the previous state and explicit parameters: no
// store, no clock, no random source. Each step returns the next state, a plain label the card and
// the abstain line can show, and the `cortex_state` row to append when the state changed (P1 writes
// it; a state that ends is a new row with `state = 'none'`, never an update).
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { makeRational, type Rational } from "@/lib/money/rational";

/** `cortex_state.kind`. */
export type StateKind = "corp_action" | "halt" | "promotion";

/** DAT-221 evidence sources (`data/corporateActions/rules.mjs` SOURCES). */
export type CandidateSource = "announcement" | "vendor" | "price";

/** `corporate_action_event` status as the CTX-015 machine reads it (rules.mjs `State`, reduced). */
export type CorpActionStatus = "pending" | "confirmed" | "rejected" | "reversed";

/**
 * Provenance of one corporate-action row (D-321). `CorpActionRecord` carries `payload_json` only;
 * the sources live in `corporate_action.evidence_json` (plus `add_source` notes, engine.mjs) and
 * the status in `corporate_action_event`. The Cortex producer (P2 live store, P3 replay, O1
 * offline) must supply both for every record it hands the view: pending rows are known at their
 * `first_ingested_at`, confirmed rows at their `known_at`. Either the record itself is a
 * `CortexCorpAction` (the extra fields ride on the object) or a map keyed by action id is passed
 * to the machine. A record with neither fails closed (no candidate, no re-base, Owner alert).
 */
export type CorpActionProvenance = {
  readonly sources: readonly CandidateSource[];
  readonly status: CorpActionStatus;
};
export type CortexCorpAction = CorpActionRecord & CorpActionProvenance;

/**
 * One `cortex_state` row as the writer wants it (market is the view's). `basis` is `basis_json`:
 * plain JSON (bigint as decimal text, Rational as "num/den"); `sourceRef` the notice, action or
 * event id the state rests on.
 */
export type StateRow = {
  readonly kind: StateKind;
  readonly code: string;
  readonly fromD: string;
  readonly state: string;
  readonly basis: Readonly<Record<string, unknown>>;
  readonly sourceRef: string | null;
};

/** What every step returns besides its typed state. */
export type StepOutcome<S extends { readonly state: string }> = {
  readonly next: S;
  /** Plain words for the card / abstain line (CTX-070 register; no jargon). */
  readonly label: string;
  /** Machine-readable reason of the transition or of staying put. */
  readonly reason: string;
  /** The row to append when `next.state` differs from the previous state; null when unchanged. */
  readonly row: StateRow | null;
};

/** Ch. 17 §17.9 keys the state machines read (defaults = the chapter's; bounds enforced by P1). */
export type StatesParams = {
  // CTX-015
  /** Hard stop during a candidate freeze, on adjusted prices from the last clean close (O-63). */
  readonly freezeMaxLossPct: number;
  /** Sessions (break session = 1) after which an unresolved candidate is confirmed or alerted. */
  readonly unresolvedFreezeSessions: number;
  /** Notice / vendor / observed ratios agree when within this of each other. */
  readonly confirmTolerancePct: number;
  /** Explained-move test: raw deviates from the ratio-explained level by more than this. */
  readonly disconfirmDevPct: number;
  /** Consecutive post-break sessions the deviation must hold to disconfirm. */
  readonly disconfirmSessions: number;
  /** A jump of at least this with no candidate blocks entries for `jumpBlockSessions`. */
  readonly jumpBlockPct: number;
  readonly jumpBlockSessions: number;
  // CTX-016
  /** A halt is at most this many sessions; longer is a suspension. */
  readonly haltMaxSessions: number;
  /** >= `suspensionHaltCount` halted sessions in any `suspensionWindowSessions` = suspension. */
  readonly suspensionWindowSessions: number;
  readonly suspensionHaltCount: number;
  /** A suspension ends after this many consecutive traded sessions. */
  readonly suspensionEndTradedSessions: number;
  /** Declining mark: 100 % for `fullSessions`, then -`stepPts` per `stepSessions`, floor. (D-272: fixed.) */
  readonly suspensionMark: {
    readonly fullSessions: number;
    readonly stepPts: number;
    readonly stepSessions: number;
    readonly floorPct: number;
  };
  /** Entry-time loss budget; a reopen gap beyond it exits at the reopen open (CTX-016). */
  readonly maxLossPct: number;
  // CTX-043
  /** Polarity needs |AR0| >= max(polarityMinPct, polaritySigmaMult x 60-session return sd). */
  readonly polarityMinPct: number;
  readonly polaritySigmaMult: number;
  readonly polaritySigmaSessions: number;
  /** D+1 volume >= this x ADV20 (ADV20 over the 20 sessions before day 0). */
  readonly persistVolumeMult: number;
  readonly persistAdvSessions: number;
  // CTX-044
  readonly pumpVolumeMult: number;
  readonly pumpArPct: number;
  /** A move signature blocks entries for this many sessions. */
  readonly moveBlockSessions: number;
  /** Rolling window of the notice-and-move count and the flag's run length. */
  readonly promotionFlagSessions: number;
  readonly noticeCountFlag: number;
  readonly noticeCountFlagWithAr: number;
  readonly noticeCountArPct: number;
  // CTX-055
  readonly coldStartSessions: number;
  readonly abstainAlarmPct: number;
  /** Population-stability index above which the session-20 check fails. */
  readonly psiMax: number;
};

export const DEFAULT_STATES_PARAMS: StatesParams = {
  freezeMaxLossPct: 25,
  unresolvedFreezeSessions: 5,
  confirmTolerancePct: 1,
  disconfirmDevPct: 10,
  disconfirmSessions: 2,
  jumpBlockPct: 15,
  jumpBlockSessions: 2,
  haltMaxSessions: 5,
  suspensionWindowSessions: 20,
  suspensionHaltCount: 5,
  suspensionEndTradedSessions: 10,
  suspensionMark: { fullSessions: 5, stepPts: 10, stepSessions: 5, floorPct: 50 },
  maxLossPct: 18,
  polarityMinPct: 2,
  polaritySigmaMult: 1.5,
  polaritySigmaSessions: 60,
  persistVolumeMult: 2,
  persistAdvSessions: 20,
  pumpVolumeMult: 4,
  pumpArPct: 8,
  moveBlockSessions: 5,
  promotionFlagSessions: 20,
  noticeCountFlag: 3,
  noticeCountFlagWithAr: 2,
  noticeCountArPct: 5,
  coldStartSessions: 20,
  abstainAlarmPct: 95,
  psiMax: 0.25,
};

/** A percentage as an exact fraction (25 -> 1/4). Non-finite or negative input is refused. */
export function pctRat(pct: number): Rational {
  if (!Number.isFinite(pct) || pct < 0) throw new RangeError(`bad percentage ${pct}`);
  // up to 6 decimals of a percentage are kept exactly
  const scaled = Math.round(pct * 1_000_000);
  return makeRational(BigInt(scaled), 100_000_000n);
}

/** basis_json helpers: JSON has no bigint, so money and ratios go as text. */
export function basisMicro(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}
export function basisRat(r: Rational | null): string | null {
  return r === null ? null : `${r.num}/${r.den}`;
}
