// alert-flush (M5 T6; docs/M5_design.md 4.1, 4.3; D-096 decisions 9, 40; D-101). Run by the signed
// route `POST /api/internal/alert-flush`, which the Worker slot `alert-flush` (odd minutes, route
// runner, disabled) calls when `worker_state.alert_flush_due` has passed. One call:
//   1. raises alerts for assessments that have none yet (carried items, a missed ingest call);
//   2. raises the regime-transition P1 (UXN-251) for the latest regime row;
//   3. retries a single P0 email whose send is still `claimed` (same key, the email core decides
//      whether the retry gap has passed);
//   4. when the window has closed, sends ONE `p0b:<first key>` email for every pending P0
//      (a lone pending P0 goes out as a normal `p0:` mail), and clears the flush time.
// Idempotent: a second call finds nothing pending. Caps, switch and recipient are the email core's.
import type { Client } from "@libsql/client";
import { melbourneDate, emailKeys } from "@/lib/email/keys";
import { sendEmail, type SendStatus } from "@/lib/email/send";
import { formatMelbourne } from "@/lib/health/format";
import { REGIME_BLOCKS } from "@/lib/agents/families/constants";
import type { Family } from "@/lib/agents/schema";
import type { AlertRow } from "@/lib/sentinel/schema";
import {
  clearFlushDue,
  deliverP0,
  markEmailed,
  MARKET,
  nowOf,
  openWindowEnd,
  P0_PENDING_MAX_MIN,
  p0Facts,
  parseFacts,
  processAssessments,
  readFlushDue,
  RETRY_DUE_MS,
  scheduleFlush,
  sendSingleP0,
  type AlertCtx,
} from "./deliver";
import { alertKeys, regimeTransition, type AlertFacts } from "./tiers";

const MIN_MS = 60_000;
const REGIME_MAX_AGE_DAYS = 3; // threshold-ok: a transition older than this is history, not news

// ---- regime transition P1 (UXN-251) ------------------------------------------------------------

const dayNumber = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/**
 * Writes the P1 `regime:<market>:<d>` alert when the latest regime row differs from the previous
 * session's (both known states). Once per transition: the key carries the date and the insert is
 * ON CONFLICT DO NOTHING. Returns the key when a new row was written.
 */
export async function raiseRegimeAlert(
  ctx: AlertCtx,
  market: string = MARKET,
): Promise<string | null> {
  const now = nowOf(ctx);
  const r = await ctx.db.execute({
    sql:
      "SELECT d, state FROM regime_daily r WHERE market = ? AND version = " +
      "(SELECT MAX(version) FROM regime_daily WHERE market = r.market AND d = r.d) " +
      "ORDER BY d DESC LIMIT 2",
    args: [market],
  });
  if (r.rows.length < 2) return null;
  const cur = { d: String(r.rows[0].d), state: String(r.rows[0].state) };
  const prev = String(r.rows[1].state);
  const t = regimeTransition(prev, cur.state);
  if (t === null) return null;
  if (dayNumber(melbourneDate(now)) - dayNumber(cur.d) > REGIME_MAX_AGE_DAYS) return null;

  const ex = await ctx.db.execute({
    sql: "SELECT id, family, variant FROM execution WHERE market = ? AND kind = 'E' AND status = 'active' ORDER BY id",
    args: [market],
  });
  const gated: NonNullable<AlertFacts["gated"]> = [];
  for (const e of ex.rows) {
    const fam = String(e.family) as Family;
    const blocks = REGIME_BLOCKS[fam]?.includes(t.to as never) ?? false;
    const half = t.to === "SHOCK";
    if (!blocks && !half) continue;
    gated.push({
      id: String(e.id),
      label: `${fam} ${String(e.variant ?? "")}`.trim(),
      effect: blocks ? "no new entries" : "half-size entries",
    });
  }
  const facts: AlertFacts = {
    rule: "p1:regime_transition",
    why:
      `Market regime changed from ${t.from} to ${t.to} on ${cur.d}.` +
      (gated.length ? ` ${gated.length} execution(s) are gated.` : " No execution is gated."),
    executions: [],
    from: t.from,
    to: t.to,
    d: cur.d,
    gated,
  };
  const key = alertKeys.regime(market, cur.d);
  const w = await ctx.db.execute({
    sql:
      "INSERT INTO alert (alert_key, market, code, kind, tier, materiality, published_at, detected_at, facts_json) " +
      "VALUES (?, ?, NULL, 'regime_shift', 'P1', NULL, NULL, ?, ?) ON CONFLICT DO NOTHING",
    args: [key, market, now.toISOString(), JSON.stringify(facts)],
  });
  return w.rowsAffected === 1 ? key : null;
}

