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
  /** Rows read/written by this date so far; a hook adds its own counts here. */
  io: Io;
  universe: number;
  barsValid: number;
  rejected: RejectedBarIn[];
  refetchDiffs: { code: string; d: string; maxDiffPct: number }[];
};
/** Stage 8 (T7 plugs in here). The default does nothing. */
export type QualityHook = (ctx: QualityHookContext) => Promise<{ flags?: number } | void>;
export const noopQualityHook: QualityHook;

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
