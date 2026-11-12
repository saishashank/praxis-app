import type { Client } from "@libsql/client";
export const JOB: "ingest-batch1";
export const MARKET: string;
export const FILE_KEYS: readonly string[];
export type DayOutcome = {
  d: string;
  status: string;
  bars: number;
  rowsWritten: number;
  outcome?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stage summaries are free-form, each its own shape
  stages: Record<string, any>;
};
export function prepareDay(
  db: Pick<Client, "execute">,
  o?: { market?: string; target?: string; nowMs?: () => number },
): Promise<{
  action: "fetch" | "skip";
  target: string;
  reason?: string;
  mode?: string;
  files?: string[];
  fetchable?: string[];
  disabled?: string[];
}>;
export function runDay(
  db: Client,
  o: {
    market?: string;
    d: string;
    files: Record<string, string | undefined>;
    nowMs: () => number;
    commitSha?: string;
    codeOfScrip?: (scrip: string) => string | null;
  },
): Promise<{ exit: number; status: string; reason?: string; target: string; dates: DayOutcome[] }>;
