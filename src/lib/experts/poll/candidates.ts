// What the Owner does with a discovery candidate (M22 E2; UXN-296, DAT-229, D-1433, D-1480): approve (the expert becomes
// `tracked`, within `expert_tracked_max`), dismiss (the expert is `retired` and is never proposed again) or snooze for 90
// days (hidden from the page until then). Like the review service (src/lib/experts/review.ts): the input is checked, the actor
// must be an active Owner (the guard ran first; the service re-checks), ONE audit event is appended in the auth database
// first (D-047), then the main database is written; a write that fails after the audit row appends `<action>_failed` (best
// effort). The audit detail carries the expert id and the two statuses only, never a name.
import type { Client } from "@libsql/client";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { getConfig } from "@/lib/config/store";
import { buildPollJson, expertById, type PollExpert } from "./store";

export const SNOOZE_DAYS = 90; // threshold-ok: UXN-296 "snooze 90 days"
const DAY_MS = 86_400_000; // threshold-ok: ms per day
const ID_RE = /^[A-Za-z0-9_.:-]{1,32}$/; // threshold-ok: expert id column length (0022)

export type CandidateAction = "approve" | "dismiss" | "snooze";
export type CandidateError =
  "invalid" | "forbidden" | "not_found" | "not_a_candidate" | "full" | "unavailable";
export type CandidateResult = { ok: true } | { error: CandidateError };

export type CandidateCtx = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  now?: Date;
};

const AUDIT: Record<CandidateAction, string> = {
  approve: "expert_candidate_approve",
  dismiss: "expert_candidate_dismiss",
  snooze: "expert_candidate_snooze",
};

export const snoozeUntil = (now: Date): string =>
  new Date(now.getTime() + SNOOZE_DAYS * DAY_MS).toISOString().slice(0, 10);

export async function decideCandidate(
  c: CandidateCtx,
  action: unknown,
  expertId: unknown,
): Promise<CandidateResult> {
  if (action !== "approve" && action !== "dismiss" && action !== "snooze")
    return { error: "invalid" };
  if (typeof expertId !== "string" || !ID_RE.test(expertId)) return { error: "invalid" };
  try {
    // rows-ok: at most 1 row, by primary key
    const r = await c.authDb.execute({
      sql: "SELECT 1 FROM app_user WHERE id = ? AND role = 'owner' AND status = 'active'",
      args: [c.actorId],
    });
    if (r.rows.length !== 1) return { error: "forbidden" };
  } catch {
    return { error: "unavailable" };
  }
  let e: PollExpert | null;
  try {
    e = await expertById(c.mainDb, expertId);
    if (e === null) return { error: "not_found" };
    if (e.status !== "candidate") return { error: "not_a_candidate" };
    if (action === "approve") {
      const max = Number(await getConfig(c.mainDb, "expert_tracked_max"));
      // rows-ok: one aggregate row
      const n = await c.mainDb.execute("SELECT COUNT(*) AS n FROM expert WHERE status = 'tracked'");
      if (Number(n.rows[0]?.n ?? 0) >= max) return { error: "full" };
    }
  } catch {
    return { error: "unavailable" };
  }
  const now = c.now ?? new Date();
  const at = now.toISOString();
  const to = action === "approve" ? "tracked" : action === "dismiss" ? "retired" : "candidate";
  const meta = c.meta ?? NO_META;
  const base = {
    at,
    actorUserId: c.actorId,
    targetType: "expert",
    targetId: expertId,
    detail: { from: "candidate", to, ...(action === "snooze" ? { days: SNOOZE_DAYS } : {}) },
  };
  try {
    await audit(c.authDb, c.env, meta, { ...base, action: AUDIT[action] });
  } catch {
    return { error: "unavailable" };
  }
  try {
    if (action === "snooze") {
      // rows-ok: one UPDATE of one row, by primary key (poll_json and updated_at are the columns the guard allows)
      await c.mainDb.execute({
        sql: "UPDATE expert SET poll_json = ?, updated_at = ? WHERE id = ? AND status = 'candidate'",
        args: [buildPollJson({ ...e.poll, snz: snoozeUntil(now) }), at, expertId],
      });
    } else {
      // rows-ok: one UPDATE of one row, by primary key
      const u = await c.mainDb.execute({
        sql: "UPDATE expert SET status = ?, updated_at = ? WHERE id = ? AND status = 'candidate'",
        args: [to, at, expertId],
      });
      if (u.rowsAffected !== 1) throw new Error("not updated");
    }
  } catch {
    try {
      await audit(c.authDb, c.env, meta, {
        ...base,
        action: `${AUDIT[action]}_failed`,
        detail: { ...base.detail, reason: "write_failed" },
      });
    } catch {
      // best effort: the change did not happen either way
    }
    return { error: "unavailable" };
  }
  return { ok: true };
}
