import type { Client } from "@libsql/client";

export type SeedState = { apply(client: Client, nowIso: string): Promise<void> };
export const STATES: Record<
  | "picks-two-sections"
  | "experts-queue"
  | "steelman-cards"
  | "alerts-muted"
  | "market-built-off"
  | "blueprint-full",
  SeedState
>;
export const STATE_NAMES: string[];
export function parseStates(value: string | undefined): string[];
export function applyStates(client: Client, names: string[], nowIso?: string): Promise<string[]>;
