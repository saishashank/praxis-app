import type { ProfileField, WorkStatus, MarketModeValue } from "../fields.mjs";

export type SeedField = {
  readonly value: unknown;
  readonly verify: 0 | 1;
  readonly verifiedAt: string | null;
  readonly evidenceRef: string | null;
};

export type MarketSeed = {
  readonly code: string;
  readonly name: string;
  readonly workStatus: WorkStatus;
  readonly enabled: 0 | 1;
  readonly mode: MarketModeValue;
  readonly profileVersion: number;
  readonly statusChangedAt: string | null;
  readonly builtAt: string | null;
  readonly evidenceRecordedAt: string | null;
  readonly updatedAt: string;
  readonly costProfileCodes: readonly string[];
  readonly fields: Readonly<Record<ProfileField, SeedField>>;
};

export const SEEDS: Readonly<Record<string, MarketSeed>>;
/** The built market codes (the seed registry), sorted. */
export function builtMarkets(): string[];
export function seedOf(code: string): MarketSeed | undefined;