// ---- pending P0 --------------------------------------------------------------------------------

async function pendingP0(ctx: AlertCtx): Promise<AlertRow[]> {
  const since = new Date(nowOf(ctx).getTime() - P0_PENDING_MAX_MIN * MIN_MS).toISOString();
  const r = await ctx.db.execute({
    sql:
      "SELECT * FROM alert WHERE tier = 'P0' AND email_key IS NULL AND detected_at >= ? " +
      "ORDER BY detected_at ASC, alert_key ASC",
    args: [since],
  });
  return r.rows as unknown as AlertRow[];
}

async function hasClaimedSingle(db: Client, key: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT 1 FROM email_message WHERE email_key = ? AND status = 'claimed'",
    args: [emailKeys.p0(key)],
  });
  return r.rows.length > 0;
}

const hm = (iso: string): string => /(\d{2}:\d{2}) \S+$/.exec(formatMelbourne(iso))?.[1] ?? "";
const zone = (iso: string): string => /(\S+)$/.exec(formatMelbourne(iso))?.[1] ?? "";

export type FlushResult = {
  status: "idle" | "not_due" | "flushed";
  raised: number;
  regime: string | null;
  retried: number;
  batched: number;
  email: SendStatus | null;
  /** Next flush time (ISO) when one is scheduled. */
  due: string | null;
};

export async function flushAlerts(ctx: AlertCtx): Promise<FlushResult> {
  const now = nowOf(ctx);
  const out: FlushResult = {
    status: "idle",
    raised: 0,
    regime: null,
    retried: 0,
    batched: 0,
    email: null,
    due: null,
  };

  // 1-2. alerts that are still missing
  const p = await processAssessments(ctx);
  out.raised = p.created;
  out.regime = await raiseRegimeAlert(ctx);

  // 3. singles that were claimed but not finished
  let pending = await pendingP0(ctx);
  for (const a of pending) {
    if (await hasClaimedSingle(ctx.db, a.alert_key)) {
      const o = await sendSingleP0(ctx, a);
      out.retried += 1;
      if (o.status === "pending") await scheduleFlush(ctx, new Date(now.getTime() + RETRY_DUE_MS));
    }
  }
  pending = await pendingP0(ctx);
  if (pending.length === 0) {
    const stillDue = await readFlushDue(ctx.db);
    if (stillDue !== null && stillDue.getTime() <= now.getTime()) await clearFlushDue(ctx.db);
    const left = await readFlushDue(ctx.db);
    out.due = left?.toISOString() ?? null;
    out.status = out.due ? "not_due" : "idle";
    return out;
  }

  // 4. wait for the window to close
  const due = await readFlushDue(ctx.db);
  const open = due === null ? await openWindowEnd(ctx) : null;
  const waitUntil = due !== null && due.getTime() > now.getTime() ? due : open;
  if (waitUntil !== null) {
    out.due = (await scheduleFlush(ctx, waitUntil)).toISOString();
    out.status = "not_due";
    return out;
  }

  // The window is closed: send what is pending.
  if (pending.length === 1) {
    const o = await sendSingleP0(ctx, pending[0]);
    out.email = o.status;
    out.batched = 1;
    if (o.status === "pending")
      out.due = (await scheduleFlush(ctx, new Date(now.getTime() + RETRY_DUE_MS))).toISOString();
  } else {
    const first = pending[0];
    const key = emailKeys.p0Batch(first.alert_key);
    const o = await sendEmail(
      {
        db: ctx.db,
        env: ctx.env,
        now: ctx.now,
        provider: ctx.provider,
        sleep: ctx.sleep,
      },
      "p0_batch",
      key,
      {
        window: `${hm(first.detected_at)}-${hm(now.toISOString())} ${zone(now.toISOString())}`,
        alerts: pending.map((a) => p0Facts(a, parseFacts(a.facts_json))),
      },
    );
    out.email = o.status;
    out.batched = pending.length;
    if (
      o.status === "sent" ||
      o.status === "duplicate" ||
      o.status === "suppressed_cap" ||
      o.status === "failed"
    ) {
      await markEmailed(
        ctx.db,
        pending.map((a) => a.alert_key),
        key,
      );
    } else if (o.status === "pending") {
      out.due = (await scheduleFlush(ctx, new Date(now.getTime() + RETRY_DUE_MS))).toISOString();
    }
  }
  if (out.due === null) await clearFlushDue(ctx.db);
  out.status = "flushed";
  return out;
}

export { deliverP0 };
