export type JobKind = "workflow" | "route" | "worker-internal";
export type JobSafety = "always-on" | "go-live" | "internal";
export type JobDays = "daily" | "trading" | "first-saturday";
export interface Job {
  id: string;
  label: string;
  kind: JobKind;
  schedule: string;
  time: string;
  days: JobDays;
  safety: JobSafety;
  dateBackDays: number;
  runNow: boolean;
  ownerOnly: true;
  workflow?: string;
  route?: string;
}
export const JOBS: readonly Job[];
export const RUNNABLE_JOBS: readonly Job[];
export function findJob(id: unknown): Job | undefined;
export function validateParams(j: Job, raw: unknown, today: string): { d?: string } | null;
