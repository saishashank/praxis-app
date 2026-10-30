// cortex_feature_daily (CTX-050, D-293): ONE row per code per night; features_json is
// {angle_id: value|null} for the active set only and flags_json {angle_id: flag}. Insert-or-ignore:
// a re-run of the same night keeps the first rows (the night is reproducible, AT-50).
import { jsonText, parseJson, str, type BatchExec, type Exec } from "./common";

export type FeatureRow = {
  market: string;
  d: string;
  code: string;
  features: Readonly<Record<string, number | null>>;
  flags: Readonly<Record<string, string>>;
  activeSetHash: string;
  manifestId: string;
};

const ROWS_PER_BATCH = 200;

/** Writes a night's feature rows in batches; returns how many were new. */
export async function insertFeatureRows(
  db: BatchExec,
  rows: readonly FeatureRow[],
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += ROWS_PER_BATCH) {
    const results = await db.batch(
      rows.slice(i, i + ROWS_PER_BATCH).map((r) => ({
        sql: `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json,
                active_set_hash, manifest_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [
          r.market,
          r.d,
          r.code,
          jsonText(r.features),
          jsonText(r.flags),
          r.activeSetHash,
          r.manifestId,
        ],
      })),
      "write",
    );
    inserted += results.reduce((n, x) => n + x.rowsAffected, 0);
  }
  return { inserted };
}

const toRow = (r: Record<string, unknown>): FeatureRow => ({
  market: str(r.market),
  d: str(r.d),
  code: str(r.code),
  features: parseJson(r.features_json),
  flags: parseJson(r.flags_json),
  activeSetHash: str(r.active_set_hash),
  manifestId: str(r.manifest_id),
});

/** Every code's features of one night, ordered by code. */
export async function featureRowsForNight(
  db: Exec,
  market: string,
  d: string,
): Promise<FeatureRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM cortex_feature_daily WHERE market = ? AND d = ? ORDER BY code",
    args: [market, d],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

/** One code's features over a date range (inclusive), oldest first. */
export async function featureRowsForCode(
  db: Exec,
  market: string,
  code: string,
  from: string,
  to: string,
): Promise<FeatureRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_feature_daily WHERE market = ? AND code = ? AND d >= ? AND d <= ?
          ORDER BY d`,
    args: [market, code, from, to],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

export async function countFeatureRows(db: Exec, market: string, d: string): Promise<number> {
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM cortex_feature_daily WHERE market = ? AND d = ?",
    args: [market, d],
  });
  return Number(r.rows[0]?.n ?? 0);
}
