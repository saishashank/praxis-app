// R2-S2 read side of the Owner's money-figure attestation (writer: moneyApproval.ts). No control
// imports, so interlock.ts can read it without an import cycle. See moneyApproval.ts for the design.
import type { Client, Transaction } from "@libsql/client";

type Exec = Pick<Client, "execute"> | Pick<Transaction, "execute">;

export const MONEY_APPROVAL_KEY = "money_constants_approved";

export type MoneyApproval = { ids: string[]; approvedAt: string; changedBy: number | null };

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
    const v = JSON.parse(String(r.rows[0]!.value_json)) as { ids?: unknown };
    if (!Array.isArray(v.ids) || !v.ids.every((x) => typeof x === "string")) return null;
    const by = r.rows[0]!.changed_by_user_id;
    return {
      ids: v.ids as string[],
      approvedAt: String(r.rows[0]!.changed_at),
      changedBy: by === null || by === undefined ? null : Number(by),
    };
  } catch {
    return null;
  }
}

/** The figures in `unverified` the attestation does not cover (all of them when there is none). */
export async function uncoveredByApproval(
  db: Exec,
  unverified: readonly string[],
): Promise<string[]> {
  if (unverified.length === 0) return [];
  const a = await readMoneyApproval(db);
  const covered = new Set(a?.ids ?? []);
  return unverified.filter((id) => !covered.has(id));
}
