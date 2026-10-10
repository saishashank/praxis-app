import type { Client } from "@libsql/client";
import type { HistoryStore } from "./dataRepo.mjs";
import type { MonthPlan } from "./rules.mjs";

export type JobState = Record<string, unknown> & { status: string; reason?: string | null };
export type Job = {
  name: string;
  nextDate: string | null;
  done: boolean;
  rowsWrittenMonth: number;
  state: JobState;
};
export function initialCursor(name: string, nowMs: number): string;
export function ensureJobs(db: Client, nowMs: number): Promise<void>;
export function readState(db: Client, name: string): Promise<JobState>;
export function getJob(db: Client, name: string): Promise<Job | null>;
export function monthUsage(db: Client, nowMs: number): Promise<number>;

export type CommitStatus =
  | "ok"
  | "done"
  | "source_off"
  | "already_done"
  | "out_of_order"
  | "paused_cap"
  | "rejected"
  | "conflict";
export type CommitResult = {
  status: CommitStatus;
  reason?: string;
  expected?: string;
  rows?: number;
  rejected?: Record<string, number>;
  counted?: number;
  nextDate?: string | null;
  done?: boolean;
  file?: string;
  used?: number;
  cap?: number;
  needed?: number;
};
export function commitAsxDay(
  db: Client,
  o: { date: string; items: unknown[]; nowMs: number; cap?: number; commitSha?: string },
): Promise<CommitResult>;
export function commitHistoryMonth(
  db: Client,
  o: {
    month: string;
    rows: object[];
    store: HistoryStore;
    nowMs: number;
    cap?: number;
    commitSha?: string;
  },
): Promise<CommitResult>;
export function planAsic(
  db: Client,
  o: { nowMs: number; cap?: number; maxMonths?: number },
): Promise<{ action: "none"; reason: string } | { action: "fetch"; months: MonthPlan[] }>;
export function exportAsxMonths(
  db: Client,
  o: { store: HistoryStore; nowMs: number; cap?: number; maxMonths?: number; commitSha?: string },
): Promise<{ exported: string[]; skipped: string[]; conflicts: string[]; stopped: string | null }>;
