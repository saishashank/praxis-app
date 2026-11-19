import type { Client } from "@libsql/client";
export function defaultCalendarYears(now: Date): number[];
export function ensureCalendarYears(
  db: Pick<Client, "execute" | "batch">,
  market: string,
  years?: readonly number[],
  o?: { now?: () => Date },
): Promise<{
  status: "written" | "exists" | "no_rules";
  market: string;
  years: number[];
  inserted: number;
}>;
