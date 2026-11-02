// Expert review service (M13-lite WP6; UXN-295, KB-073, KB-075, LLM-069, D-529, D-530, D-535, D-594).
// What the Owner and Editors do with the claims queue: confirm, edit, reject, park, merge a claim into a
// cluster, bulk-confirm one expert's claims, confirm or merge a cluster. Every action:
//   1. checks the input and the claim's current status (an illegal edge is a value, no audit row, no write);
//   2. appends ONE audit event in the auth DB first (D-047: no change without an audit row; two databases, so
//      no single transaction), then writes the main DB;
//   3. appends `<action>_failed` (best effort) when the write fails after the audit row.
// The main-DB write is one transaction where more than one row changes (bulk confirm, cluster confirm,
// cluster merge). Edits are claim_revision versions and status is an append-only chain (D-530).
// The audit detail carries ids and statuses only, never claim or red-flag text.
import { createHmac } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import { audit, NO_META, requireKey, type RequestMeta } from "@/lib/auth/audit";
import type { AuthEnv } from "@/lib/auth/env";
import { fitCheck } from "./fit";
import { nextStatusFor } from "./status";
import {
  appendClaimRevision,
  appendClaimStatus,
  appendClusterState,
  claimById,
  confirmClaimsTx,
  currentClaimStatus,
  currentClusterState,
  mergeClaimIntoCluster,
  mergeClusterRows,
  type Exec,
} from "./store";
import type { ClaimStatus, ClusterRole, ClusterState } from "./types";

export type ReviewCtx = {
  mainDb: Client;
  authDb: Client;
  env: AuthEnv;
  meta?: RequestMeta;
  actorId: number;
  now?: Date;
};

export type ReviewError =
  | "invalid"
  | "forbidden"
  | "not_found"
  | "illegal_edge"
  | "not_confirmed"
  | "final"
  | "unavailable";
export type ReviewResult<T = Record<string, never>> = ({ ok: true } & T) | { error: ReviewError };

const ID_RE = /^[A-Za-z0-9_.:-]{1,32}$/; // threshold-ok: column length of the id columns (0022)
const STATEMENT_MAX = 600; // threshold-ok: claim_revision.statement cap (0022)
const FORMALISATION_MAX = 1200; // threshold-ok: claim_revision.formalisation_text cap (0022)
const REASON_MAX = 300; // threshold-ok: claim_status.reason cap (0022)
const ACTOR_HASH_CHARS = 16; // threshold-ok: length of the hashed actor id

const validId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

/** `u:` + a keyed hash of the user id: the actor column never holds a raw user id (D-530). */
export function actorOf(env: AuthEnv, actorId: number): string {
  const h = createHmac("sha256", requireKey(env)).update(`expert-actor|${actorId}`).digest("hex");
  return `u:${h.slice(0, ACTOR_HASH_CHARS)}`;
}

type Step<T> = {
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  /** Runs after the audit row. Returns the result body or an error value. */
  write: (at: string, actor: string) => Promise<ReviewResult<T>>;
};

/** The actor must be an active Owner or Editor (the guard ran first; the service re-checks, D-529). */
async function actorAllowed(c: ReviewCtx): Promise<boolean> {
  const r = await c.authDb.execute({
    sql: "SELECT 1 FROM app_user WHERE id = ? AND role IN ('owner','editor') AND status = 'active'",
    args: [c.actorId],
  });
  return r.rows.length === 1;
}

async function audited<T>(c: ReviewCtx, step: Step<T>): Promise<ReviewResult<T>> {
  const meta = c.meta ?? NO_META;
  const at = (c.now ?? new Date()).toISOString();
  let actor: string;
  try {
    if (!(await actorAllowed(c))) return { error: "forbidden" };
    actor = actorOf(c.env, c.actorId);
  } catch {
    return { error: "unavailable" };
  }
  const base = {
    at,
    actorUserId: c.actorId,
    targetType: step.targetType,
    targetId: step.targetId,
    detail: step.detail,
  };
  try {
    await audit(c.authDb, c.env, meta, { ...base, action: step.action });
  } catch {
    return { error: "unavailable" };
  }
  const failed = async (reason: string): Promise<void> => {
    try {
      await audit(c.authDb, c.env, meta, {
        ...base,
        action: `${step.action}_failed`,
        detail: { ...step.detail, reason },
      });
    } catch {
      // best effort: the change did not happen either way
    }
  };
  let out: ReviewResult<T>;
  try {
    out = await step.write(at, actor);
  } catch {
    await failed("write_failed");
    return { error: "unavailable" };
  }
  // The write re-checked the row inside its transaction and refused (a concurrent action moved it after
  // the pre-check): the audit row says the action was attempted, so a `_failed` row says it did not land.
  if ("error" in out) await failed(out.error);
  return out;
}

