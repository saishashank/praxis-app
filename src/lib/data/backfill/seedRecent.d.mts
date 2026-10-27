import type { Client } from "@libsql/client";

export const SEED_SESSIONS: number;
export const SEED_MAX_MONTHS: number;
export type SeedResult = {
  status: "ok" | "nothing" | "paused_cap" | "no_files";
  sessions: number;
  rows: number;
  written: number;
  from?: string;
  to?: string;
  needed?: number;
  used?: number;
};
export function seedRecentBars(
  db: Client,
  o: {
    readMonth: (month: string) => Uint8Array | null;
    nowMs: number;
    sessions?: number;
    cap?: number;
    commitSha?: string;
  },
): Promise<SeedResult>;
