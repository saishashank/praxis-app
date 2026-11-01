// Expert store (M13-lite, D-530, D-535, D-536): typed readers and append-only writers over the 0022 tables.
// Every writer is an INSERT; the single UPDATE is claim.cluster_id (once from NULL, or to follow a merge).
// Reads take an `Exec` (a Client or a transaction); the bulk confirm takes a Client with `transaction`.
import type { Client, Transaction } from "@libsql/client";
import type { Exec } from "@/lib/cortex/store/common";
import { isAllowedClaimEdge } from "./status";
import type {
  ClaimStatus,
  ClaimType,
  ClaimView,
  ClusterRole,
  ClusterRow,
  ClusterState,
  Testability,
} from "./types";

export type { Exec };

const s = (v: unknown): string => String(v);
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ---- claim status -------------------------------------------------------------------------------------

export async function currentClaimStatus(db: Exec, claimId: string): Promise<ClaimStatus | null> {
  const r = await db.execute({
    sql: "SELECT status FROM claim_status WHERE claim_id = ? ORDER BY seq DESC LIMIT 1",
    args: [claimId],
  });
  const v = r.rows[0]?.status;
  return v === undefined ? null : (s(v) as ClaimStatus);
}

export type StatusWrite =
  | { readonly ok: true; readonly seq: number }
  | {
      readonly ok: false;
      readonly reason: "no_claim" | "illegal_edge";
      readonly from: ClaimStatus | null;
    };

/**
 * Appends the next claim_status row. An illegal edge is refused as a value (the trigger would abort the
 * statement anyway); the first status of a claim is `extracted` (use `insertClaim`).
 */
export async function appendClaimStatus(
  db: Exec,
  x: { claimId: string; to: ClaimStatus; actor: string; at: string; reason?: string | null },
): Promise<StatusWrite> {
  const cur = await db.execute({
    sql: "SELECT seq, status FROM claim_status WHERE claim_id = ? ORDER BY seq DESC LIMIT 1",
    args: [x.claimId],
  });
  const row = cur.rows[0];
  if (row === undefined) return { ok: false, reason: "no_claim", from: null };
  const from = s(row.status) as ClaimStatus;
  if (!isAllowedClaimEdge(from, x.to)) return { ok: false, reason: "illegal_edge", from };
  const seq = Number(row.seq) + 1;
  await db.execute({
    sql: "INSERT INTO claim_status (claim_id, seq, status, reason, actor, at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [x.claimId, seq, x.to, x.reason ?? null, x.actor, x.at],
  });
  return { ok: true, seq };
}

// ---- claims -------------------------------------------------------------------------------------------

export type NewClaim = {
  id: string;
  type: ClaimType;
  testability: Testability;
  clusterId: string | null;
  statement: string;
  formalisationText?: string | null;
  vocabularyGapText?: string | null;
  claimedEdgeText?: string | null;
  actor: string;
  at: string;
};

/** claim + first claim_revision + first claim_status 'extracted'. Insert-or-ignore on the claim id. */
export async function insertClaim(db: Exec, c: NewClaim): Promise<{ inserted: boolean }> {
  const r = await db.execute({
    sql: `INSERT INTO claim (id, type, testability, cluster_id, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [c.id, c.type, c.testability, c.clusterId, c.at],
  });
  if (r.rowsAffected === 0) return { inserted: false };
  await appendClaimRevision(db, { ...c, claimId: c.id });
  await db.execute({
    sql: "INSERT INTO claim_status (claim_id, seq, status, reason, actor, at) VALUES (?, 1, 'extracted', NULL, ?, ?)",
    args: [c.id, c.actor, c.at],
  });
  return { inserted: true };
}

/** A new text version (D-530). Fields not given carry over from the current version. Returns its seq. */
export async function appendClaimRevision(
  db: Exec,
  x: {
    claimId: string;
    statement?: string;
    formalisationText?: string | null;
    vocabularyGapText?: string | null;
    claimedEdgeText?: string | null;
    actor: string;
    at: string;
  },
): Promise<number> {
  const cur = await db.execute({
    sql: "SELECT * FROM claim_revision WHERE claim_id = ? ORDER BY seq DESC LIMIT 1",
    args: [x.claimId],
  });
  const p = cur.rows[0];
  const keep = (given: string | null | undefined, col: string): string | null =>
    given !== undefined ? given : p === undefined ? null : sn(p[col]);
  const seq = p === undefined ? 1 : Number(p.seq) + 1;
  await db.execute({
    sql: `INSERT INTO claim_revision (claim_id, seq, statement, formalisation_text, vocabulary_gap_text,
            claimed_edge_text, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      x.claimId,
      seq,
      x.statement ?? (p === undefined ? "" : s(p.statement)),
      keep(x.formalisationText, "formalisation_text"),
      keep(x.vocabularyGapText, "vocabulary_gap_text"),
      keep(x.claimedEdgeText, "claimed_edge_text"),
      x.actor,
      x.at,
    ],
  });
  return seq;
}

