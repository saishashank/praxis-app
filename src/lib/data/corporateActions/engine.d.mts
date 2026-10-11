import type { Client } from "@libsql/client";
import type { Io } from "../pipeline/batch1-core.mjs";
import type { State } from "./rules.mjs";

export const BLOCK_CHECK: string;
export const BEST_EVIDENCE_CHECK: string;

export type Candidate = {
  code: string;
  type: string;
  ex_date: string;
  record_date?: string | null;
  payload?: unknown;
  source: string;
  ref?: string | null;
};

export type ActionEvent = {
  id: number;
  at: string;
  status: string;
  by: string;
  note: string | null;
};
export type Action = {
  id: number;
  code: string;
  type: string;
  ex_date: string;
  payload: Record<string, unknown>;
  payloadText: string;
  sources: string[];
  events: ActionEvent[];
  latest: ActionEvent | null;
  state: State;
  stateSince: string | null;
  note: Record<string, unknown>;
};

export function readCaConfig(
  db: Client,
  io?: Io,
): Promise<{ autoApplySessions: number; priceTolerancePct: number; suspectMovePct: number }>;
export function loadActions(db: Client, io: Io, market: string): Promise<Action[]>;

export function resolveAction(
  db: Client,
  c: {
    market: string;
    actionId: number;
    decision: "confirm" | "reject" | "reverse";
    by: string;
    now: string;
    d: string;
    io: Io;
  },
): Promise<
  | { ok: true; code: string; type: string; ex_date: string }
  | { ok: false; error: "not_found" | "not_open" | "not_confirmed" | "conflicts_with_confirmed" }
>;

export function settle(
  db: Client,
  c: {
    market: string;
    now: string;
    io: Io;
    today: string;
    assertDate?: string | null;
    excludeDate?: string | null;
    changed?: { ex_date: string }[];
  },
): Promise<{ factors: number; flags_raised: number; flags_cleared: number; reevaluated: string[] }>;

export type CaSummary = {
  captured: number;
  source_added: number;
  invalid: number;
  jumps_without_ratio: number;
  auto_confirmed: number;
  queued_owner: number;
  queued_blocked: number;
  pending: number;
  promoted: number;
  applied_best_evidence: number;
  superseded: number;
  factors_written: number;
  flags_raised: number;
  flags_cleared: number;
  reevaluated: string[];
};

export function runCorporateActions(ctx: {
  db: Client;
  market: string;
  d: string;
  io: Io;
  now?: string;
  candidates?: Candidate[];
  relevant?: (code: string) => boolean;
}): Promise<CaSummary>;

export const corporateActionsHook: (c: {
  db: Client;
  market: string;
  d: string;
  io: Io;
  now?: string;
  candidates?: Candidate[];
  relevant?: (code: string) => boolean;
}) => Promise<CaSummary>;
