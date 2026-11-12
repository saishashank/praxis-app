export const JOB: string;
export const STAGE_NAMES: readonly string[];
export class StageError extends Error {
  stage: string;
}
export function prepareDay(
  db: { execute: (...a: never[]) => unknown },
  o: { nowMs: number | (() => number); market: string },
): Promise<{
  action: "fetch" | "nothing_to_fetch" | "skip";
  target: string;
  reason?: string;
  dates?: number;
  codes?: number;
  excluded?: number;
  request?: {
    codes: string[];
    start: string;
    end: string;
    suffix: string;
    currency: string | null;
  };
}>;
export function runDay(
  db: { execute: (...a: never[]) => unknown; batch: (...a: never[]) => unknown },
  o: {
    nowMs: number | (() => number);
    market: string;
    barsText?: string | null;
    feedsText?: string | null;
    feeds?: Record<string, unknown>;
    commitSha?: string;
    qualityHook?: (c: never) => unknown;
  },
): Promise<{
  exit: number;
  status: string;
  reason?: string;
  target: string;
  dates: {
    d: string;
    status: string;
    rowsRead: number;
    rowsWritten: number;
    bars: number;
    rejected: number;
    error?: string;
  }[];
}>;
