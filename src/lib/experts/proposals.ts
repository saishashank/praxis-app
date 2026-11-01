// Expert proposals (M13-lite WP5; KB-077, PRD-035; D-515, D-526, D-534, D-536b, D-599).
// The only path from an expert cluster to trading is `createChallenger` (D-525): a cluster that survived the
// weekly screening run is offered to the v1 challenger lifecycle as a Lane B challenger (origin generator,
// actor A6), where KB-042 slots, the weekly generator cap, the trial budget and VAL-110 apply unchanged. Every
// CreateResult is stored as an append-only `expert_proposal` row (created | exists | refused); a refused
// survivor is retried the next ISO week as a NEW row. Clusters that need a new lineage get one
// `parked_build_change` row (D-515). Nothing here writes outside the expert tables except through
// createChallenger.
import { lineageId } from "@/lib/stats/splits";
import {
  createChallenger,
  isoWeekBounds,
  type CreateResult,
} from "@/lib/learning/challengerLifecycle";
import { budgetTotalFor } from "@/lib/learning/promotion";
import { loadSplit, type WeeklyContext } from "@/lib/learning/weeklyStages";
import { parkReason } from "./fit";
import type { ScreeningSummary } from "./screen";
import { appendClaimStatus, currentClaimStatus, type Exec } from "./store";
import { nextStatusFor } from "./status";
import type { Testability } from "./types";

export type ProposeContext = Pick<WeeklyContext, "db" | "market" | "d" | "params">;

export type ProposalOutcome = {
  readonly clusterId: string;
  readonly kind: "challenger" | "new_lineage";
  /** `skipped_week`: a row for this cluster already exists in this ISO week (a re-run); nothing was called. */
  readonly status: "created" | "exists" | "refused" | "parked_build_change" | "skipped_week";
  readonly proposalId: string | null;
  readonly reason: string | null;
};

const MAX_REASON = 300; // threshold-ok: expert_proposal.reason CHECK (0022)
const at = (d: string): string => `${d}T00:00:00.000Z`;
const cut = (s: string): string => (s.length <= MAX_REASON ? s : s.slice(0, MAX_REASON));

export const proposalId = (market: string, d: string, clusterId: string): string =>
  `expprop:${market}:${d}:${clusterId}`;
/** New-lineage rows share the date scheme with a suffix so the id can never meet a challenger row (D-600). */
export const newLineageProposalId = (market: string, d: string, clusterId: string): string =>
  `${proposalId(market, d, clusterId)}:nl`;

async function supportingClaims(db: Exec, clusterId: string): Promise<string[]> {
  const r = await db.execute({
    sql: "SELECT DISTINCT claim_id FROM claim_cluster WHERE cluster_id = ? AND role = 'supports' ORDER BY claim_id",
    args: [clusterId],
  });
  return r.rows.map((x) => String(x.claim_id));
}

async function insertProposal(
  db: Exec,
  x: {
    id: string;
    market: string;
    d: string;
    clusterId: string;
    kind: "challenger" | "new_lineage";
    family: string | null;
    challengerId: string | null;
    status: string;
    reason: string | null;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO expert_proposal (id, market, d, cluster_id, kind, family, challenger_id, status, reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      x.id,
      x.market,
      x.d,
      x.clusterId,
      x.kind,
      x.family,
      x.challengerId,
      x.status,
      x.reason === null ? null : cut(x.reason),
      at(x.d),
    ],
  });
}

/** Challenger-kind rows of the ISO week holding `d`: the weekly cap count and the same-week re-run guard. */
async function weekRows(
  db: Exec,
  market: string,
  d: string,
): Promise<{ created: number; clusters: Set<string> }> {
  const { start, end } = isoWeekBounds(d);
  const r = await db.execute({
    sql: `SELECT cluster_id, status FROM expert_proposal
           WHERE market = ? AND kind = 'challenger' AND d >= ? AND d <= ?`,
    args: [market, start, end],
  });
  return {
    created: r.rows.filter((x) => String(x.status) === "created").length,
    clusters: new Set(r.rows.map((x) => String(x.cluster_id))),
  };
}

/** Clusters that already have a created or existing challenger (any week): never proposed twice. */
async function alreadyProposed(db: Exec, market: string): Promise<Set<string>> {
  const r = await db.execute({
    sql: `SELECT DISTINCT cluster_id FROM expert_proposal
           WHERE market = ? AND kind = 'challenger' AND status IN ('created','exists')`,
    args: [market],
  });
  return new Set(r.rows.map((x) => String(x.cluster_id)));
}

function rowOf(res: CreateResult): { status: string; challengerId: string | null; reason: string } {
  if (res.status === "refused") {
    return { status: "refused", challengerId: null, reason: `${res.reason}: ${res.detail}` };
  }
  return {
    status: res.status,
    challengerId: res.id,
    reason: `${res.status} as ${res.id} (${res.ruleVersionId})`,
  };
}

/**
 * Offers the run's survivors, in rank order, to createChallenger until `expert_challengers_per_week` rows were
 * `created` in this ISO week (0 turns proposals off). A survivor with a created/exists challenger from any
 * earlier week, or any challenger row in this week, is skipped without a call (insert-once per cluster and
 * week, D-536b). A `created` row moves the supporting claims `screened -> challenger` in the same transaction.
 */
