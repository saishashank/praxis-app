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
  /** GL-02: when the action was first confirmed; null/absent = known since before the column. */
  known_at?: string | null;
  /** M15 P3 (D-321): sorted comma-joined evidence sources (announcement, vendor, price); absent = vendor-only legacy. */
  sources?: string | null;
  /** M15 P3 (D-321): pending | confirmed | rejected | reversed; absent = legacy confirmed. */
  status?: string | null;
};

/** M15 P3: one ASIC short-position point (ppm of shares on issue) by report date. */
export type SnapshotShortInterest = { code: string; as_of: string; ppm: number };

/** M15 P3: one macro observation; published_at null = the series' lag rule (MACRO_SERIES). */
export type SnapshotMacro = {
  series: string;
  obs_d: string;
  value: number;
  published_at?: string | null;
};

/** M15 P3: an index bar row (AXJO, GSPC, VIX share the table; micro-AUD / index points as micro). */
export type SnapshotIndexBar = {
  index_code: string;
  d: string;
  o_micro: number;
  h_micro: number;
  l_micro: number;
  c_micro: number;
};

export type SnapshotAnnouncement = {
  code: string;
  ann_id: string;
  published_at: string;
  /** GL-05: when the row was first stored; null/absent = stored before the column (always visible). */
  first_ingested_at?: string | null;
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
    /** M15 P3: empty for a snapshot built before the table existed. */
    shortInterest: (s.tables.short_interest ?? []) as unknown as SnapshotShortInterest[],
    macroSeries: (s.tables.macro_series ?? []) as unknown as SnapshotMacro[],
    indexBars: s.tables.index_bars as unknown as SnapshotIndexBar[],
    tables: s.tables,
  };
}