async function inTransaction<T>(db: Client, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction("write");
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}

// ---- claim actions -----------------------------------------------------------------------------------

type ClaimMove = "confirm" | "reject" | "park";
const MOVE_TO: Record<ClaimMove, ClaimStatus> = {
  confirm: "owner_checked",
  reject: "rejected",
  park: "parked",
};

async function moveClaim(
  c: ReviewCtx,
  move: ClaimMove,
  claimId: unknown,
  reason: unknown,
): Promise<ReviewResult<{ status: ClaimStatus }>> {
  if (!validId(claimId)) return { error: "invalid" };
  const why = typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;
  if (why !== null && why.length > REASON_MAX) return { error: "invalid" };
  let cur: ClaimStatus | null;
  try {
    cur = await currentClaimStatus(c.mainDb, claimId);
  } catch {
    return { error: "unavailable" };
  }
  if (cur === null) return { error: "not_found" };
  const to = MOVE_TO[move];
  // The one edge table: `confirm` from parked reopens the claim; every other edge is nextStatusFor's.
  const allowed =
    move === "confirm"
      ? nextStatusFor(cur, { kind: cur === "parked" ? "reopened" : "person_checked" }) === to
      : nextStatusFor(cur, { kind: move === "reject" ? "rejected" : "parked" }) === to;
  if (!allowed) return { error: "illegal_edge" };
  return audited<{ status: ClaimStatus }>(c, {
    action: `expert_claim_${move}`,
    targetType: "expert_claim",
    targetId: claimId,
    detail: { from: cur, to },
    write: async (at, actor) => {
      const w = await appendClaimStatus(c.mainDb, { claimId, to, actor, at, reason: why });
      if (!w.ok) return { error: w.reason === "no_claim" ? "not_found" : "illegal_edge" };
      return { ok: true, status: to };
    },
  });
}

/** extracted | parked -> owner_checked: the person has read the claim as written (LLM-069). */
export const confirmClaim = (c: ReviewCtx, claimId: unknown) =>
  moveClaim(c, "confirm", claimId, null);
export const rejectClaim = (c: ReviewCtx, claimId: unknown, reason?: unknown) =>
  moveClaim(c, "reject", claimId, reason);
export const parkClaim = (c: ReviewCtx, claimId: unknown, reason?: unknown) =>
  moveClaim(c, "park", claimId, reason);

/**
 * A corrected statement (and optionally formalisation) is a NEW claim_revision, and the claim is then
 * `owner_checked` (the person wrote or approved this text). Allowed while the claim is extracted, parked or
 * already owner_checked; once it is formalised or later the text under test is frozen (D-530).
 */
export async function editClaim(
  c: ReviewCtx,
  x: { claimId: unknown; statement: unknown; formalisationText?: unknown },
): Promise<ReviewResult<{ revision: number; status: ClaimStatus }>> {
  if (!validId(x.claimId)) return { error: "invalid" };
  if (typeof x.statement !== "string") return { error: "invalid" };
  const statement = x.statement.trim();
  if (statement === "" || statement.length > STATEMENT_MAX) return { error: "invalid" };
  let formalisation: string | null | undefined;
  if (x.formalisationText === undefined) formalisation = undefined;
  else if (typeof x.formalisationText === "string") {
    const f = x.formalisationText.trim();
    if (f.length > FORMALISATION_MAX) return { error: "invalid" };
    formalisation = f === "" ? null : f;
  } else return { error: "invalid" };
  const claimId = x.claimId;
  let cur: ClaimStatus | null;
  try {
    cur = await currentClaimStatus(c.mainDb, claimId);
  } catch {
    return { error: "unavailable" };
  }
  if (cur === null) return { error: "not_found" };
  if (cur !== "extracted" && cur !== "parked" && cur !== "owner_checked")
    return { error: "illegal_edge" };
  return audited<{ revision: number; status: ClaimStatus }>(c, {
    action: "expert_claim_edit",
    targetType: "expert_claim",
    targetId: claimId,
    detail: { from: cur },
    write: async (at, actor) =>
      inTransaction(c.mainDb, async (tx) => {
        const now = await currentClaimStatus(tx, claimId);
        if (now !== cur) return { error: "illegal_edge" } as const;
        const revision = await appendClaimRevision(tx, {
          claimId,
          statement,
          formalisationText: formalisation,
          actor,
          at,
        });
        if (cur !== "owner_checked") {
          const w = await appendClaimStatus(tx, {
            claimId,
            to: "owner_checked",
            actor,
            at,
            reason: "edited",
          });
          if (!w.ok) throw new Error("claim status refused after edit");
        }
        return { ok: true, revision, status: "owner_checked" } as const;
      }),
  });
}