const CLAIM_SELECT = `
  SELECT c.id, c.type, c.testability, c.cluster_id,
         r.statement, r.formalisation_text, r.vocabulary_gap_text, r.claimed_edge_text,
         st.status
    FROM claim c
    JOIN claim_revision r ON r.claim_id = c.id
     AND r.seq = (SELECT MAX(seq) FROM claim_revision WHERE claim_id = c.id)
    JOIN claim_status st ON st.claim_id = c.id
     AND st.seq = (SELECT MAX(seq) FROM claim_status WHERE claim_id = c.id)`;

const claimView = (r: Record<string, unknown>): ClaimView => ({
  id: s(r.id),
  type: s(r.type) as ClaimType,
  testability: s(r.testability) as Testability,
  clusterId: sn(r.cluster_id),
  status: s(r.status) as ClaimStatus,
  statement: s(r.statement),
  formalisationText: sn(r.formalisation_text),
  vocabularyGapText: sn(r.vocabulary_gap_text),
  claimedEdgeText: sn(r.claimed_edge_text),
});

/** Claims of an expert (current text and status), in id order. */
export async function claimsOf(db: Exec, expertId: string): Promise<ClaimView[]> {
  const r = await db.execute({
    sql: `${CLAIM_SELECT} JOIN claim_expert ce ON ce.claim_id = c.id AND ce.expert_id = ? ORDER BY c.id`,
    args: [expertId],
  });
  return r.rows.map((x) => claimView(x as unknown as Record<string, unknown>));
}

export async function claimById(db: Exec, claimId: string): Promise<ClaimView | null> {
  const r = await db.execute({ sql: `${CLAIM_SELECT} WHERE c.id = ?`, args: [claimId] });
  const x = r.rows[0];
  return x === undefined ? null : claimView(x as unknown as Record<string, unknown>);
}

// ---- clusters -----------------------------------------------------------------------------------------

export type ClusterStatus = {
  readonly state: ClusterState;
  readonly mergedInto: string | null;
  /** The cluster to display for this one: itself, or the end of the merged_into chain (D-536). */
  readonly resolvedId: string;
};

const MAX_MERGE_HOPS = 16; // threshold-ok: cycle guard for a merged_into chain (the trigger forbids cycles)

async function latestState(
  db: Exec,
  id: string,
): Promise<{ state: ClusterState; into: string | null } | null> {
  const r = await db.execute({
    sql: "SELECT state, merged_into FROM cluster_state WHERE cluster_id = ? ORDER BY seq DESC LIMIT 1",
    args: [id],
  });
  const x = r.rows[0];
  return x === undefined ? null : { state: s(x.state) as ClusterState, into: sn(x.merged_into) };
}

/** Latest cluster state; `merged` is terminal (D-535) and `resolvedId` follows merged_into for display. */
export async function currentClusterState(
  db: Exec,
  clusterId: string,
): Promise<ClusterStatus | null> {
  const first = await latestState(db, clusterId);
  if (first === null) return null;
  let resolvedId = clusterId;
  let cur = first;
  for (let hop = 0; cur.state === "merged" && cur.into !== null && hop < MAX_MERGE_HOPS; hop += 1) {
    resolvedId = cur.into;
    const next = await latestState(db, cur.into);
    if (next === null) break;
    cur = next;
  }
  return { state: first.state, mergedInto: first.into, resolvedId };
}

