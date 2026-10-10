// Owner decisions on queued corporate actions (DAT-221, UX-114, ROL-102a). Confirm or reject.
//
// Atomicity (two databases, so no single transaction; same rule as D-047 and calendarAdmin): the
// audit event `corporate_action.confirm` or `corporate_action.reject` (auth DB) is appended
// FIRST. If that fails nothing has changed. Only then is the decision written to the main DB (one
// write transaction in resolveAction: the new event row, plus superseding events for open
// siblings); if that fails a compensating `..._failed` audit event is appended (best effort). A
// decision never exists without an audit row. The decision is an appended event; nothing is
// edited. Factors, entry blocks and the quality re-evaluation follow in `settle` (idempotent; if
// it fails the decision stands and the next nightly run completes it).
import type { Client } from "@libsql/client";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { sydneyDate } from "../pipeline/rules.mjs";
import { resolveAction, settle } from "./engine.mjs";
import { stateOf } from "./rules.mjs";

export const REVIEW_MARKET = "AU";

export type ResolveError =
  "invalid" | "forbidden" | "not_found" | "not_open" | "conflicts_with_confirmed" | "unavailable";
export type ResolveResult = { ok: true; settled: boolean } | { ok: false; error: ResolveError };

export type ResolveInput = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  actionId: unknown;
  decision: unknown;
  now?: Date;
};

const fail = (error: ResolveError): ResolveResult => ({ ok: false, error });

export async function resolveCorporateAction(p: ResolveInput): Promise<ResolveResult> {
  const meta = p.meta ?? NO_META;
  const nowDate = p.now ?? new Date();
  const now = nowDate.toISOString();

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

  if (p.decision !== "confirm" && p.decision !== "reject") return fail("invalid");
  const decision = p.decision;
  if (typeof p.actionId !== "number" || !Number.isSafeInteger(p.actionId) || p.actionId < 1) {
    return fail("invalid");
  }
  const actionId = p.actionId;

  // Look before the audit: an unknown or already-decided item writes and audits nothing.
  let detail: { code: string; type: string; ex_date: string };
  try {
    const r = await p.mainDb.execute({
      sql: `SELECT a.code AS code, a.type AS type, a.ex_date AS ex_date,
              (SELECT e.status FROM corporate_action_event e WHERE e.action_id = a.id
                 ORDER BY e.id DESC LIMIT 1) AS status,
              (SELECT e.note FROM corporate_action_event e WHERE e.action_id = a.id
                 ORDER BY e.id DESC LIMIT 1) AS note
            FROM corporate_action a WHERE a.id = ? AND a.market = ?`,
      args: [actionId, REVIEW_MARKET],
    });
    if (r.rows.length !== 1) return fail("not_found");
    const st = stateOf(
      r.rows[0].status === null
        ? null
        : {
            status: String(r.rows[0].status),
            note: r.rows[0].note === null ? null : String(r.rows[0].note),
          },
    ).state;
    if (st !== "owner" && st !== "blocked") return fail("not_open");
    detail = {
      code: String(r.rows[0].code),
      type: String(r.rows[0].type),
      ex_date: String(r.rows[0].ex_date),
    };
  } catch {
    return fail("unavailable");
  }

  const base = {
    at: now,
    actorUserId: p.actorId,
    targetType: "corporate_action",
    targetId: String(actionId),
  };
  try {
    await audit(p.authDb, p.env, meta, {
      ...base,
      action: `corporate_action.${decision}`,
      detail,
    });
  } catch {
    return fail("unavailable"); // nothing has changed
  }

  const io = { read: 0, written: 0 };
  const d = sydneyDate(nowDate.getTime());
  const failed = async (extra: Record<string, unknown>) => {
    try {
      await audit(p.authDb, p.env, meta, {
        ...base,
        action: `corporate_action.${decision}_failed`,
        detail: { ...detail, ...extra },
      });
    } catch {
      // best effort: the decision did not happen either way
    }
  };
  try {
    const res = await resolveAction(p.mainDb, {
      market: REVIEW_MARKET,
      actionId,
      decision,
      by: `owner:${p.actorId}`,
      now,
      d,
      io,
    });
    if (!res.ok) {
      // Decided elsewhere between the look and the write: record that nothing happened.
      await failed({ reason: res.error });
      return fail(res.error === "not_confirmed" ? "not_open" : res.error);
    }
  } catch {
    await failed({});
    return fail("unavailable");
  }

  try {
    await settle(p.mainDb, {
      market: REVIEW_MARKET,
      now,
      io,
      today: d,
      changed: [{ ex_date: detail.ex_date }],
    });
    return { ok: true, settled: true };
  } catch {
    return { ok: true, settled: false }; // the decision stands; the nightly run settles it
  }
}
