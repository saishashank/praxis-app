// R2-S2 read side of the Owner's money-figure attestation (writer: moneyApproval.ts). No control
// imports, so interlock.ts can read it without an import cycle. See moneyApproval.ts for the design.
import type { Client, Transaction } from "@libsql/client";
import { moneyValueHashes } from "./moneyConstants";

type Exec = Pick<Client, "execute"> | Pick<Transaction, "execute">;

export const MONEY_APPROVAL_KEY = "money_constants_approved";

export type MoneyApproval = {
  ids: string[];
  /** id -> sha256 of the canonical JSON of the figure's value when approved (R3-I2). Absent in a row without hashes. */
  hashes: Record<string, string>;
  approvedAt: string;
  changedBy: number | null;
};

/** The latest attestation, or null when none exists or it cannot be parsed (fail closed). */
export async function readMoneyApproval(db: Exec): Promise<MoneyApproval | null> {
  const r = await db.execute({
    sql:
      "SELECT value_json, changed_at, changed_by_user_id FROM config_version " +
      "WHERE key = ? AND scope = 'global' ORDER BY id DESC LIMIT 1",
    args: [MONEY_APPROVAL_KEY],
  });
  if (r.rows.length === 0) return null;
  try {
    const v = JSON.parse(String(r.rows[0]!.value_json)) as { ids?: unknown; items?: unknown };
    if (!Array.isArray(v.ids) || !v.ids.every((x) => typeof x === "string")) return null;
    const hashes: Record<string, string> = {};
    if (v.items !== undefined) {
      if (!Array.isArray(v.items)) return null;
      for (const it of v.items as { id?: unknown; valueHash?: unknown }[]) {
        if (typeof it?.id !== "string" || typeof it?.valueHash !== "string") return null;
        hashes[it.id] = it.valueHash;
      }
    }
    const by = r.rows[0]!.changed_by_user_id;
    return {
      ids: v.ids as string[],
      hashes,
      approvedAt: String(r.rows[0]!.changed_at),
      changedBy: by === null || by === undefined ? null : Number(by),
    };
  } catch {
    return null;
  }
}

/**
 * The figures in `unverified` the attestation does not cover (all of them when there is none). A figure
 * is covered only when its id is attested AND the attested value hash equals `current[id]` (R3-I2, D-817):
 * a changed value under the same id, a row without hashes, or an id with no current hash is not covered.
 */
export async function uncoveredByApproval(
  db: Exec,
  unverified: readonly string[],
  current: Readonly<Record<string, string>> = moneyValueHashes(),
): Promise<string[]> {
  if (unverified.length === 0) return [];
  const a = await readMoneyApproval(db);
  if (a === null) return [...unverified];
  return unverified.filter((id) => {
    const want = current[id];
    return !(a.ids.includes(id) && want !== undefined && a.hashes[id] === want);
  });
}
