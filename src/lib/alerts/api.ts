// Alert inbox back end for the signed-in user (M5 T6; UX-052, UXN-157/160/161/251, ROL-102a,
// ROL-104; docs/M5_design.md 4.3; D-096 decisions 6, 32; D-101). Screens are M7; this is the data
// and the three own-row actions they will call:
//   GET  /api/alerts?tier=&unacked=            the inbox and the unread badge count
//   POST /api/alerts/<key>/ack                 acknowledge (final; the badge clears only here)
//   POST /api/alerts/<key>/snooze  {until}     snooze (P1/P2 only), `until: null` clears it
//   GET|POST /api/alerts/quiet-hours           quiet hours (Melbourne local, may wrap midnight)
// Per-user state lives in the AUTH database (`alert_user_state`, quiet hours inside the validated
// `user_preference.prefs_json`), so a user changes only their own rows: the actor is always the
// session user, never a field of the request. Every change and its audit event commit together.
// Quiet hours, snooze and the per-tier `digest` preference hide P1/P2 from the BADGE only; P0 and
// the regime-shift P1 are never hidden (UXN-160, UXN-251) and cannot be snoozed.
import type { Client, Transaction } from "@libsql/client";
import { auditTx, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { getPreferences } from "@/lib/preferences/service";
import { isOpaqueAlertKey, maskAlertViews, resolveAlertKey } from "@/lib/view/alerts";
import { maskContextFor } from "@/lib/view/mask";
import type { AlertKind, AlertRow, AlertTier } from "@/lib/sentinel/schema";
import { ALERT_TIERS } from "@/lib/sentinel/schema";
import { parseFacts } from "./deliver";
import { alertKeyKind, neverSuppressed, rulesText, type AlertFacts } from "./tiers";

/** Longest snooze a user can set on one alert, in days. */
export const SNOOZE_MAX_DAYS = 7; // threshold-ok: UXN-160 gives no figure; D-101
/** Alerts older than this do not count in the badge. */
export const BADGE_WINDOW_DAYS = 14; // threshold-ok: inbox horizon, D-101
const LIST_MAX = 200;
const DAY_MS = 86_400_000;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const INBOX_SCAN = 500; // threshold-ok: rows scanned before the unacked filter

// ---- quiet hours -------------------------------------------------------------------------------

export type QuietHours = { start: string; end: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const minutesOf = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

export function parseQuietHours(v: unknown): QuietHours | null {
  if (!isRecord(v)) return null;
  const { start, end } = v;
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!HM_RE.test(start) || !HM_RE.test(end) || start === end) return null;
  return { start, end };
}

const melFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Australia/Melbourne",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Melbourne minute of the day of an instant. */
export function melbourneMinute(at: Date): number {
  const p = Object.fromEntries(melFmt.formatToParts(at).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

/** True inside [start, end) in Melbourne local time; a window with start > end wraps midnight. */
export function inQuietHours(at: Date, q: QuietHours | null): boolean {
  if (q === null) return false;
  const m = melbourneMinute(at);
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

export async function getQuietHours(
  db: Pick<Client, "execute">,
  userId: number,
): Promise<QuietHours | null> {
  const r = await db.execute({
    sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
    args: [userId],
  });
  if (!r.rows.length) return null;
  try {
    const v: unknown = JSON.parse(String(r.rows[0].prefs_json));
    return isRecord(v) ? parseQuietHours(v.quiet_hours) : null;
  } catch {
    return null;
  }
}

// ---- the inbox ---------------------------------------------------------------------------------

export type AlertView = {
  key: string;
  tier: AlertTier;
  kind: AlertKind;
  market: string;
  code: string | null;
  text: string;
  why: string;
  executions: AlertFacts["executions"];
  detectedAt: string;
  publishedAt: string | null;
  ackedAt: string | null;
  snoozedUntil: string | null;
};

export type InboxDeps = { mainDb: Pick<Client, "execute">; authDb: Pick<Client, "execute"> };

type UserState = { acked_at: string | null; snoozed_until: string | null };

async function userStates(
  authDb: Pick<Client, "execute">,
  userId: number,
  keys: readonly string[],
): Promise<Map<string, UserState>> {
  const m = new Map<string, UserState>();
  for (let i = 0; i < keys.length; i += 100) {
    const slice = keys.slice(i, i + 100);
    const r = await authDb.execute({
      sql:
        "SELECT alert_key, acked_at, snoozed_until FROM alert_user_state WHERE user_id = ? " +
        `AND alert_key IN (${slice.map(() => "?").join(",")})`,
      args: [userId, ...slice],
    });
    for (const x of r.rows) {
      m.set(String(x.alert_key), {
        acked_at: x.acked_at === null ? null : String(x.acked_at),
        snoozed_until: x.snoozed_until === null ? null : String(x.snoozed_until),
      });
    }
  }
  return m;
}

function view(a: AlertRow, s: UserState | undefined): AlertView {
  const f = parseFacts(a.facts_json);
  return {
    key: a.alert_key,
    tier: a.tier,
    kind: a.kind,
    market: a.market,
    code: a.code,
    text: a.text_llm ?? rulesText(a.tier, a.kind, a.code, f),
    why: f.why,
    executions: f.executions,
    detectedAt: a.detected_at,
    publishedAt: a.published_at,
    ackedAt: s?.acked_at ?? null,
    snoozedUntil: s?.snoozed_until ?? null,
  };
}

/**
 * Does an alert count in this user's unread badge now? Acknowledged: no. P0 and the regime P1:
 * always. Otherwise a `digest` preference, an active snooze or quiet hours keep it out.
 */
export function countsInBadge(
  a: Pick<AlertView, "tier" | "kind" | "ackedAt" | "snoozedUntil">,
  prefs: { alert_p1: string; alert_p2: string },
  quiet: QuietHours | null,
  now: Date,
): boolean {
  if (a.ackedAt !== null) return false;
  if (neverSuppressed(a.tier, a.kind)) return true;
  const pref = a.tier === "P1" ? prefs.alert_p1 : prefs.alert_p2;
  if (pref === "digest") return false;
  if (a.snoozedUntil !== null && Date.parse(a.snoozedUntil) > now.getTime()) return false;
  return !inQuietHours(now, quiet);
}

export type InboxOptions = { tier?: AlertTier; unacked?: boolean; limit?: number };

export async function listInbox(
  deps: InboxDeps,
  userId: number,
  o: InboxOptions = {},
  now: Date = new Date(),
): Promise<{ alerts: AlertView[]; badge: number }> {
  const since = new Date(now.getTime() - BADGE_WINDOW_DAYS * DAY_MS).toISOString();
  const r = await deps.mainDb.execute({
    sql:
      "SELECT * FROM alert WHERE detected_at >= ? " +
      (o.tier ? "AND tier = ? " : "") +
      "ORDER BY detected_at DESC, alert_key DESC LIMIT ?",
    args: o.tier ? [since, o.tier, INBOX_SCAN] : [since, INBOX_SCAN],
  });
  const rows = r.rows as unknown as AlertRow[];
  const states = await userStates(
    deps.authDb,
    userId,
    rows.map((a) => a.alert_key),
  );
  const views = rows.map((a) => view(a, states.get(a.alert_key)));
  const prefs = await getPreferences(deps.authDb, userId);
  const quiet = await getQuietHours(deps.authDb, userId);
  // The badge counts every tier, whatever the list filter says.
  let badge = 0;
  if (o.tier) {
    const all = await deps.mainDb.execute({
      sql: "SELECT * FROM alert WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT ?",
      args: [since, INBOX_SCAN],
    });
    const arows = all.rows as unknown as AlertRow[];
    const ast = await userStates(
      deps.authDb,
      userId,
      arows.map((a) => a.alert_key),
    );
    for (const a of arows) {
      if (countsInBadge(view(a, ast.get(a.alert_key)), prefs, quiet, now)) badge += 1;
    }
  } else {
    for (const v of views) if (countsInBadge(v, prefs, quiet, now)) badge += 1;
  }
  const shown = (o.unacked ? views.filter((v) => v.ackedAt === null) : views).slice(
    0,
    Math.min(Math.max(o.limit ?? 100, 1), LIST_MAX),
  );
  return { alerts: shown, badge };
}

// ---- own-row changes (state + audit in one transaction) ----------------------------------------

export type ActionError = "invalid" | "not_found" | "not_snoozable" | "forbidden" | "unavailable";
export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: ActionError };

export type ActionDeps = {
  mainDb: Pick<Client, "execute">;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  now?: () => Date;
};

async function inTx<T>(
  db: Client,
  fn: (tx: Transaction) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  let tx: Transaction;
  try {
    tx = await db.transaction("write");
  } catch {
    return { ok: false, error: "unavailable" };
  }
  try {
    const r = await fn(tx);
    if (r.ok) await tx.commit();
    else await tx.rollback();
    return r;
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

const activeUser = async (tx: Transaction, id: number): Promise<boolean> =>
  (
    await tx.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND status = 'active'",
      args: [id],
    })
  ).rows.length > 0;

async function findAlert(
  db: Pick<Client, "execute">,
  key: string,
): Promise<{ tier: AlertTier; kind: AlertKind } | null> {
  const r = await db.execute({
    sql: "SELECT tier, kind FROM alert WHERE alert_key = ?",
    args: [key],
  });
  if (!r.rows.length) return null;
  const tier = String(r.rows[0].tier);
  if (!(ALERT_TIERS as readonly string[]).includes(tier)) return null;
  return { tier: tier as AlertTier, kind: String(r.rows[0].kind) as AlertKind };
}

// The inbox shows a masked user an opaque `mk:` key where the stored key would carry a stock code or
// a trade id (view/alerts.ts); the own-row actions accept either form and work on the stored key.
async function storedKey(deps: ActionDeps, given: string): Promise<string | null> {
  if (!isOpaqueAlertKey(given)) return given;
  try {
    return await resolveAlertKey(deps.mainDb, given, (deps.now ?? (() => new Date()))());
  } catch {
    return null;
  }
}

export async function ackAlert(
  deps: ActionDeps,
  actor: { id: number },
  given: string,
): Promise<ActionResult<{ ackedAt: string; changed: boolean }>> {
  const key = await storedKey(deps, given);
  if (key === null) return { ok: false, error: "not_found" };
  if (alertKeyKind(key) === null || key.length > 300) return { ok: false, error: "invalid" };
  let found;
  try {
    found = await findAlert(deps.mainDb, key);
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (found === null) return { ok: false, error: "not_found" };
  const at = (deps.now ?? (() => new Date()))().toISOString();
  return inTx<{ ackedAt: string; changed: boolean }>(deps.authDb, async (tx) => {
    if (!(await activeUser(tx, actor.id))) return { ok: false, error: "forbidden" };
    const cur = await tx.execute({
      sql: "SELECT acked_at FROM alert_user_state WHERE user_id = ? AND alert_key = ?",
      args: [actor.id, key],
    });
    const had = cur.rows.length ? cur.rows[0].acked_at : null;
    if (typeof had === "string") return { ok: true, ackedAt: had, changed: false };
    await tx.execute({
      sql:
        "INSERT INTO alert_user_state (user_id, alert_key, acked_at, snoozed_until, updated_at) " +
        "VALUES (?, ?, ?, NULL, ?) ON CONFLICT (user_id, alert_key) DO UPDATE SET " +
        "acked_at = COALESCE(alert_user_state.acked_at, excluded.acked_at), " +
        "updated_at = MAX(alert_user_state.updated_at, excluded.updated_at)",
      args: [actor.id, key, at, at],
    });
    await auditTx(tx, deps.env, deps.meta ?? NO_META, {
      at,
      actorUserId: actor.id,
      action: "alert.ack",
      targetType: "alert",
      targetId: key,
      detail: { tier: found.tier },
    });
    return { ok: true, ackedAt: at, changed: true };
  });
}

export async function snoozeAlert(
  deps: ActionDeps,
  actor: { id: number },
  given: string,
  until: string | null,
): Promise<ActionResult<{ snoozedUntil: string | null }>> {
  const key = await storedKey(deps, given);
  if (key === null) return { ok: false, error: "not_found" };
  if (alertKeyKind(key) === null || key.length > 300) return { ok: false, error: "invalid" };
  const now = (deps.now ?? (() => new Date()))();
  let untilIso: string | null = null;
  if (until !== null) {
    const t = typeof until === "string" ? Date.parse(until) : NaN;
    if (!Number.isFinite(t)) return { ok: false, error: "invalid" };
    if (t <= now.getTime() || t > now.getTime() + SNOOZE_MAX_DAYS * DAY_MS) {
      return { ok: false, error: "invalid" };
    }
    untilIso = new Date(t).toISOString();
  }
  let found;
  try {
    found = await findAlert(deps.mainDb, key);
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (found === null) return { ok: false, error: "not_found" };
  // UXN-160 / UXN-251: P0 and the regime P1 can never be silenced.
  if (neverSuppressed(found.tier, found.kind)) return { ok: false, error: "not_snoozable" };
  const at = now.toISOString();
  return inTx<{ snoozedUntil: string | null }>(deps.authDb, async (tx) => {
    if (!(await activeUser(tx, actor.id))) return { ok: false, error: "forbidden" };
    await tx.execute({
      sql:
        "INSERT INTO alert_user_state (user_id, alert_key, acked_at, snoozed_until, updated_at) " +
        "VALUES (?, ?, NULL, ?, ?) ON CONFLICT (user_id, alert_key) DO UPDATE SET " +
        "snoozed_until = excluded.snoozed_until, " +
        "updated_at = MAX(alert_user_state.updated_at, excluded.updated_at)",
      args: [actor.id, key, untilIso, at],
    });
    await auditTx(tx, deps.env, deps.meta ?? NO_META, {
      at,
      actorUserId: actor.id,
      action: "alert.snooze",
      targetType: "alert",
      targetId: key,
      detail: { cleared: untilIso === null },
    });
    return { ok: true, snoozedUntil: untilIso };
  });
}

/** `null` clears quiet hours. Stored in the user's validated prefs_json beside the D-048 fields. */
export async function setQuietHours(
  deps: Pick<ActionDeps, "authDb" | "env" | "meta" | "now">,
  actor: { id: number },
  q: unknown,
): Promise<ActionResult<{ quietHours: QuietHours | null }>> {
  let next: QuietHours | null = null;
  if (q !== null) {
    next = parseQuietHours(q);
    if (next === null) return { ok: false, error: "invalid" };
  }
  const at = (deps.now ?? (() => new Date()))().toISOString();
  return inTx<{ quietHours: QuietHours | null }>(deps.authDb, async (tx) => {
    if (!(await activeUser(tx, actor.id))) return { ok: false, error: "forbidden" };
    const cur = await tx.execute({
      sql: "SELECT prefs_json FROM user_preference WHERE user_id = ?",
      args: [actor.id],
    });
    let obj: Record<string, unknown> = {};
    if (cur.rows.length) {
      try {
        const v: unknown = JSON.parse(String(cur.rows[0].prefs_json));
        if (isRecord(v)) obj = v;
      } catch {
        obj = {};
      }
    }
    if (next === null) delete obj.quiet_hours;
    else obj.quiet_hours = next;
    await tx.execute({
      sql:
        "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json, updated_at = excluded.updated_at",
      args: [actor.id, JSON.stringify(obj), at],
    });
    await auditTx(tx, deps.env, deps.meta ?? NO_META, {
      at,
      actorUserId: actor.id,
      action: "alert.quiet_hours",
      targetType: "user_preference",
      targetId: String(actor.id),
      detail: { cleared: next === null },
    });
    return { ok: true, quietHours: next };
  });
}

// ---- HTTP -------------------------------------------------------------------------------------

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const STATUS: Record<ActionError, number> = {
  invalid: 400,
  not_found: 404,
  not_snoozable: 409,
  forbidden: 403,
  unavailable: 503,
};

export function errorResponse(e: ActionError): Response {
  return json(STATUS[e], { error: e });
}

export async function handleList(
  deps: InboxDeps,
  user: { id: number; role?: string | null },
  url: URL,
  now?: Date,
): Promise<Response> {
  const tier = url.searchParams.get("tier");
  if (tier !== null && !(ALERT_TIERS as readonly string[]).includes(tier)) {
    return errorResponse("invalid");
  }
  const un = url.searchParams.get("unacked");
  if (un !== null && un !== "1" && un !== "true" && un !== "0" && un !== "false") {
    return errorResponse("invalid");
  }
  try {
    const r = await listInbox(
      deps,
      user.id,
      { tier: (tier as AlertTier | null) ?? undefined, unacked: un === "1" || un === "true" },
      now,
    );
    // DAT-124 / ROL-107: codes, names, prices and links never leave the server for a masked user. A
    // missing role masks; a failure while masking is an error, never an unmasked body.
    const ctx = await maskContextFor(
      user.role ? { id: user.id, role: user.role } : null,
      deps.authDb,
      now,
    );
    if (!ctx.masked) return json(200, r);
    return json(200, { ...r, alerts: await maskAlertViews(deps.mainDb, r.alerts) });
  } catch {
    return errorResponse("unavailable");
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.text();
    if (raw.length > 1024) return null;
    const v: unknown = raw === "" ? {} : JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

export async function handleAck(
  deps: ActionDeps,
  user: { id: number },
  key: string,
): Promise<Response> {
  const r = await ackAlert(deps, user, key);
  return r.ok ? json(200, { ackedAt: r.ackedAt, changed: r.changed }) : errorResponse(r.error);
}

export async function handleSnooze(
  deps: ActionDeps,
  user: { id: number },
  key: string,
  body: Record<string, unknown> | null,
): Promise<Response> {
  if (body === null || !("until" in body)) return errorResponse("invalid");
  const until = body.until;
  if (until !== null && typeof until !== "string") return errorResponse("invalid");
  const r = await snoozeAlert(deps, user, key, until);
  return r.ok ? json(200, { snoozedUntil: r.snoozedUntil }) : errorResponse(r.error);
}

export async function handleQuietHours(
  deps: ActionDeps,
  user: { id: number },
  req: Request,
): Promise<Response> {
  if (req.method === "GET") {
    try {
      return json(200, { quietHours: await getQuietHours(deps.authDb, user.id) });
    } catch {
      return errorResponse("unavailable");
    }
  }
  const body = await readJson(req);
  if (body === null) return errorResponse("invalid");
  const r = await setQuietHours(deps, user, "quietHours" in body ? body.quietHours : undefined);
  return r.ok ? json(200, { quietHours: r.quietHours }) : errorResponse(r.error);
}
