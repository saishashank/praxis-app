// family_status and cortex_statement (CTX-053, CTX-072, CTX-082, D-280). Status rows are history; the
// latest since_d at or before the asked date wins, and a family with no row is `shadow` (D-280/D-281:
// until the import, every family is shadow so the live V1 behaviour is unchanged).
import {
  CORTEX_FAMILIES,
  jsonText,
  numOrNull,
  parseJson,
  str,
  strOrNull,
  type CortexFamily,
  type Exec,
} from "./common";

export const FAMILY_STATUSES = ["shadow", "allowed", "suspended"] as const;
export type FamilyStatusWord = (typeof FAMILY_STATUSES)[number];
export type FamilyStatusSetBy = "import" | "evaluator" | "owner_kill";

export type FamilyStatusRow = {
  market: string;
  family: CortexFamily;
  sinceD: string;
  status: FamilyStatusWord;
  evidence: unknown;
  statementId: string | null;
  setBy: FamilyStatusSetBy;
};

export async function insertFamilyStatus(db: Exec, s: FamilyStatusRow): Promise<void> {
  await db.execute({
    sql: `INSERT INTO family_status (market, family, since_d, status, evidence_json, statement_id, set_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [s.market, s.family, s.sinceD, s.status, jsonText(s.evidence), s.statementId, s.setBy],
  });
}

/** The status of every family F1..F7 as of session date `d` (default `shadow`). */
export async function familyStatusMap(
  db: Exec,
  market: string,
  d: string,
): Promise<Record<CortexFamily, FamilyStatusWord>> {
  const r = await db.execute({
    sql: `SELECT s.family, s.status FROM family_status s
          WHERE s.market = ? AND s.since_d = (SELECT MAX(x.since_d) FROM family_status x
            WHERE x.market = s.market AND x.family = s.family AND x.since_d <= ?)`,
    args: [market, d],
  });
  const out = Object.fromEntries(CORTEX_FAMILIES.map((f) => [f, "shadow"])) as Record<
    CortexFamily,
    FamilyStatusWord
  >;
  for (const x of r.rows) out[str(x.family) as CortexFamily] = str(x.status) as FamilyStatusWord;
  return out;
}

/** Every status row of one family, oldest first. */
export async function familyStatusHistory(
  db: Exec,
  market: string,
  family: CortexFamily,
): Promise<FamilyStatusRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM family_status WHERE market = ? AND family = ? ORDER BY since_d",
    args: [market, family],
  });
  return r.rows.map((x) => ({
    market: str(x.market),
    family: str(x.family) as CortexFamily,
    sinceD: str(x.since_d),
    status: str(x.status) as FamilyStatusWord,
    evidence: parseJson(x.evidence_json),
    statementId: strOrNull(x.statement_id),
    setBy: str(x.set_by) as FamilyStatusSetBy,
  }));
}

// ---- statements ----

export type StatementRow = {
  statementId: string;
  market: string;
  family: CortexFamily;
  kind: "allowed_weak" | "live_tested";
  /** From the statement templates only (CTX-072: not editable). */
  text: string;
  numbers: unknown;
  nEffLive: number | null;
  createdAt: string;
};

export async function insertStatement(db: Exec, s: StatementRow): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cortex_statement (statement_id, market, family, kind, text, numbers_json,
            n_eff_live, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      s.statementId,
      s.market,
      s.family,
      s.kind,
      s.text,
      jsonText(s.numbers),
      s.nEffLive,
      s.createdAt,
    ],
  });
}

export async function getStatement(db: Exec, statementId: string): Promise<StatementRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM cortex_statement WHERE statement_id = ?",
    args: [statementId],
  });
  const x = r.rows[0] as Record<string, unknown> | undefined;
  if (!x) return null;
  return {
    statementId: str(x.statement_id),
    market: str(x.market),
    family: str(x.family) as CortexFamily,
    kind: str(x.kind) as StatementRow["kind"],
    text: str(x.text),
    numbers: parseJson(x.numbers_json),
    nEffLive: numOrNull(x.n_eff_live),
    createdAt: str(x.created_at),
  };
}

/** The newest statement of a family (by created_at, then id); null when none. */
export async function latestStatement(
  db: Exec,
  market: string,
  family: CortexFamily,
): Promise<StatementRow | null> {
  const r = await db.execute({
    sql: `SELECT statement_id FROM cortex_statement WHERE market = ? AND family = ?
          ORDER BY created_at DESC, statement_id DESC LIMIT 1`,
    args: [market, family],
  });
  const id = r.rows[0]?.statement_id;
  return id === undefined ? null : getStatement(db, String(id));
}