export async function proposeChallengers(
  c: ProposeContext,
  run: Pick<ScreeningSummary, "status" | "ranked">,
): Promise<ProposalOutcome[]> {
  const { db, market, d, params } = c;
  const cap = params.learning.expertChallengersPerWeek;
  const out: ProposalOutcome[] = [];
  if (run.status === "nothing_eligible" || cap <= 0) return out;
  const week = await weekRows(db, market, d);
  const done = await alreadyProposed(db, market);
  let created = week.created;
  for (const s of run.ranked) {
    if (created >= cap) break;
    if (done.has(s.clusterId)) continue;
    if (week.clusters.has(s.clusterId)) {
      out.push({
        clusterId: s.clusterId,
        kind: "challenger",
        status: "skipped_week",
        proposalId: null,
        reason: null,
      });
      continue;
    }
    const split = await loadSplit(db, lineageId(market, s.family));
    const budgetTotal =
      split === null
        ? undefined
        : await budgetTotalFor(
            db,
            market,
            s.family,
            split.version,
            params.stats.trialBudgetPerLineage,
          );
    const res = await createChallenger(db, {
      market,
      family: s.family,
      origin: "generator",
      params: s.params,
      lessonIds: [],
      d,
      actor: "A6",
      learning: params.learning,
      stats: params.stats,
      ...(budgetTotal === undefined ? {} : { budgetTotal }),
      note: `expert cluster ${s.clusterId} (KB-077)`,
    });
    const row = rowOf(res);
    const id = proposalId(market, d, s.clusterId);
    const tx = await db.transaction("write");
    try {
      await insertProposal(tx, {
        id,
        market,
        d,
        clusterId: s.clusterId,
        kind: "challenger",
        family: s.family,
        challengerId: row.challengerId,
        status: row.status,
        reason: row.reason,
      });
      if (res.status === "created") {
        for (const claimId of await supportingClaims(tx, s.clusterId)) {
          const cur = await currentClaimStatus(tx, claimId);
          const to = cur === null ? null : nextStatusFor(cur, { kind: "challenger_created" });
          if (to !== null) {
            await appendClaimStatus(tx, {
              claimId,
              to,
              actor: "system",
              at: at(d),
              reason: `challenger ${res.id}`,
            });
          }
        }
      }
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    } finally {
      tx.close();
    }
    if (res.status === "created") created += 1;
    out.push({
      clusterId: s.clusterId,
      kind: "challenger",
      status: res.status,
      proposalId: id,
      reason: row.reason,
    });
  }
  return out;
}

type ConfirmedCluster = {
  id: string;
  testability: Testability;
  closestFamily: string | null;
  vocabularyGaps: number;
  familyFit: unknown;
};

async function confirmedTestable(db: Exec): Promise<ConfirmedCluster[]> {
  const r = await db.execute(`
    SELECT k.id, k.testability, k.closest_family, k.vocabulary_gaps, k.family_fit_json
      FROM cluster k
     WHERE k.testability = 'testable_eod'
       AND (SELECT s.state FROM cluster_state s WHERE s.cluster_id = k.id ORDER BY s.seq DESC LIMIT 1)
           = 'confirmed'
     ORDER BY k.id`);
  return r.rows.map((x) => ({
    id: String(x.id),
    testability: String(x.testability) as Testability,
    closestFamily: x.closest_family === null ? null : String(x.closest_family),
    vocabularyGaps: Number(x.vocabulary_gaps),
    familyFit:
      x.family_fit_json === null ? null : (JSON.parse(String(x.family_fit_json)) as unknown),
  }));
}

/**
 * D-515: a confirmed `testable_eod` cluster with no family fit that needs a new structural lineage gets ONE
 * `new_lineage` row, `parked_build_change` (FAM-101: a structural change is a build change). Written once per
 * cluster, ever (the later weeks find the row). Nothing here can reach createChallenger.
 */
export async function parkedProposals(
  c: Pick<ProposeContext, "db" | "market" | "d">,
): Promise<ProposalOutcome[]> {
  const { db, market, d } = c;
  const have = await db.execute({
    sql: "SELECT DISTINCT cluster_id FROM expert_proposal WHERE market = ? AND kind = 'new_lineage'",
    args: [market],
  });
  const seen = new Set(have.rows.map((x) => String(x.cluster_id)));
  const out: ProposalOutcome[] = [];
  for (const k of await confirmedTestable(db)) {
    if (seen.has(k.id)) continue;
    if (parkReason({ ...k }) !== "needs_new_lineage") continue;
    const id = newLineageProposalId(market, d, k.id);
    const reason = "needs a new structural lineage; build change (FAM-101)";
    await insertProposal(db, {
      id,
      market,
      d,
      clusterId: k.id,
      kind: "new_lineage",
      family: null,
      challengerId: null,
      status: "parked_build_change",
      reason,
    });
    out.push({
      clusterId: k.id,
      kind: "new_lineage",
      status: "parked_build_change",
      proposalId: id,
      reason,
    });
  }
  return out;
}
