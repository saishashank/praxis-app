import type { Client } from "@libsql/client";
import type { Io, QualityHook } from "../pipeline/batch1-core.mjs";

export type QualitySummary = {
  scores: Record<
    "U1" | "U2" | "U3",
    { valid: number; expected: number; score: number; empty?: boolean }
  >;
  gate: { pass: boolean; threshold_pct: number; consecutive_failures: number };
  counts: {
    suspect: number;
    missing: number;
    cross_source_disagreements: number;
    unresolved_corporate_actions: number;
  };
  flags_by_rule: Record<string, number>;
  flags_new: number;
  flags_cleared: number;
};

export function readQualityConfig(
  db: Client,
  io?: Io,
): Promise<{ refetchDiffPct: number; suspectMovePct: number; u1GatePct: number }>;

export function runQuality(ctx: {
  db: Client;
  market: string;
  d: string;
  io: Io;
  now?: string;
  tradingDay?: boolean;
  rejected?: { code: string | null; date: string | null; reason: string }[];
  refetchDiffs?: { code: string; d: string; maxDiffPct: number }[];
}): Promise<{ flags: number; cleared: number; summary: QualitySummary }>;

export const qualityHook: QualityHook;
