// The remembered Strategies sort (UXN-046a, UX-110): one key `strategies_sort` in the user's prefs_json.
// Reading never throws (a preferences outage gives the default). Writing changes only that key, keeps
// every other stored key, and commits with its audit event in one transaction (ROL-104); the audit
// detail names the field, never the value.
import type { Client, Transaction } from "@libsql/client";
import { auditTx, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";

export const STRATEGY_SORTS = ["best", "closest", "risk", "az"] as const;
export type StrategySortKey = (typeof STRATEGY_SORTS)[number];
export const DEFAULT_STRATEGY_SORT: StrategySortKey = "best";

export const isStrategySort = (v: unknown): v is StrategySortKey =>
  typeof v === "string" && (STRATEGY_SORTS as readonly string[]).includes(v);

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parse(json: unknown): Record<string, unknown> {
  try {
    return record(JSON.parse(String(json))) ?? {};
  } catch {
    return {};
  }
}

/** The stored sort of a user, or null when none was chosen (or the store cannot be read). */
export async function readStrategySort(
  db: Pick<Client, "execute">,
  userId: number,
): Promise<StrategySortKey | null> {
  try {
    const r = await db.execute({
      sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
      args: [userId],
    });
    const v = r.rows.length ? parse(r.rows[0]!.prefs_json)["strategies_sort"] : null;
    return isStrategySort(v) ? v : null;
  } catch {
    return null;
  }
}

export type SortResult =
  { ok: true; changed: boolean } | { ok: false; error: "invalid" | "forbidden" | "unavailable" };

/** Saves the sort for the actor (the target is always the actor). */
export async function writeStrategySort(
  db: Client,
  env: AuthEnv,
  meta: RequestMeta | undefined,
  actor: { id: number },
  sort: unknown,
  now: Date = new Date(),
): Promise<SortResult> {
  if (!isStrategySort(sort)) return { ok: false, error: "invalid" };
  let tx: Transaction;
  try {
    tx = await db.transaction("write");
  } catch {
    return { ok: false, error: "unavailable" };
  }
  try {
    const who = await tx.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND status = 'active'",
      args: [actor.id],
    });
    if (!who.rows.length) {
      await tx.rollback();
      return { ok: false, error: "forbidden" };
    }
    const cur = await tx.execute({
      sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
      args: [actor.id],
    });
    const stored = cur.rows.length ? parse(cur.rows[0]!.prefs_json) : {};
    if (stored["strategies_sort"] === sort) {
      await tx.rollback();
      return { ok: true, changed: false };
    }
    const at = now.toISOString();
    await tx.execute({
      sql: `INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at`,
      args: [actor.id, JSON.stringify({ ...stored, strategies_sort: sort }), at],
    });
    await auditTx(tx, env, meta ?? NO_META, {
      at,
      actorUserId: actor.id,
      action: "user.preferences_update",
      targetType: "user_preference",
      targetId: String(actor.id),
      detail: { changed: ["strategies_sort"] },
    });
    await tx.commit();
    return { ok: true, changed: true };
  } catch {
    try {
      await tx.rollback();
    } catch {
      // closed below either way
    }
    return { ok: false, error: "unavailable" };
  } finally {
    tx.close();
  }
}
