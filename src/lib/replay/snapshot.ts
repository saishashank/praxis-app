// Replay snapshot (M4 T4, DAT-140): typed facade over the pure builder in
// src/lib/data/backfill/snapshotCore.mjs (kept as .mjs so the Actions script runs on plain Node).
// A replay loads one snapshot into memory and never reads Turso row by row.
import { parseSnapshot } from "@/lib/data/backfill/snapshotCore.mjs";

export {
  SNAPSHOT_FORMAT,
  SnapshotError,
  TABLES,
  buildSnapshot,
  parseSnapshot,
} from "@/lib/data/backfill/snapshotCore.mjs";
export type {
  Snapshot,
  SnapshotInputs,
  SnapshotTableName,
} from "@/lib/data/backfill/snapshotCore.mjs";

export type SnapshotBar = {
  code: string;
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
};
export type SnapshotCorporateAction = {
  code: string;
  ex_date: string;
  action_id: number;
  type: string;
  factor: number;
};

/** A loaded snapshot: tables as rows, the manifest and the content sha. */
export function loadSnapshot(bytes: Uint8Array) {
  const s = parseSnapshot(bytes);
  return {
    sha: s.sha,
    from: s.manifest.from,
    to: s.manifest.to,
    bars: s.tables.bars as unknown as SnapshotBar[],
    corporateActions: s.tables.corporate_actions as unknown as SnapshotCorporateAction[],
    tables: s.tables,
  };
}
