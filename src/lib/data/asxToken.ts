// ASX rate token: app-side read model for System Health and the Owner's trip reset (M2 T4,
// DAT-122 / DAT-123). The Worker (worker/src/asx/*) owns every write to `asx_rate_token`, the
// outcome rows and the trip; this file reads them and offers ONE write, `resetAsxTrip`.
// The constants below are copies of worker/src/asx/policy.ts (the app may not import from the
// Worker and the Worker may not import from here); tests/data/asxToken.test.ts proves they agree.
//
// Reset (DAT-123, OPS-036): clears `tripped` only; it never touches an Owner-set `off` and never
// turns `asx_enabled` on. Atomicity is the D-047 / calendarAdmin.ts pattern: the audit event
// `asx.trip_reset` (auth DB) is appended FIRST; if that fails nothing has changed. Then the status
// row and the outcome rows are changed in ONE write transaction; if that fails, a compensating
// `asx.trip_reset_failed` event is appended (best effort). The outcome rows of the last hour are
// deleted with the reset, otherwise the same rows would trip the source again at once. A second
// reset finds nothing tripped and writes nothing (idempotent).
import type { Client } from "@libsql/client";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { marketDate } from "./calendar";

export const ASX_SOURCE = "asx_announcements";
export const ASX_MIN_SPACING_S = 65;
export const ASX_DAILY_CAP = 720;
export const ASX_TRIP_PERCENT = 5;
export const ASX_TRIP_WINDOW_MS = 3_600_000;
export const ASX_TRIP_MIN_SAMPLE = 10;

const ENABLED_KEY = "asx_enabled";
const NEXT_ALLOWED_KEY = "asx:next_allowed_at";
const OUTCOME_PREFIX = "asxout:";
const OUTCOME_UPPER = "asxout;"; // ';' sorts right after ':'

export type AsxSourceMode = "on" | "off" | "degraded" | "tripped";

export type AsxTokenView = {
  /** worker_state.asx_enabled (default off). */
  enabled: boolean;
  sourceMode: AsxSourceMode | null;
  tripped: boolean;
  trippedSince: string | null;
  trippedReason: string | null;
  lastRequestAt: string | null;
  /** Sydney date the count belongs to (today), and today's grants so far. */
  today: string;
  todayCount: number;
  cap: number;
  remainingToday: number;
  /** A Retry-After wait that is still in the future, else null. */
  nextAllowedAt: string | null;
  /** Requests recorded in the last hour, and how many of them were 403/challenge. */
  requestsLastHour: number;
  blockedLastHour: number;
};

const parseOn = (raw: unknown): boolean => {
  if (typeof raw !== "string") return false;
  try {
    const v: unknown = JSON.parse(raw);
    return v === "1" || v === 1 || v === true;
  } catch {
    return false;
  }
};

const parseMode = (v: unknown): AsxSourceMode | null =>
  v === "on" || v === "off" || v === "degraded" || v === "tripped" ? v : null;

const unquote = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
};

