import type { Client } from "@libsql/client";
import type { CalendarLike, PlannedDate, RejectedBarIn } from "./rules.mjs";

export const JOB: "ingest-batch1";
export const STAGE_NAMES: readonly string[];
export class StageError extends Error {
  stage: string;
  constructor(stage: string, detail?: string);
}

export type Io = { read: number; written: number };

export type QualityHookContext = {
  db: Client;
  market: string;
  d: string;
  /** ISO time of the call. */
  now: string;
  /** Rows read/written by this date so far; a hook adds its own counts here. */
  io: Io;
  universe: number;
  barsValid: number;
  rejected: RejectedBarIn[];
  refetchDiffs: { code: string; d: string; maxDiffPct: number }[];
};
/** Stage 8: the default is the quality engine (src/lib/data/quality/engine.mjs). */
export type QualityHook = (
  ctx: QualityHookContext,
) => Promise<{ flags?: number; summary?: Record<string, unknown> } | void>;
export const noopQualityHook: QualityHook;
/** Stage 4: the default is the corporate action engine (src/lib/data/corporateActions/engine.mjs). */
export type CorporateActionsHook = (ctx: {
  db: Client;
  market: string;
  d: string;
  io: Io;
  now: string;
  candidates: object[];
  relevant?: (code: string) => boolean;
}) => Promise<object | void>;
export const noopCorporateActionsHook: CorporateActionsHook;

export type FetchRequest = { codes: string[]; start: string; end: string };

export type Assessment =
  | { kind: "failed"; stage: string; reason: string; target: string; market: string; io: Io }
  | { kind: "skip"; reason: string; target: string; market: string; io: Io }
  | { kind: "done"; reason: string; target: string; market: string; io: Io }
  | {
      kind: "go";
      target: string;
      market: string;
      io: Io;
      plan: { dates: PlannedDate[]; remaining: number };
      calRows: (CalendarLike & { confirmed: number })[];
      codes: string[];
      excluded?: number;
      request: FetchRequest | null;
    };

export type AssessOptions = {
  nowMs: number;
  market?: string;
  maxDates?: number;
  lookbackDays?: number;
};
export function assess(db: Client, o: AssessOptions): Promise<Assessment>;
export function readThrottle(db: Client): Promise<{ chunkSize: number; minGapS: number }>;
export function prepareBatch1(
  db: Client,
  o: AssessOptions,
): Promise<
  | {
      action: "fetch";
      target: string;
      dates: number;
      codes: number;
      excluded: number;
      request: FetchRequest;
      throttle: { chunkSize: number; minGapS: number };
    }
  | { action: "nothing_to_fetch"; target: string; dates: number }
  | { action: "skip"; target: string; reason: string }
>;

export type RunOptions = {
  nowMs: () => number;
  barsText?: string | null;
  commitSha?: string;
  market?: string;
  maxDates?: number;
  lookbackDays?: number;
  /** Decision 13: catch-up writes per UTC month. */
  writeCap?: number;
  refetchPct?: number;
  qualityHook?: QualityHook;
  corporateActionsHook?: CorporateActionsHook;
  /** Structured announcement / vendor candidates for a date (none exist in the pipeline yet). */
  corporateActionCandidates?: (d: string) => object[];
  /** Held or candidate codes (DAT-221); default: every code. */
  corporateActionRelevant?: (code: string) => boolean;
};

export type DateResult = {
  d: string;
  status: "ok" | "failed" | "already_done" | "non_trading" | "no_universe" | "cap";
  rowsRead: number;
  rowsWritten: number;
  bars: number;
  rejected: number;
  refetchRows: number;
  outcome?: string;
  error?: string;
  capStop?: boolean;
};
export type RunResult = {
  exit: 0 | 1;
  status: "ok" | "skipped" | "degraded" | "failed";
  reason?: string;
  target: string;
  remaining?: number;
  capStopped?: boolean;
  dates: DateResult[];
};
export function runBatch1(db: Client, o: RunOptions): Promise<RunResult>;
