// Steelman rule-review suggestions (M11-lite WP4; AGT-133a, UXN-287; D-492). One suggestion per shown
// monitorable bear point, listed for the Owner on /review. A suggestion never changes a rule or a breaker:
// the Owner opens the rule editor himself, or dismisses it (audited). Open suggestions expire after
// `steelman_suggestion_expiry_sessions` trading sessions, closed by the night stage ('system').
import type { Client } from "@libsql/client";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import {
  closeSuggestion,
  insertSuggestion,
  readOpenSuggestions,
  readShownPoints,
  readSuggestion,
  type Exec,
  type SuggestionRow,
} from "./store";
import type { Subject } from "./subjects";

export const SYSTEM_ACTOR = "system";

export function openSuggestions(db: Exec, market: string): Promise<SuggestionRow[]> {
  return readOpenSuggestions(db, market);
}

/** The strategy family of a card, from its stored JSON; null when there is no card or no family. */
async function familyOf(db: Exec, cardId: string | null): Promise<string | null> {
  if (cardId === null) return null;
  const r = await db.execute({
    sql: "SELECT card_json FROM decision_card WHERE id = ?",
    args: [cardId],
  });
  if (!r.rows[0]) return null;
  try {
    const f = (JSON.parse(String(r.rows[0].card_json)) as { family?: unknown }).family;
    return typeof f === "string" && f !== "" ? f : null;
  } catch {
    return null;
  }
}

/**
 * Lists the shown monitorable bear points of a written pack as open suggestions (idempotent by point id).
 * A subject without a card has no family to point the rule editor at, so it gets none. Returns the count
 * of new rows.
 */
export async function createSuggestions(
  db: Exec,
  o: { market: string; d: string; subject: Subject; packId: string; now: string },
): Promise<number> {
  const family = await familyOf(db, o.subject.cardId);
  if (family === null) return 0;
  let made = 0;
  for (const p of await readShownPoints(db, o.packId)) {
    if (p.side !== "bear" || !p.monitorable) continue;
    const r = await insertSuggestion(db, {
      market: o.market,
      d: o.d,
      pointId: p.pointId,
      cardId: o.subject.cardId,
      code: o.subject.code,
      family,
      createdAt: o.now,
    });
    if (r.inserted) made += 1;
  }
  return made;
}

/**
 * Expires open suggestions made `sessions` or more trading sessions before `d` (the creation session is
 * not counted: a suggestion made on session S expires on the night `sessions` sessions after S).
 */
export async function expireSuggestions(
  db: Exec,
  market: string,
  d: string,
  calendar: readonly CalendarRow[],
  sessions: number,
  now: string,
): Promise<number> {
  let n = 0;
  for (const s of await readOpenSuggestions(db, market)) {
    if (s.d >= d) continue;
    const age = sessionsBetween(s.d, d, calendar).length - 1;
    if (
      age >= sessions &&
      (await closeSuggestion(db, s.suggestionId, "expired", now, SYSTEM_ACTOR))
    ) {
      n += 1;
    }
  }
  return n;
}

export type DismissInput = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  id: unknown;
  now?: Date;
};
export type DismissResult =
  { ok: true } | { error: "invalid" | "forbidden" | "not_found" | "not_open" | "unavailable" };

/**
 * The Owner dismisses a suggestion. The audit row (auth DB) is appended FIRST; if that fails nothing has
 * changed. Then the status moves open to dismissed (main DB); if that fails a compensating audit event is
 * appended (best effort). Two databases, so no single transaction (same rule as D-047).
 */
export async function dismissSuggestion(x: DismissInput): Promise<DismissResult> {
  const meta = x.meta ?? NO_META;
  const at = (x.now ?? new Date()).toISOString();
  try {
    const r = await x.authDb.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND role = 'owner' AND status = 'active'",
      args: [x.actorId],
    });
    if (r.rows.length !== 1) return { error: "forbidden" };
  } catch {
    return { error: "unavailable" };
  }
  if (typeof x.id !== "string" || x.id === "") return { error: "invalid" };
  let row: SuggestionRow | null;
  try {
    row = await readSuggestion(x.mainDb, x.id);
  } catch {
    return { error: "unavailable" };
  }
  if (row === null) return { error: "not_found" };
  if (row.status !== "open") return { error: "not_open" };
  const base = {
    at,
    actorUserId: x.actorId,
    targetType: "steelman_suggestion",
    targetId: row.suggestionId,
    detail: { code: row.code, d: row.d, family: row.family },
  };
  try {
    await audit(x.authDb, x.env, meta, { ...base, action: "steelman_suggestion_dismiss" });
  } catch {
    return { error: "unavailable" };
  }
  try {
    const closed = await closeSuggestion(
      x.mainDb,
      row.suggestionId,
      "dismissed",
      at,
      String(x.actorId),
    );
    if (!closed) return { error: "not_open" };
    return { ok: true };
  } catch {
    try {
      await audit(x.authDb, x.env, meta, { ...base, action: "steelman_suggestion_dismiss_failed" });
    } catch {
      // best effort: the dismissal did not happen either way
    }
    return { error: "unavailable" };
  }
}