export async function appendClusterState(
  db: Exec,
  x: {
    clusterId: string;
    state: ClusterState;
    mergedInto?: string | null;
    reason?: string | null;
    actor: string;
    at: string;
  },
): Promise<number> {
  const r = await db.execute({
    sql: "SELECT COALESCE(MAX(seq), 0) AS m FROM cluster_state WHERE cluster_id = ?",
    args: [x.clusterId],
  });
  const seq = Number(r.rows[0]?.m ?? 0) + 1;
  await db.execute({
    sql: `INSERT INTO cluster_state (cluster_id, seq, state, merged_into, reason, actor, at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [x.clusterId, seq, x.state, x.mergedInto ?? null, x.reason ?? null, x.actor, x.at],
  });
  return seq;
}

/** The clusters a claim supports or contradicts (all claim_cluster rows, in cluster id order). */
export async function clustersWith(
  db: Exec,
  claimId: string,
): Promise<{ clusterId: string; role: ClusterRole }[]> {
  const r = await db.execute({
    sql: "SELECT cluster_id, role FROM claim_cluster WHERE claim_id = ? ORDER BY cluster_id, role",
    args: [claimId],
  });
  return r.rows.map((x) => ({ clusterId: s(x.cluster_id), role: s(x.role) as ClusterRole }));
}

/**
 * A claim joins a cluster (D-536): a claim_cluster row, and claim.cluster_id only while it is still NULL.
 * Returns whether the link was new and whether the primary cluster was set.
 */
export async function mergeClaimIntoCluster(
  db: Exec,
  x: { claimId: string; clusterId: string; role?: ClusterRole },
): Promise<{ linked: boolean; primarySet: boolean }> {
  const l = await db.execute({
    sql: "INSERT INTO claim_cluster (claim_id, cluster_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    args: [x.claimId, x.clusterId, x.role ?? "supports"],
  });
  const u = await db.execute({
    sql: "UPDATE claim SET cluster_id = ? WHERE id = ? AND cluster_id IS NULL",
    args: [x.clusterId, x.claimId],
  });
  return { linked: l.rowsAffected > 0, primarySet: u.rowsAffected > 0 };
}

/**
 * Cluster merge (D-535): cluster_state 'merged' FIRST, then claim.cluster_id of the merged cluster's claims
 * moves to `into`, then claim_cluster rows are appended for `into` (the old rows stay as history). Merged is
 * final. Run it inside the caller's transaction.
 */
export async function mergeClusterRows(
  db: Exec,
  x: { from: string; into: string; actor: string; at: string; reason?: string | null },
): Promise<{ claimsMoved: number }> {
  await appendClusterState(db, {
    clusterId: x.from,
    state: "merged",
    mergedInto: x.into,
    reason: x.reason ?? null,
    actor: x.actor,
    at: x.at,
  });
  const moved = await db.execute({
    sql: "UPDATE claim SET cluster_id = ? WHERE cluster_id = ?",
    args: [x.into, x.from],
  });
  await db.execute({
    sql: `INSERT INTO claim_cluster (claim_id, cluster_id, role)
          SELECT claim_id, ?, role FROM claim_cluster WHERE cluster_id = ? ON CONFLICT DO NOTHING`,
    args: [x.into, x.from],
  });
  return { claimsMoved: moved.rowsAffected };
}

// ---- eligibility (LLM-069) ----------------------------------------------------------------------------

export type EligibleCluster = Pick<ClusterRow, "id" | "name" | "familyFit" | "closestFamily">;

/**
 * Clusters that may be screened: latest state `confirmed` or `proposed` (not merged or parked), testable at
 * the end of day, with a family_fit, and at least one SUPPORTING claim whose current status is
 * `owner_checked` or later and not `rejected`/`parked`. The LLM-069 guard lives in this one query (D-512).
 * `fitCheck` still judges the fit. Clusters are not market-bound; `market` is part of the contract for
 * callers that scope by market.
 */
export async function eligibleClusters(db: Exec, market: string): Promise<EligibleCluster[]> {
  void market;
  const r = await db.execute(`
    SELECT k.id, k.name, k.family_fit_json, k.closest_family
      FROM cluster k
     WHERE k.testability = 'testable_eod'
       AND k.family_fit_json IS NOT NULL
       AND (SELECT s.state FROM cluster_state s WHERE s.cluster_id = k.id ORDER BY s.seq DESC LIMIT 1)
           IN ('confirmed','proposed')
       AND EXISTS (
         SELECT 1 FROM claim_cluster cc
           JOIN claim_status st ON st.claim_id = cc.claim_id
            AND st.seq = (SELECT MAX(seq) FROM claim_status WHERE claim_id = cc.claim_id)
          WHERE cc.cluster_id = k.id AND cc.role = 'supports'
            AND st.status IN ('owner_checked','formalised','screened','challenger','promoted'))
     ORDER BY k.id`);
  return r.rows.map((x) => ({
    id: s(x.id),
    name: s(x.name),
    closestFamily: sn(x.closest_family),
    familyFit: JSON.parse(s(x.family_fit_json)) as unknown,
  }));
}

// ---- bulk confirm -------------------------------------------------------------------------------------

export type BulkConfirm = {
  readonly confirmed: string[];
  /** Claims left alone: not in a state that allows owner_checked (already checked, rejected, ...). */
  readonly skipped: string[];
};

/**
 * Confirms many claims in ONE transaction (UXN-295 bulk confirm). Each claim moves `extracted | parked ->
 * owner_checked`; others are skipped as values. `inTx` runs inside the same transaction before commit, so the
 * caller can write its audit event with `auditTx` (state change and audit commit together).
 */
export async function confirmClaimsTx(
  db: Pick<Client, "transaction">,
  x: {
    claimIds: readonly string[];
    actor: string;
    at: string;
    inTx?: (tx: Transaction, result: BulkConfirm) => Promise<void>;
  },
): Promise<BulkConfirm> {
  const tx = await db.transaction("write");
  try {
    const confirmed: string[] = [];
    const skipped: string[] = [];
    for (const id of x.claimIds) {
      const cur = await currentClaimStatus(tx, id);
      if (cur !== "extracted" && cur !== "parked") {
        skipped.push(id);
        continue;
      }
      await appendClaimStatus(tx, { claimId: id, to: "owner_checked", actor: x.actor, at: x.at });
      confirmed.push(id);
    }
    const result = { confirmed, skipped };
    if (x.inTx !== undefined) await x.inTx(tx, result);
    await tx.commit();
    return result;
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }
}
