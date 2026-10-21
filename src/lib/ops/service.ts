// Ops checklist data and the Owner tick (UX-118, OPS-020; M7 T19b; docs/M7_design.md decision 55;
// D-148 draft). Reads `ops_task_done` and `credential_expiry` (names and dates only, no secrets);
// ticking appends ONE row to the append-only `ops_task_done` after the audit event is written (audit
// first; if the insert fails an `ops.task_done_failed` event is added and nothing is ticked). Not a
// trading action, so unlike the arena controls it is allowed while the market is in data-only mode.
import type { Client } from "@libsql/client";
import { appendAudit, auditKey } from "@/lib/db/audit";
import { requireKey, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { can } from "@/lib/auth/permissions";
import type { CurrentUser } from "@/lib/auth/session";
import { getConfig } from "@/lib/config/store";
import {
  buildChecklist,
  isDate,
  melbourneToday,
  tickableDue,
  type DoneRow,
  type TaskRow,
  type TokenRow,
} from "./checklist";

export const OPS_TASK_ID_MAX = 100; // threshold-ok: ops_task_done.task_id length check
const DEFAULT_WARN_DAYS: readonly number[] = [14, 7, 2]; // threshold-ok: SEC-021 default of token_warning_days
const MAX_DONE_ROWS = 400; // threshold-ok: bound of the tick history read
const HTTP_BAD = 400; // threshold-ok: HTTP status
const HTTP_FORBIDDEN = 403; // threshold-ok: HTTP status
const HTTP_CONFLICT = 409; // threshold-ok: HTTP status
const HTTP_UNAVAILABLE = 503; // threshold-ok: HTTP status

export type OpsCtx = {
  readonly mainDb: Client;
  readonly authDb: Client;
  readonly env: AuthEnv;
  readonly meta: RequestMeta;
  readonly now?: () => Date;
};

export type OpsResult = { readonly status: number; readonly body: Record<string, unknown> };
const res = (status: number, body: Record<string, unknown>): OpsResult => ({ status, body });

const str = (v: unknown): string => String(v);

async function warnDays(db: Client): Promise<number[]> {
  try {
    const v = await getConfig(db, "token_warning_days");
    if (Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(x) && x >= 1))
      return v as number[];
  } catch {
    // fall through to the registry default
  }
  return [...DEFAULT_WARN_DAYS];
}

async function readTokens(db: Client): Promise<TokenRow[]> {
  const r = await db.execute("SELECT name, expires_on FROM credential_expiry ORDER BY name");
  return r.rows
    .map((x) => ({ name: str(x.name), expiresOn: str(x.expires_on) }))
    .filter((x) => isDate(x.expiresOn));
}

async function readDone(db: Client): Promise<DoneRow[]> {
  const r = await db.execute({
    sql: "SELECT task_id, due_d, done_at FROM ops_task_done ORDER BY due_d DESC, task_id LIMIT ?",
    args: [MAX_DONE_ROWS],
  });
  return r.rows.map((x) => ({
    taskId: str(x.task_id),
    dueD: str(x.due_d),
    doneAt: str(x.done_at),
  }));
}

export type OpsPage = {
  today: string;
  tasks: TaskRow[];
  tokens: Array<TokenRow & { daysLeft: number }>;
  warnDays: number[];
};

/** The Owner's checklist for the Melbourne day of `now`. */
export async function loadOps(db: Client, now: Date): Promise<OpsPage> {
  const today = melbourneToday(now);
  const [tokens, done, warn] = await Promise.all([readTokens(db), readDone(db), warnDays(db)]);
  const dayMs = 86_400_000; // threshold-ok: unit conversion
  return {
    today,
    tasks: buildChecklist(today, done, tokens, warn),
    tokens: tokens
      .map((t) => ({
        ...t,
        daysLeft: Math.round(
          (Date.parse(`${t.expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs,
        ),
      }))
      .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.name.localeCompare(b.name)),
    warnDays: warn,
  };
}

export type TickInput = { taskId: unknown; dueD: unknown };

/**
 * Owner only. Validation (no I/O) -> the task and its tickable date must match today's checklist ->
 * not already ticked -> audit event -> insert. Error codes: invalid, forbidden, unknown_task, not_due,
 * already_done, unavailable.
 */
export async function tickOpsTask(c: OpsCtx, user: CurrentUser, b: TickInput): Promise<OpsResult> {
  if (!can(user.role, "admin")) return res(HTTP_FORBIDDEN, { error: "forbidden" });
  if (
    typeof b.taskId !== "string" ||
    b.taskId.length === 0 ||
    b.taskId.length > OPS_TASK_ID_MAX ||
    !/^[a-z0-9_]+$/.test(b.taskId) ||
    !isDate(b.dueD)
  )
    return res(HTTP_BAD, { error: "invalid" });
  const taskId = b.taskId;
  const dueD = b.dueD;
  const now = c.now ? c.now() : new Date();
  let tokens: TokenRow[];
  let warn: number[];
  let existing: boolean;
  try {
    [tokens, warn] = await Promise.all([readTokens(c.mainDb), warnDays(c.mainDb)]);
    const e = await c.mainDb.execute({
      sql: "SELECT 1 FROM ops_task_done WHERE task_id = ? AND due_d = ?",
      args: [taskId, dueD],
    });
    existing = e.rows.length > 0;
  } catch {
    return res(HTTP_UNAVAILABLE, { error: "unavailable" });
  }
  const today = melbourneToday(now);
  const known = buildChecklist(today, [], tokens, warn).some((r) => r.id === taskId);
  if (!known) return res(HTTP_BAD, { error: "unknown_task" });
  if (tickableDue(taskId, today, tokens, warn) !== dueD)
    return res(HTTP_CONFLICT, { error: "not_due" });
  if (existing) return res(HTTP_CONFLICT, { error: "already_done" });

  const at = now.toISOString();
  const ev = (action: string, detail: Record<string, unknown>) =>
    appendAudit(c.authDb, auditKey(requireKey(c.env)), {
      at,
      actorUserId: user.id,
      action,
      targetType: "ops_task",
      targetId: `${taskId}:${dueD}`,
      detail,
      ip: c.meta.ip,
      userAgent: c.meta.userAgent,
    });
  let id: number;
  try {
    id = await ev("ops.task_done", { taskId, dueD });
  } catch {
    return res(HTTP_UNAVAILABLE, { error: "unavailable" }); // nothing has changed
  }
  try {
    await c.mainDb.execute({
      sql: "INSERT INTO ops_task_done (task_id, due_d, done_by, done_at, audit_ref) VALUES (?, ?, ?, ?, ?)",
      args: [taskId, dueD, user.id, at, `audit:${id}`],
    });
  } catch {
    try {
      await ev("ops.task_done_failed", { taskId, dueD, auditId: id });
    } catch {
      // best effort: the tick did not happen either way
    }
    let raced = false;
    try {
      const e = await c.mainDb.execute({
        sql: "SELECT 1 FROM ops_task_done WHERE task_id = ? AND due_d = ?",
        args: [taskId, dueD],
      });
      raced = e.rows.length > 0; // another tick won the race
    } catch {
      raced = false;
    }
    return raced
      ? res(HTTP_CONFLICT, { error: "already_done" })
      : res(HTTP_UNAVAILABLE, { error: "unavailable" });
  }
  return res(200, { ok: true, auditId: id });
}