/**
 * The claim supports (or contradicts) a CONFIRMED cluster: a claim_cluster row, and claim.cluster_id only
 * while it is still NULL (D-530, D-536). A proposed, parked or merged cluster is refused (`not_confirmed`).
 */
export async function mergeClaimToCluster(
  c: ReviewCtx,
  x: { claimId: unknown; clusterId: unknown; role?: unknown },
): Promise<ReviewResult<{ linked: boolean; primarySet: boolean }>> {
  if (!validId(x.claimId) || !validId(x.clusterId)) return { error: "invalid" };
  const role: ClusterRole = x.role === "contradicts" ? "contradicts" : "supports";
  if (x.role !== undefined && x.role !== "supports" && x.role !== "contradicts")
    return { error: "invalid" };
  const { claimId, clusterId } = x;
  try {
    const claim = await claimById(c.mainDb, claimId);
    if (claim === null) return { error: "not_found" };
    if (claim.status === "rejected" || claim.status === "parked") return { error: "illegal_edge" };
    const st = await currentClusterState(c.mainDb, clusterId);
    if (st === null) return { error: "not_found" };
    if (st.state !== "confirmed") return { error: "not_confirmed" };
  } catch {
    return { error: "unavailable" };
  }
  return audited<{ linked: boolean; primarySet: boolean }>(c, {
    action: "expert_claim_merge",
    targetType: "expert_claim",
    targetId: claimId,
    detail: { cluster: clusterId, role },
    // Two rows change (claim_cluster, claim.cluster_id): one transaction, with the checks repeated inside.
    write: async () =>
      inTransaction(c.mainDb, async (tx) => {
        const now = await currentClaimStatus(tx, claimId);
        if (now === null) return { error: "not_found" } as const;
        if (now === "rejected" || now === "parked") return { error: "illegal_edge" } as const;
        const st = await currentClusterState(tx, clusterId);
        if (st === null) return { error: "not_found" } as const;
        if (st.state !== "confirmed") return { error: "not_confirmed" } as const;
        const r = await mergeClaimIntoCluster(tx, { claimId, clusterId, role });
        return { ok: true, linked: r.linked, primarySet: r.primarySet } as const;
      }),
  });
}

/** One transaction: every extracted or parked claim of the expert becomes owner_checked (UXN-295). */
export async function bulkConfirmExpert(
  c: ReviewCtx,
  expertId: unknown,
): Promise<ReviewResult<{ confirmed: number; skipped: number }>> {
  if (!validId(expertId)) return { error: "invalid" };
  let ids: string[];
  try {
    const e = await c.mainDb.execute({
      sql: "SELECT 1 FROM expert WHERE id = ?",
      args: [expertId],
    });
    if (e.rows.length === 0) return { error: "not_found" };
    // Only the queue's own claims: still `extracted` (a parked claim is reopened one at a time).
    const r = await c.mainDb.execute({
      sql: `SELECT ce.claim_id AS id FROM claim_expert ce
              JOIN claim_status st ON st.claim_id = ce.claim_id
               AND st.seq = (SELECT MAX(seq) FROM claim_status WHERE claim_id = ce.claim_id)
             WHERE ce.expert_id = ? AND st.status = 'extracted' ORDER BY ce.claim_id`,
      args: [expertId],
    });
    ids = r.rows.map((x) => String(x.id));
  } catch {
    return { error: "unavailable" };
  }
  if (ids.length === 0) return { ok: true, confirmed: 0, skipped: 0 };
  return audited<{ confirmed: number; skipped: number }>(c, {
    action: "expert_claims_bulk_confirm",
    targetType: "expert",
    targetId: expertId,
    detail: { claims: ids.length },
    write: async (at, actor) => {
      const r = await confirmClaimsTx(c.mainDb, { claimIds: ids, actor, at });
      return { ok: true, confirmed: r.confirmed.length, skipped: r.skipped.length };
    },
  });
}

// ---- cluster actions ---------------------------------------------------------------------------------

