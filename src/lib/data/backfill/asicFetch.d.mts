import type { AsicRow, MonthPlan } from "./rules.mjs";

export function validUserAgent(ua: unknown): string | null;
export type AsicMonth = {
  month: string;
  complete: boolean;
  dates: number;
  absent: number;
  skipped: number;
  rows: AsicRow[];
};
export type AsicStop = null | "blocked" | "rate_limited" | "http_error" | "malformed" | "network";
export function fetchAsicMonths(o: {
  months: Pick<MonthPlan, "month" | "dates">[];
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
}): Promise<{ months: AsicMonth[]; stopped: AsicStop }>;
