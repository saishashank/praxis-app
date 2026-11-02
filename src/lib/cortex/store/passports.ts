// angle_passport (CTX-030, D-304). One row per (angle, version); a status change is a NEW version, so
// the table is append-only. The import (D-267) is the writer; the code registry is the source of
// definitions and the reader below is what a test compares it with.
import { jsonText, num, parseJson, str, type Exec } from "./common";

export const ANGLE_STATUSES = ["candidate", "measured", "active", "watch", "retired"] as const;
export type AngleStatusWord = (typeof ANGLE_STATUSES)[number];
export const PASSPORT_CLUSTERS = [
  "momentum",
  "low_volatility",
  "liquidity",
  "event",
  "quality",
  "sentiment",
  "regime",
  "risk",
  "calendar",
  "meta",
] as const;

export type PassportRow = {
  market: string;
  angleId: string;
  version: number;
  domain: number;
  cluster: (typeof PASSPORT_CLUSTERS)[number];
  orientation: 1 | -1;
  kind: "score" | "gate" | "meta";
  inputs: readonly string[];
  historyFields: unknown;
  status: AngleStatusWord;
  horizonSessions: number;
  evidence: unknown;
  measured: unknown | null;
  frozenAt: string;
};

const toRow = (r: Record<string, unknown>): PassportRow => ({
  market: str(r.market),
  angleId: str(r.angle_id),
  version: num(r.version),
  domain: num(r.domain),
  cluster: str(r.cluster) as PassportRow["cluster"],
  orientation: num(r.orientation) === 1 ? 1 : -1,
  kind: str(r.kind) as PassportRow["kind"],
  inputs: parseJson<string[]>(r.inputs_json),
  historyFields: parseJson(r.history_fields_json),
  status: str(r.status) as AngleStatusWord,
  horizonSessions: num(r.horizon_sessions),
  evidence: parseJson(r.evidence_json),
  measured: r.measured_json === null ? null : parseJson(r.measured_json),
  frozenAt: str(r.frozen_at),
});

/** Appends one passport version. A repeat of (market, angle, version) throws (the key is the history). */
export async function insertPassport(db: Exec, p: PassportRow): Promise<void> {
  await db.execute({
    sql: `INSERT INTO angle_passport (market, angle_id, version, domain, cluster, orientation, kind,
            inputs_json, history_fields_json, status, horizon_sessions, evidence_json, measured_json,
            frozen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      p.market,
      p.angleId,
      p.version,
      p.domain,
      p.cluster,
      p.orientation,
      p.kind,
      jsonText(p.inputs),
      jsonText(p.historyFields),
      p.status,
      p.horizonSessions,
      jsonText(p.evidence),
      p.measured === null ? null : jsonText(p.measured),
      p.frozenAt,
    ],
  });
}

/** The newest version of every angle of a market, ordered by angle id. */
export async function latestPassports(db: Exec, market: string): Promise<PassportRow[]> {
  const r = await db.execute({
    sql: `SELECT p.* FROM angle_passport p
          WHERE p.market = ? AND p.version = (SELECT MAX(q.version) FROM angle_passport q
            WHERE q.market = p.market AND q.angle_id = p.angle_id)
          ORDER BY p.angle_id`,
    args: [market],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

/** Every version of one angle, oldest first. */
export async function passportHistory(
  db: Exec,
  market: string,
  angleId: string,
): Promise<PassportRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM angle_passport WHERE market = ? AND angle_id = ? ORDER BY version",
    args: [market, angleId],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

/** Angle ids whose newest version has the given status (the active set of a night: `active`). */
export async function angleIdsWithStatus(
  db: Exec,
  market: string,
  status: AngleStatusWord,
): Promise<string[]> {
  return (await latestPassports(db, market))
    .filter((p) => p.status === status)
    .map((p) => p.angleId);
}

/** The ids in the registry that have no passport row yet (the import test asserts this is empty). */
export async function missingPassports(
  db: Exec,
  market: string,
  registryIds: readonly string[],
): Promise<string[]> {
  const have = new Set((await latestPassports(db, market)).map((p) => p.angleId));
  return registryIds.filter((id) => !have.has(id));
}