async function validFit(db: Exec, clusterId: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT family_fit_json FROM cluster WHERE id = ?",
    args: [clusterId],
  });
  const raw = r.rows[0]?.family_fit_json;
  if (raw === null || raw === undefined) return false;
  try {
    return fitCheck(JSON.parse(String(raw))).ok;
  } catch {
    return false;
  }
}

/**
 * A person confirms the grouping (KB-075) and with it the family_fit that is tested. This is a hard
 * prerequisite for screening (D-594). In the same transaction every SUPPORTING claim at `owner_checked` is
 * formalised when the cluster has a valid fit (`nextStatusFor`, D-536a). Allowed from proposed or parked.
 */
export async function confirmCluster(
  c: ReviewCtx,
  clusterId: unknown,
): Promise<ReviewResult<{ formalised: number }>> {
  if (!validId(clusterId)) return { error: "invalid" };
  let from: ClusterState;
  try {
    const st = await currentClusterState(c.mainDb, clusterId);
    if (st === null) return { error: "not_found" };
    if (st.state === "merged") return { error: "final" };
    if (st.state === "confirmed") return { error: "illegal_edge" };
    from = st.state;
  } catch {
    return { error: "unavailable" };
  }
  return audited<{ formalised: number }>(c, {
    action: "expert_cluster_confirm",
    targetType: "expert_cluster",
    targetId: clusterId,
    detail: { from, to: "confirmed" },
    write: async (at, actor) =>
      inTransaction(c.mainDb, async (tx) => {
        const st = await currentClusterState(tx, clusterId);
        if (st === null || st.state === "merged" || st.state === "confirmed")
          return { error: st?.state === "merged" ? "final" : "illegal_edge" } as const;
        await appendClusterState(tx, { clusterId, state: "confirmed", actor, at });
        const hasValidFit = await validFit(tx, clusterId);
        let formalised = 0;
        if (hasValidFit) {
          const sup = await tx.execute({
            sql: "SELECT DISTINCT claim_id FROM claim_cluster WHERE cluster_id = ? AND role = 'supports' ORDER BY claim_id",
            args: [clusterId],
          });
          for (const row of sup.rows) {
            const id = String(row.claim_id);
            const cur = await currentClaimStatus(tx, id);
            if (cur === null) continue;
            const to = nextStatusFor(cur, { kind: "cluster_confirmed", hasValidFit });
            if (to === null) continue;
            const w = await appendClaimStatus(tx, {
              claimId: id,
              to,
              actor,
              at,
              reason: `cluster ${clusterId} confirmed`,
            });
            if (!w.ok) throw new Error("claim status refused at cluster confirm");
            formalised += 1;
          }
        }
        return { ok: true, formalised } as const;
      }),
  });
}

/**
 * Cluster merge (D-535): `from` is folded into `into`. cluster_state 'merged' first, then the claims'
 * cluster_id moves, then the claim_cluster rows for `into` are appended; one transaction. A merged cluster
 * is final. `into` must exist, differ from `from`, and be CONFIRMED (D-632): the claims that move keep
 * the person's confirmation of the group they land in, and a merge never lets a claim reach a group a
 * person has not confirmed (same rule as a single claim joining a cluster).
 */
export async function mergeCluster(
  c: ReviewCtx,
  x: { from: unknown; into: unknown },
): Promise<ReviewResult<{ claimsMoved: number }>> {
  if (!validId(x.from) || !validId(x.into) || x.from === x.into) return { error: "invalid" };
  const { from, into } = x;
  const check = async (
    db: Exec,
  ): Promise<{ ok: true; from: ClusterState } | { error: ReviewError }> => {
    const a = await currentClusterState(db, from);
    const b = await currentClusterState(db, into);
    if (a === null || b === null) return { error: "not_found" };
    if (a.state === "merged") return { error: "final" };
    if (b.state !== "confirmed") return { error: "not_confirmed" };
    return { ok: true, from: a.state };
  };
  let pre: Awaited<ReturnType<typeof check>>;
  try {
    pre = await check(c.mainDb);
  } catch {
    return { error: "unavailable" };
  }
  if ("error" in pre) return pre;
  return audited<{ claimsMoved: number }>(c, {
    action: "expert_cluster_merge",
    targetType: "expert_cluster",
    targetId: from,
    detail: { from: pre.from, into },
    write: async (at, actor) =>
      inTransaction(c.mainDb, async (tx) => {
        const again = await check(tx);
        if ("error" in again) return again;
        const r = await mergeClusterRows(tx, { from, into, actor, at });
        return { ok: true, claimsMoved: r.claimsMoved } as const;
      }),
  });
}
