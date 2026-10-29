import type { Client } from "@libsql/client";
import type { SnapshotInputs } from "./snapshotCore.mjs";

export const RECENT_DAYS: number;
export function monthsBetween(from: string, to: string): string[];
export function loadInputs(o: {
  db: Client;
  readAsset: (name: string) => Uint8Array | null;
  from: string;
  to: string;
  recentFrom?: string;
  pageRows?: number;
}): Promise<SnapshotInputs>;
