// cortex_state (CTX-015, CTX-016, CTX-044): one table for the corporate-action, halt and promotion
// state machines. A state ends with a NEW row whose state is 'none' (no to_d column, so the table
// stays append-only). One row per (code, kind, from_d): a second change on the same session date
// conflicts and throws, which is the signal that a state machine ran twice for one night.
import { jsonText, parseJson, str, strOrNull, type Exec } from "./common";

export const STATE_KINDS = ["corp_action", "halt", "promotion"] as const;
export type StateKind = (typeof STATE_KINDS)[number];

export type StateRow = {
  market: string;
  code: string;
  kind: StateKind;
  fromD: string;
  /** 'none' closes the previous state. */
  state: string;
  basis: unknown;
  sourceRef: string | null;
};

export async function insertState(db: Exec, s: StateRow): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cortex_state (market, code, kind, from_d, state, basis_json, source_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [s.market, s.code, s.kind, s.fromD, s.state, jsonText(s.basis), s.sourceRef],
  });
}

const toRow = (r: Record<string, unknown>): StateRow => ({
  market: str(r.market),
  code: str(r.code),
  kind: str(r.kind) as StateKind,
  fromD: str(r.from_d),
  state: str(r.state),
  basis: parseJson(r.basis_json),
  sourceRef: strOrNull(r.source_ref),
});

/**
 * The states in force at session date `d`: for every (code, kind) the newest row with from_d <= d,
 * dropped when that row is 'none'. Ordered by code then kind.
 */
export async function statesInForce(db: Exec, market: string, d: string): Promise<StateRow[]> {
  const r = await db.execute({
    sql: `SELECT s.* FROM cortex_state s
          WHERE s.market = ? AND s.state <> 'none' AND s.from_d = (SELECT MAX(x.from_d)
            FROM cortex_state x WHERE x.market = s.market AND x.code = s.code AND x.kind = s.kind
              AND x.from_d <= ?)
          ORDER BY s.code, s.kind`,
    args: [market, d],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}

/** The whole history of one (code, kind), oldest first. */
export async function stateHistory(
  db: Exec,
  market: string,
  code: string,
  kind: StateKind,
): Promise<StateRow[]> {
  const r = await db.execute({
    sql: "SELECT * FROM cortex_state WHERE market = ? AND code = ? AND kind = ? ORDER BY from_d",
    args: [market, code, kind],
  });
  return r.rows.map((x) => toRow(x as Record<string, unknown>));
}
