// Shared pieces of the Cortex store (M15 P1; migration 0019). The store is the ONLY place in
// src/lib/cortex that touches the database (D-279: the core is pure). Every writer is append-only:
// it inserts, never updates, except the two once-only columns the migration guards
// (cortex_ledger_cell.result_*, opinion_track.settled_d / outcome_json).
import type { Client, InStatement } from "@libsql/client";
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";

/** What every reader and writer needs: one `execute` (a Client or a transaction). */
export type Exec = Pick<Client, "execute">;
/** Writers that must be atomic take a Client (they use `batch`). */
export type BatchExec = Pick<Client, "execute" | "batch">;

/** The families a Cortex map, status or decision can carry. F7 is shadow only (never an order). */
export const CORTEX_FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6", "F7"] as const;
export type CortexFamily = (typeof CORTEX_FAMILIES)[number];
export type Arm = "live" | "shadow";

/** The result of an insert-or-ignore: false = the row (by primary key) already existed. */
export type WriteResult = { readonly inserted: boolean };

/** Canonical JSON text of a value (sorted keys, undefined dropped): what the JSON columns hold. */
export const jsonText = (v: unknown): string => canonicalJson(v);

/** Parses a JSON column back. The CHECK (json_valid) guarantees the text parses. */
export const parseJson = <T = unknown>(v: unknown): T => JSON.parse(String(v)) as T;

export const str = (v: unknown): string => String(v);
export const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
export const num = (v: unknown): number => Number(v);
export const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** sha256 of the canonical JSON of a value (manifest ids, active-set hashes). */
export const hashOf = (v: unknown): string => sha256Hex(canonicalJson(v));

/** INSERT ... ON CONFLICT DO NOTHING; reports whether a row was written. */
export async function insertIgnore(db: Exec, stmt: InStatement): Promise<WriteResult> {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  const r = await db.execute(
    typeof stmt === "string"
      ? `${sql} ON CONFLICT DO NOTHING`
      : { sql: `${sql} ON CONFLICT DO NOTHING`, args: stmt.args },
  );
  return { inserted: r.rowsAffected > 0 };
}
