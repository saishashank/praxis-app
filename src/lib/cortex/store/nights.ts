// cortex_night, input_manifest and cortex_abstain (CTX-010, CTX-013, CTX-050, CTX-055).
// All three are written by the nightly stage in its own transaction; each is insert-or-ignore so a
// re-run of the same night keeps the first record.
import {
  hashOf,
  insertIgnore,
  jsonText,
  num,
  parseJson,
  str,
  strOrNull,
  type Exec,
  type WriteResult,
} from "./common";

export const NIGHT_REASONS = ["late_bar", "quota", "map_missing", "universe_incomplete"] as const;
export type NightReason = (typeof NIGHT_REASONS)[number];

export type NightRow = {
  market: string;
  d: string;
  status: "ran" | "abstain_all";
  reason: NightReason | null;
  manifestId: string;
  universeN: number;
  barsN: number;
  featureRows: number;
  runtimeMs: number;
  activeSetHash: string;
  mapFittedAt: string | null;
};

export async function insertNight(db: Exec, n: NightRow): Promise<WriteResult> {
  return insertIgnore(db, {
    sql: `INSERT INTO cortex_night (market, d, status, reason, manifest_id, universe_n, bars_n,
            feature_rows, runtime_ms, active_set_hash, map_fitted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      n.market,
      n.d,
      n.status,
      n.reason,
      n.manifestId,
      n.universeN,
      n.barsN,
      n.featureRows,
      n.runtimeMs,
      n.activeSetHash,
      n.mapFittedAt,
    ],
  });
}

const toNight = (r: Record<string, unknown>): NightRow => ({
  market: str(r.market),
  d: str(r.d),
  status: str(r.status) as NightRow["status"],
  reason: strOrNull(r.reason) as NightReason | null,
  manifestId: str(r.manifest_id),
  universeN: num(r.universe_n),
  barsN: num(r.bars_n),
  featureRows: num(r.feature_rows),
  runtimeMs: num(r.runtime_ms),
  activeSetHash: str(r.active_set_hash),
  mapFittedAt: strOrNull(r.map_fitted_at),
});

export async function getNight(db: Exec, market: string, d: string): Promise<NightRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM cortex_night WHERE market = ? AND d = ?",
    args: [market, d],
  });
  return r.rows[0] ? toNight(r.rows[0] as Record<string, unknown>) : null;
}

/** The newest `limit` night records up to and including `d`, newest first. */
export async function recentNights(
  db: Exec,
  market: string,
  d: string,
  limit: number,
): Promise<NightRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM cortex_night WHERE market = ? AND d <= ? ORDER BY d DESC LIMIT ?",
    args: [market, d, limit],
  });
  return r.rows.map((x) => toNight(x as Record<string, unknown>));
}

// ---- input manifests ----

export type ManifestBody = {
  market: string;
  d: string;
  sources: unknown;
  schemaSha: string;
  rowCounts: unknown;
};
export type ManifestRow = ManifestBody & { manifestId: string; createdAt: string };

/** manifest_id = sha256 of the canonical JSON of the rest (not of createdAt, so it is reproducible). */
export const manifestIdOf = (b: ManifestBody): string =>
  hashOf({
    market: b.market,
    d: b.d,
    sources: b.sources,
    schema_sha: b.schemaSha,
    row_counts: b.rowCounts,
  });

/** Writes a manifest under its content hash; the same inputs give the same id and are not repeated. */
export async function insertManifest(
  db: Exec,
  b: ManifestBody,
  createdAt: string,
): Promise<{ manifestId: string; inserted: boolean }> {
  const manifestId = manifestIdOf(b);
  const w = await insertIgnore(db, {
    sql: `INSERT INTO input_manifest (manifest_id, market, d, sources_json, schema_sha,
            row_counts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      manifestId,
      b.market,
      b.d,
      jsonText(b.sources),
      b.schemaSha,
      jsonText(b.rowCounts),
      createdAt,
    ],
  });
  return { manifestId, inserted: w.inserted };
}

export async function getManifest(db: Exec, manifestId: string): Promise<ManifestRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM input_manifest WHERE manifest_id = ?",
    args: [manifestId],
  });
  const x = r.rows[0] as Record<string, unknown> | undefined;
  if (!x) return null;
  return {
    manifestId: str(x.manifest_id),
    market: str(x.market),
    d: str(x.d),
    sources: parseJson(x.sources_json),
    schemaSha: str(x.schema_sha),
    rowCounts: parseJson(x.row_counts_json),
    createdAt: str(x.created_at),
  };
}

// ---- abstains ----

export type AbstainRow = {
  market: string;
  d: string;
  bookId: string;
  gateId: string;
  label: string;
  detail: unknown;
};

export async function insertAbstain(db: Exec, a: AbstainRow): Promise<WriteResult> {
  return insertIgnore(db, {
    sql: `INSERT INTO cortex_abstain (market, d, book_id, gate_id, label, detail_json)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [a.market, a.d, a.bookId, a.gateId, a.label, jsonText(a.detail)],
  });
}

export async function abstainsForNight(db: Exec, market: string, d: string): Promise<AbstainRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM cortex_abstain WHERE market = ? AND d = ? ORDER BY book_id",
    args: [market, d],
  });
  return r.rows.map((x) => ({
    market: str(x.market),
    d: str(x.d),
    bookId: str(x.book_id),
    gateId: str(x.gate_id),
    label: str(x.label),
    detail: parseJson(x.detail_json),
  }));
}

/** Nights (newest first, up to `limit`) in which a book abstained, for the CTX-023 alarm streak. */
export async function abstainNightsOfBook(
  db: Exec,
  market: string,
  bookId: string,
  d: string,
  limit: number,
): Promise<string[]> {
  const r = await db.execute({
    sql: `SELECT d FROM cortex_abstain WHERE market = ? AND book_id = ? AND d <= ?
          ORDER BY d DESC LIMIT ?`,
    args: [market, bookId, d, limit],
  });
  return r.rows.map((x) => str(x.d));
}
