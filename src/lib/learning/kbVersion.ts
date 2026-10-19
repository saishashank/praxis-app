// KB version (LLM-031, M6 decision 10 / D-110): `kb-<n>` where n is the id of the latest
// change_ledger row that changes what an LLM sees (a Lane-A playbook or note, a forced lesson, a
// promotion, force-apply, rollback, Owner version or retirement). Every router takes it at the start
// of a run; the llm_cache key contains it, so a change makes every cached answer miss and an
// unchanged ledger keeps hitting. Monotone (the ids are AUTOINCREMENT), cheap and deterministic.
// A kill-switch freeze changes no prompt, so it does not move the version (D-111).
import type { Client } from "@libsql/client";
import { CONTEXT_CHANGE_KINDS } from "./schema";

export const KB_VERSION_PREFIX = "kb-";
/** The version when the change ledger has no context-changing row yet. */
export const KB_VERSION_EMPTY = `${KB_VERSION_PREFIX}0`;

export function formatKbVersion(id: number): string {
  if (!Number.isInteger(id) || id < 0)
    throw new RangeError("kb version id must be a whole number >= 0");
  return `${KB_VERSION_PREFIX}${id}`;
}

/** The change-ledger id inside a KB version text, or null when the text is not of that shape. */
export function parseKbVersion(text: string): number | null {
  const m = /^kb-(0|[1-9]\d{0,15})$/.exec(text); // threshold-ok: digit-count bounds of the KB version text
  return m ? Number(m[1]) : null;
}

/**
 * Id of the latest context-changing change_ledger row (0 = none). With `market` only that market's
 * rows count; without it every market's rows do (the single global version the routers use).
 */
export async function currentKbVersionId(db: Client, market?: string): Promise<number> {
  const kinds = CONTEXT_CHANGE_KINDS.map(() => "?").join(", ");
  const res = await db.execute({
    sql: `SELECT COALESCE(MAX(id), 0) AS id FROM change_ledger
          WHERE kind IN (${kinds})${market === undefined ? "" : " AND market = ?"}`,
    args: market === undefined ? [...CONTEXT_CHANGE_KINDS] : [...CONTEXT_CHANGE_KINDS, market],
  });
  return Number(res.rows[0]?.id ?? 0);
}

/** `kb-<n>` for the router config (`kbVersion`) at the start of a run. */
export async function currentKbVersion(db: Client, market?: string): Promise<string> {
  return formatKbVersion(await currentKbVersionId(db, market));
}
