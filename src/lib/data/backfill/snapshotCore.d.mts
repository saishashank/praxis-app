export const SNAPSHOT_FORMAT: number;
export class SnapshotError extends Error {
  reason: string;
  constructor(reason: string);
}
export type SnapshotTableName =
  "calendar" | "universe" | "bars" | "index_bars" | "corporate_actions" | "announcements";
export const TABLES: readonly { name: SnapshotTableName; fields: readonly string[] }[];
export type SnapshotInputs = Partial<
  Record<SnapshotTableName | `${SnapshotTableName}_recent`, Record<string, unknown>[]>
>;
export type Snapshot = {
  sha: string;
  text: string;
  bytes: Uint8Array;
  counts: Record<string, number>;
  from: string;
  to: string;
};
export function buildSnapshot(o: { from: string; to: string; inputs: SnapshotInputs }): Snapshot;
export function parseSnapshot(bytes: Uint8Array): {
  manifest: { format: number; from: string; to: string; counts: Record<string, number> };
  tables: Record<SnapshotTableName, Record<string, unknown>[]>;
  sha: string;
};
