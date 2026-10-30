// CTX-072: an Owner edit of a Cortex key is a charged trial and marks the map for a refit.
//
// This module is the pure-ish half (DB only, no clock, no config store): the one-line call site is in
// src/lib/config/admin.ts updateConfig, right after setConfig succeeds (see the P1 report):
//
//   if (isCortexRefitKey(key)) {
//     await recordCortexKeyEdit(p.mainDb, { market: "AU", key, before, after: parsed.value,
//       versionId: res.versionId, at: now, d: now.slice(0, 10) });
//   }
//
// What it writes, in one batch (idempotent by its ids, so a retry does not charge twice):
//  - one `trial_ledger` row per Cortex lineage (`<market>:F1` .. `F6`) that already has a split,
//    kind 'challenger' (the kind CHECK cannot change), rule_version `cortex:<family>.keyedit`,
//    variant `key:<key>`, so the lineage's error budget counts the edit (D-226, CTX-031);
//  - one `cortex_ledger_cell` (kind 'key_edit', family 'all') whose logged_at is the refit marker.
// The refit job (P6/CTX-060) reads `refitPending` and appends a new `cortex_map` row; a fit newer
// than the marker clears it. Nothing is updated or deleted.
import { CORTEX_REFIT_KEYS, type ConfigKey } from "@/lib/config/keys";
import { jsonText, type BatchExec, type Exec } from "./common";
import { newestFitAt } from "./maps";

const REFIT = new Set<string>(CORTEX_REFIT_KEYS);

/** True for an editable Cortex key (the fixed ones never change). */
export const isCortexRefitKey = (key: string): key is ConfigKey => REFIT.has(key);

/** Families whose lineages are charged (F7 is shadow only and has no lineage). */
const CHARGED_FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const;

export const KEY_EDIT_CELL_KIND = "key_edit";

export type KeyEditInput = {
  market: string;
  key: string;
  before: unknown;
  after: unknown;
  /** The config_version id of the edit (makes the ids unique and the call idempotent). */
  versionId: number;
  /** ISO UTC instant of the edit. */
  at: string;
  /** Session date (YYYY-MM-DD) recorded on the trial rows. */
  d: string;
};

export type KeyEditResult = {
  cellId: string;
  /** Lineage ids a trial was written for (a lineage with no split yet is skipped). */
  chargedLineages: string[];
};

export async function recordCortexKeyEdit(db: BatchExec, e: KeyEditInput): Promise<KeyEditResult> {
  if (!isCortexRefitKey(e.key)) throw new Error(`not a Cortex key: ${e.key}`);
  const cellId = `keyedit:${e.market}:${e.versionId}`;
  const charges: { family: string; lineageId: string; splitVersion: number }[] = [];
  for (const family of CHARGED_FAMILIES) {
    const lineageId = `${e.market}:${family}`;
    const r = await db.execute({
      sql: "SELECT MAX(version) AS v FROM lineage_split WHERE lineage_id = ?",
      args: [lineageId],
    });
    const v = r.rows[0]?.v;
    if (v !== null && v !== undefined) {
      charges.push({ family, lineageId, splitVersion: Number(v) });
    }
  }
  await db.batch(
    [
      {
        sql: `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json,
                logged_at, split, lineage_id) VALUES (?, ?, 'all', NULL, ?, ?, ?, 'development', NULL)
              ON CONFLICT DO NOTHING`,
        args: [
          cellId,
          e.market,
          KEY_EDIT_CELL_KIND,
          jsonText({ key: e.key, before: e.before, after: e.after, config_version: e.versionId }),
          e.at,
        ],
      },
      ...charges.map((c) => ({
        sql: `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version,
                variant, run_id, d) VALUES (?, ?, ?, ?, 'challenger', ?, ?, NULL, ?)
              ON CONFLICT DO NOTHING`,
        args: [
          `cortex-keyedit:${e.versionId}:${c.family}`,
          e.market,
          c.lineageId,
          c.splitVersion,
          `cortex:${c.family}.keyedit`,
          `key:${e.key}`,
          e.d,
        ],
      })),
    ],
    "write",
  );
  return { cellId, chargedLineages: charges.map((c) => c.lineageId) };
}

/**
 * True when a key edit is newer than the newest map fit, i.e. the maps need a refit. False when
 * there was no edit, or when no map exists yet (nothing to refit; the night abstains `map_missing`).
 */
export async function refitPending(db: Exec, market: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT MAX(logged_at) AS t FROM cortex_ledger_cell WHERE market = ? AND kind = ?",
    args: [market, KEY_EDIT_CELL_KIND],
  });
  const edit = r.rows[0]?.t;
  if (edit === null || edit === undefined) return false;
  const fit = await newestFitAt(db, market);
  return fit !== null && String(edit) > fit;
}
