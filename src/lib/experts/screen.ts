// Weekly screening of expert clusters (D-514, D-516, D-518, D-534, D-536a, D-590...D-596).
// Eligible clusters (a person confirmed the cluster, KB-075, and checked a supporting claim, LLM-069) are
// expressed as a parameter set of a v1 family; the family is replayed through the one development accessor,
// the cluster statistic (excess over matched controls) is computed on development rows only, BH runs ONCE
// over all tested clusters of the run, and the run is stored insert-once per (market, d) in one transaction
// with its results and claim moves. No trial is charged here: the trial ledger is written only by
// createChallenger (WP5).
import type { Client } from "@libsql/client";
import { FAMILY_ORDER } from "@/lib/agents/families/constants";
import type { Family } from "@/lib/agents/schema";
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";
import { incumbentOf } from "@/lib/learning/challengerLifecycle";
import { loadSplit, type WeeklyContext } from "@/lib/learning/weeklyStages";
import { lineageId } from "@/lib/stats/splits";
import { makeExpertDevView, type ExpertDevView, type ReplayFn } from "./devView";
import { fitCheck, type FitOk } from "./fit";
import {
  clusterStatistic,
  isInsufficient,
  screenRun,
  type ClusterStat,
  type ScreeningRow,
} from "./screenStats";
import { appendClaimStatus, currentClaimStatus, eligibleClusters, type Exec } from "./store";
import { nextStatusFor } from "./status";
import type { ClaimStatus } from "./types";

export type SkipReason =
  | "invalid_fit"
  | "no_split"
  | "split_deferred"
  | "no_incumbent"
  | "insufficient_rows"
  | "insufficient_controls"
  | "insufficient_blocks";

export type ScreeningSummary = {
  /** `ran`: a new run was stored; `exists`: this (market, d) was already screened (no-op); `nothing_eligible`: no run row. */
  readonly status: "ran" | "exists" | "nothing_eligible";
  readonly runId: string;
  readonly considered: number;
  readonly eligible: number;
  readonly screened: number;
  readonly survivors: number;
  readonly skipped: readonly { readonly clusterId: string; readonly reason: SkipReason }[];
  /** Survivors in rank order (the proposal list of WP5). */
  readonly ranked: readonly SurvivorRef[];
};

export type SurvivorRef = {
  readonly clusterId: string;
  readonly family: Family;
  readonly params: FitOk["params"];
  readonly rank: number;
};

export type ScreenDeps = {
  /** Replaces the weekly run's replay (tests). Still passes through makeExpertDevView's development filter. */
  readonly replay?: ReplayFn;
  /** Replaces the cluster statistic (the access-spy test wraps it). */
  readonly statistic?: typeof clusterStatistic;
};

/** The weekly context, or any object with the five fields the screening reads (tests inject a replay). */
export type ScreenContext = Pick<WeeklyContext, "db" | "market" | "d" | "params" | "world"> &
  Partial<WeeklyContext>;

export const screeningRunId = (market: string, d: string): string => `expscreen:${market}:${d}`;
const at = (d: string): string => `${d}T00:00:00.000Z`;
const ppm = (x: number): number => Math.round(x * 1_000_000); // money-float-ok: descriptive percentages, stored as integer ppm

type Tested = {
  readonly clusterId: string;
  readonly fit: FitOk;
  readonly sha: string;
  readonly stat: ClusterStat;
};

async function supportingClaims(db: Exec, clusterId: string): Promise<string[]> {
  const r = await db.execute({
    sql: "SELECT DISTINCT claim_id FROM claim_cluster WHERE cluster_id = ? AND role = 'supports' ORDER BY claim_id",
    args: [clusterId],
  });
  return r.rows.map((x) => String(x.claim_id));
}

/**
 * The supporting claims of a tested cluster move `owner_checked -> formalised -> screened` (D-536a, D-591):
 * the cluster is confirmed by a person (D-594) and has a valid fit (that is what made it eligible), so the
 * `cluster_confirmed` formalise step is taken here with nextStatusFor and then the screened step. Claims at
 * `extracted`, `parked`, `rejected` or already further are left alone (nextStatusFor returns null for them).
 */
async function advanceClaims(
  tx: Exec,
  clusterId: string,
  runId: string,
  d: string,
): Promise<number> {
  let moved = 0;
  for (const claimId of await supportingClaims(tx, clusterId)) {
    let cur: ClaimStatus | null = await currentClaimStatus(tx, claimId);
    if (cur === null) continue;
    for (const ev of [
      { kind: "cluster_confirmed", hasValidFit: true },
      { kind: "screened" },
    ] as const) {
      const to = nextStatusFor(cur, ev);
      if (to === null) continue;
      const w = await appendClaimStatus(tx, {
        claimId,
        to,
        actor: "system",
        at: at(d),
        reason: `screening run ${runId}`,
      });
      if (!w.ok) break;
      cur = to;
      moved += 1;
    }
  }
  return moved;
}

export async function readRunSurvivors(db: Exec, runId: string): Promise<SurvivorRef[]> {
  const r = await db.execute({
    sql: `SELECT s.cluster_id, s.family, s.rank, k.family_fit_json
            FROM screening_result s JOIN cluster k ON k.id = s.cluster_id
           WHERE s.run_id = ? AND s.survived = 1 ORDER BY s.rank, s.cluster_id`,
    args: [runId],
  });
  const out: SurvivorRef[] = [];
  for (const x of r.rows) {
    const fit = fitCheck(JSON.parse(String(x.family_fit_json)));
    if (!fit.ok) continue;
    out.push({
      clusterId: String(x.cluster_id),
      family: fit.family,
      params: fit.params,
      rank: Number(x.rank),
    });
  }
  return out;
}

