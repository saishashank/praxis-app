// The Owner's "accept the risk" for one expert source (M22 E1; KB-083, D-1430, D-1472). Only the Owner sets
// `owner-accepted-risk`. Like the review service (src/lib/experts/review.ts): the input is checked, ONE audit event
// is appended in the auth database first (D-047), then the licence row is appended in the main database; a write
// that fails after the audit row appends `<action>_failed` (best effort). The audit detail carries statuses only.
// A robots disallowance cannot be accepted: the fetch rules obey robots.txt whatever the status says.
import type { Client } from "@libsql/client";
import { audit, NO_META, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { sourcesOf } from "./engine.mjs";
import { appendLicence, latestLicence, licenceExpert, type LicenceRow } from "./store";

export type AcceptCtx = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  now?: Date;
};
export type AcceptError =
  "invalid" | "forbidden" | "not_found" | "not_checked" | "robots" | "not_needed" | "unavailable";
export type AcceptResult = { ok: true } | { error: AcceptError };

const ID_RE = /^[A-Za-z0-9_.:-]{1,32}$/; // threshold-ok: expert id column length (0022)
const KEY_MAX = 64; // threshold-ok: expert_source_licence.source_key cap (0042)
const ACTION = "expert_licence_accept_risk";

export async function acceptRisk(
  c: AcceptCtx,
  input: { expertId: unknown; sourceKey: unknown },
): Promise<AcceptResult> {
  const { expertId, sourceKey } = input;
  if (typeof expertId !== "string" || !ID_RE.test(expertId)) return { error: "invalid" };
  if (typeof sourceKey !== "string" || sourceKey.length < 1 || sourceKey.length > KEY_MAX)
    return { error: "invalid" };
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
  let from: string;
  let keep: LicenceRow | null = null;
  try {
    const e = await licenceExpert(c.mainDb, expertId);
    const src = e === null ? undefined : sourcesOf(e).find((s) => s.key === sourceKey);
    if (e === null || src === undefined) return { error: "not_found" };
    if (src.manual || src.origin === null) return { error: "not_found" }; // never fetched: nothing to accept
    keep = await latestLicence(c.mainDb, { expertId, sourceKey });
    if (keep === null) return { error: "not_checked" };
    if (keep.robots === "disallows") return { error: "robots" };
    if (keep.status === "enabled" || keep.status === "owner-accepted-risk")
      return { error: "not_needed" };
    from = keep.status;
  } catch {
    return { error: "unavailable" };
  }
  if (keep === null) return { error: "unavailable" };
  const meta = c.meta ?? NO_META;
  const at = (c.now ?? new Date()).toISOString();
  const base = {
    at,
    actorUserId: c.actorId,
    targetType: "expert_source",
    targetId: expertId,
    detail: { source: sourceKey, from, to: "owner-accepted-risk" },
  };
  try {
    await audit(c.authDb, c.env, meta, { ...base, action: ACTION });
  } catch {
    return { error: "unavailable" };
  }
  try {
    await appendLicence(c.mainDb, {
      expertId,
      sourceKey,
      checkedAt: at,
      termsUrl: keep.termsUrl,
      robots: keep.robots,
      summarisation: keep.summarisation,
      status: "owner-accepted-risk",
      actor: "owner",
      note: "accepted by the Owner",
    });
  } catch {
    try {
      await audit(c.authDb, c.env, meta, {
        ...base,
        action: `${ACTION}_failed`,
        detail: { ...base.detail, reason: "write_failed" },
      });
    } catch {
      // best effort: the change did not happen either way
    }
    return { error: "unavailable" };
  }
  return { ok: true };
}