/** Read-only view for System Health. Throws on a database error (the caller shows "unknown"). */
export async function loadAsxTokenView(
  db: Pick<Client, "execute">,
  now: Date = new Date(),
): Promise<AsxTokenView> {
  const nowIso = now.toISOString();
  const today = marketDate(now, "Australia/Sydney");
  const since = OUTCOME_PREFIX + new Date(now.getTime() - ASX_TRIP_WINDOW_MS).toISOString();
  const res = await db.execute({
    sql:
      "SELECT t.last_request_at AS last_request_at, t.day_count_date AS day_count_date, " +
      "t.day_count AS day_count, " +
      "(SELECT value_json FROM worker_state WHERE key = ?) AS enabled_raw, " +
      "(SELECT value_json FROM worker_state WHERE key = ?) AS next_raw, " +
      "s.mode AS mode, s.since AS since, s.reason AS reason, " +
      "(SELECT COUNT(*) FROM worker_state WHERE key > ? AND key < ?) AS total, " +
      "(SELECT COUNT(*) FROM worker_state WHERE key > ? AND key < ? AND value_json = '\"blocked\"') " +
      "AS blocked " +
      "FROM asx_rate_token t LEFT JOIN source_status s ON s.source = ? WHERE t.id = 1",
    args: [ENABLED_KEY, NEXT_ALLOWED_KEY, since, OUTCOME_UPPER, since, OUTCOME_UPPER, ASX_SOURCE],
  });
  const r = res.rows[0];
  if (!r) throw new Error("asx_rate_token row missing");
  const count = r.day_count_date === today ? Number(r.day_count) : 0;
  const mode = parseMode(r.mode);
  const next = unquote(r.next_raw);
  return {
    enabled: parseOn(r.enabled_raw),
    sourceMode: mode,
    tripped: mode === "tripped",
    trippedSince: mode === "tripped" && typeof r.since === "string" ? r.since : null,
    trippedReason: mode === "tripped" && typeof r.reason === "string" ? r.reason : null,
    lastRequestAt: typeof r.last_request_at === "string" ? r.last_request_at : null,
    today,
    todayCount: count,
    cap: ASX_DAILY_CAP,
    remainingToday: Math.max(0, ASX_DAILY_CAP - count),
    nextAllowedAt: next !== null && next > nowIso ? next : null,
    requestsLastHour: Number(r.total),
    blockedLastHour: Number(r.blocked),
  };
}

export type ResetError = "forbidden" | "unavailable";
export type ResetResult = { ok: true; reset: boolean } | { ok: false; error: ResetError };

export type ResetInput = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  now?: Date;
};

const fail = (error: ResetError): ResetResult => ({ ok: false, error });

/** Owner-only: clear a tripped ASX source (service function; the System Health button is T10). */
export async function resetAsxTrip(p: ResetInput): Promise<ResetResult> {
  const meta = p.meta ?? NO_META;
  const now = (p.now ?? new Date()).toISOString();

  // Defence in depth: the caller passed requireUser("admin"); the actor must still be an active Owner.
  try {
    const r = await p.authDb.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND role = 'owner' AND status = 'active'",
      args: [p.actorId],
    });
    if (r.rows.length !== 1) return fail("forbidden");
  } catch {
    return fail("unavailable");
  }

  let reason: string | null = null;
  try {
    const res = await p.mainDb.execute({
      sql: "SELECT mode, reason FROM source_status WHERE source = ?",
      args: [ASX_SOURCE],
    });
    if (res.rows.length !== 1 || res.rows[0].mode !== "tripped") return { ok: true, reset: false };
    reason = typeof res.rows[0].reason === "string" ? res.rows[0].reason : null;
  } catch {
    return fail("unavailable");
  }

  const base = { at: now, actorUserId: p.actorId, targetType: "source", targetId: ASX_SOURCE };
  try {
    await audit(p.authDb, p.env, meta, {
      ...base,
      action: "asx.trip_reset",
      detail: { source: ASX_SOURCE, reason },
    });
  } catch {
    return fail("unavailable"); // nothing has changed
  }

  try {
    const tx = await p.mainDb.transaction("write");
    try {
      await tx.execute({
        sql:
          "UPDATE source_status SET mode = 'on', since = ?, reason = NULL, tripped_by = NULL " +
          "WHERE source = ? AND mode = 'tripped'",
        args: [now, ASX_SOURCE],
      });
      await tx.execute({
        sql: "DELETE FROM worker_state WHERE key >= ? AND key < ?",
        args: [OUTCOME_PREFIX, OUTCOME_UPPER],
      });
      await tx.execute({
        sql: "DELETE FROM worker_state WHERE key = ?",
        args: [NEXT_ALLOWED_KEY],
      });
      await tx.commit();
    } finally {
      tx.close();
    }
    return { ok: true, reset: true };
  } catch {
    try {
      await audit(p.authDb, p.env, meta, {
        ...base,
        action: "asx.trip_reset_failed",
        detail: { source: ASX_SOURCE },
      });
    } catch {
      // best effort: the reset did not happen either way
    }
    return fail("unavailable");
  }
}