export async function screenClusters(
  c: ScreenContext,
  deps: ScreenDeps = {},
): Promise<ScreeningSummary> {
  const { market, d, params } = c;
  const db: Client = c.db;
  const runId = screeningRunId(market, d);
  const q = params.learning.expertScreenFdr;
  const statistic = deps.statistic ?? clusterStatistic;

  const prior = await db.execute({
    sql: "SELECT considered, eligible, screened, survivors FROM screening_run WHERE run_id = ?",
    args: [runId],
  });
  if (prior.rows[0] !== undefined) {
    const p = prior.rows[0];
    return {
      status: "exists",
      runId,
      considered: Number(p.considered),
      eligible: Number(p.eligible),
      screened: Number(p.screened),
      survivors: Number(p.survivors),
      skipped: [],
      ranked: await readRunSurvivors(db, runId),
    };
  }

  const candidates = await eligibleClusters(db, market);
  if (candidates.length === 0) {
    return {
      status: "nothing_eligible",
      runId,
      considered: 0,
      eligible: 0,
      screened: 0,
      survivors: 0,
      skipped: [],
      ranked: [],
    };
  }

  const skipped: { clusterId: string; reason: SkipReason }[] = [];
  const byFamily = new Map<Family, { id: string; fit: FitOk }[]>();
  for (const k of candidates) {
    const fit = fitCheck(k.familyFit);
    if (!fit.ok) {
      skipped.push({ clusterId: k.id, reason: "invalid_fit" });
      continue;
    }
    byFamily.set(fit.family, [...(byFamily.get(fit.family) ?? []), { id: k.id, fit }]);
  }

  const splits: Record<string, number> = {};
  const tested: Tested[] = [];
  for (const family of FAMILY_ORDER) {
    const group = byFamily.get(family);
    if (group === undefined) continue;
    // a family without a stored split or live incumbent cannot be screened (as the challengers stage)
    const split = await loadSplit(db, lineageId(market, family));
    const incumbent = split === null ? null : await incumbentOf(db, market, family);
    const lane =
      split === null
        ? "no_split"
        : split.deferred_until_d !== null
          ? "split_deferred"
          : incumbent === null
            ? "no_incumbent"
            : null;
    if (lane !== null || split === null) {
      for (const g of group) skipped.push({ clusterId: g.id, reason: lane ?? "no_split" });
      continue;
    }
    splits[family] = split.version;
    const view: ExpertDevView = makeExpertDevView(c, family, split, {
      ...(deps.replay === undefined ? {} : { replay: deps.replay }),
    });
    for (const g of group) {
      const sha = sha256Hex(canonicalJson({ family, params: g.fit.params }));
      const sample = view.evaluate(g.fit.params, `${family}.expert:${g.id}`);
      const stat = statistic(sample, `${market}:${d}:${g.id}:${sha}`, {
        replicates: params.stats.bootstrapReplicationsMin,
        minRows: params.stats.minTrades,
        minBlocks: params.stats.minBlocks,
      });
      if (isInsufficient(stat)) {
        skipped.push({ clusterId: g.id, reason: `insufficient_${stat.insufficient}` });
        continue;
      }
      tested.push({ clusterId: g.id, fit: g.fit, sha, stat });
    }
  }

  const eligible = candidates.length - skipped.filter((s) => s.reason === "invalid_fit").length;
  const rows: ScreeningRow[] = screenRun(
    tested.map((t) => ({ id: t.clusterId, stat: t.stat })),
    q,
  );
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const survivors = rows.filter((r) => r.survived).length;

  const tx = await db.transaction("write");
  try {
    await tx.execute({
      sql: `INSERT INTO screening_run (run_id, market, d, q, considered, eligible, screened, survivors,
              splits_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        runId,
        market,
        d,
        q,
        candidates.length,
        eligible,
        tested.length,
        survivors,
        canonicalJson(splits),
        at(d),
      ],
    });
    for (const t of tested) {
      const r = rowOf.get(t.clusterId)!;
      await tx.execute({
        sql: `INSERT INTO screening_result (run_id, cluster_id, family, params_sha, rows, blocks,
                mean_net_ppm, mean_excess_ppm, lower90_ppm, p, adjusted_p, bh_rejected, sign_agrees,
                survived, rank, grade) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          runId,
          t.clusterId,
          t.fit.family,
          t.sha,
          t.stat.rows,
          t.stat.blocks,
          ppm(t.stat.meanNet),
          ppm(t.stat.meanExcess),
          ppm(t.stat.lower90),
          r.p,
          r.adjustedP,
          r.bhRejected ? 1 : 0,
          r.signAgrees ? 1 : 0,
          r.survived ? 1 : 0,
          r.rank,
          r.grade,
        ],
      });
      await advanceClaims(tx, t.clusterId, runId, d);
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  } finally {
    tx.close();
  }

  const ranked: SurvivorRef[] = tested
    .filter((t) => rowOf.get(t.clusterId)!.survived)
    .map((t) => ({
      clusterId: t.clusterId,
      family: t.fit.family,
      params: t.fit.params,
      rank: rowOf.get(t.clusterId)!.rank!,
    }))
    .sort((a, b) => a.rank - b.rank);
  return {
    status: "ran",
    runId,
    considered: candidates.length,
    eligible,
    screened: tested.length,
    survivors,
    skipped,
    ranked,
  };
}
