// F7 gate (M13-lite WP5; KB-078, D-518, D-536b). Dormant by construction: F7 is a new lineage (a build
// change), no code here or anywhere runs it. The gate only watches for the evidence that would justify
// asking for it: at least `f7_min_clusters` clusters, from distinct supporting-expert sets, whose challenger
// reached L2 (passed VAL-110 or was promoted). That needs real forward data and the v1 promotion pipeline,
// so on the seed it cannot fire. When it fires it writes ONE `f7_lineage` row, status `dormant`.
import { loadChallenger } from "@/lib/learning/challengerLifecycle";
import type { Exec } from "./store";
import type { ExpertGrade } from "./types";

export type ChallengerEvidence = {
  readonly state: string;
  /** A replay -> shakedown event exists: the only way into shakedown is a passed VAL-110 (challengerEvidence). */
  readonly passedVal110: boolean;
};

/** L0 = extracted; L1 = survived a screening run; L2 = its challenger passed VAL-110 or is promoted. */
export function clusterGrade(x: {
  readonly survived: boolean;
  readonly challenger: ChallengerEvidence | null;
}): ExpertGrade {
  if (x.challenger !== null && (x.challenger.state === "promoted" || x.challenger.passedVal110)) {
    return "L2";
  }
  return x.survived ? "L1" : "L0";
}

export type L2Cluster = { readonly clusterId: string; readonly expertIds: readonly string[] };
export type F7Verdict = {
  readonly fires: boolean;
  /** Experts in the union of the counted clusters. */
  readonly distinctExperts: number;
  /** Clusters counted: the most L2 clusters each creditable to a different supporting expert (D-621). */
  readonly clusters: number;
};

/**
 * "Clusters from distinct experts" (KB-078): the largest number of L2 clusters that can each be credited to a
 * DIFFERENT supporting expert (a maximum matching of clusters to experts), after clusters resting on the very
 * same set of people were collapsed to one voice. Fires when that number reaches `min` (a `min` below 1 never
 * fires). Sets {A}, {B}, {A,B} count 2, not 3: the third cluster has no expert of its own (D-621).
 */
export function f7Gate(l2: readonly L2Cluster[], min: number): F7Verdict {
  const sets = new Map<string, readonly string[]>();
  for (const k of l2) {
    const ids = [...new Set(k.expertIds)].sort();
    if (ids.length > 0) sets.set(ids.join("|"), ids);
  }
  const union = new Set<string>();
  for (const ids of sets.values()) for (const x of ids) union.add(x);
  const clusters = maximumMatching([...sets.values()]);
  return { fires: min >= 1 && clusters >= min, distinctExperts: union.size, clusters };
}

/** Size of a maximum bipartite matching of clusters (each a set of experts) to experts; augmenting paths. */
export function maximumMatching(sets: readonly (readonly string[])[]): number {
  const owner = new Map<string, number>(); // expert -> cluster index holding it
  const augment = (i: number, seen: Set<string>): boolean => {
    for (const e of sets[i]!) {
      if (seen.has(e)) continue;
      seen.add(e);
      const j = owner.get(e);
      if (j === undefined || augment(j, seen)) {
        owner.set(e, i);
        return true;
      }
    }
    return false;
  };
  let n = 0;
  for (let i = 0; i < sets.length; i += 1) if (augment(i, new Set())) n += 1;
  return n;
}

async function evidenceOf(db: Exec, challengerId: string): Promise<ChallengerEvidence | null> {
  const ch = await loadChallenger(db as Parameters<typeof loadChallenger>[0], challengerId);
  if (ch === null) return null;
  const ev = await db.execute({
    sql: `SELECT 1 AS one FROM challenger_event
           WHERE challenger_id = ? AND from_state = 'replay' AND to_state = 'shakedown' LIMIT 1`,
    args: [challengerId],
  });
  return { state: ch.state, passedVal110: ev.rows.length > 0 };
}

/** Clusters of this market whose proposed challenger is at L2, with their supporting experts. */
export async function l2Clusters(db: Exec, market: string): Promise<L2Cluster[]> {
  const rows = await db.execute({
    sql: `SELECT DISTINCT cluster_id, challenger_id FROM expert_proposal
           WHERE market = ? AND kind = 'challenger' AND status IN ('created','exists')
             AND challenger_id IS NOT NULL ORDER BY cluster_id, challenger_id`,
    args: [market],
  });
  const out = new Map<string, Set<string>>();
  for (const r of rows.rows) {
    const clusterId = String(r.cluster_id);
    const ev = await evidenceOf(db, String(r.challenger_id));
    if (ev === null || clusterGrade({ survived: true, challenger: ev }) !== "L2") continue;
    const ex = await db.execute({
      sql: `SELECT DISTINCT ce.expert_id FROM claim_cluster cc
              JOIN claim_expert ce ON ce.claim_id = cc.claim_id
             WHERE cc.cluster_id = ? AND cc.role = 'supports' ORDER BY ce.expert_id`,
      args: [clusterId],
    });
    const set = out.get(clusterId) ?? new Set<string>();
    for (const e of ex.rows) set.add(String(e.expert_id));
    out.set(clusterId, set);
  }
  return [...out].map(([clusterId, s]) => ({ clusterId, expertIds: [...s].sort() }));
}

export type F7Result = F7Verdict & {
  readonly l2Clusters: number;
  /** A new dormant row was written this call. */
  readonly recorded: boolean;
};

/** Evaluates the gate and, when it fires and no F7 row exists for the market, writes the one dormant row. */
export async function evaluateF7(
  db: Exec,
  x: { market: string; d: string; min: number },
): Promise<F7Result> {
  const l2 = await l2Clusters(db, x.market);
  const v = f7Gate(l2, x.min);
  let recorded = false;
  if (v.fires) {
    const have = await db.execute({
      sql: "SELECT 1 AS one FROM expert_proposal WHERE market = ? AND kind = 'f7_lineage' LIMIT 1",
      args: [x.market],
    });
    if (have.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO expert_proposal (id, market, d, cluster_id, kind, family, challenger_id, status, reason, created_at)
              VALUES (?, ?, ?, NULL, 'f7_lineage', NULL, NULL, 'dormant', ?, ?)`,
        args: [
          `expprop:${x.market}:${x.d}:f7`,
          x.market,
          x.d,
          "F7 is a new lineage; build change",
          `${x.d}T00:00:00.000Z`,
        ],
      });
      recorded = true;
    }
  }
  return { ...v, l2Clusters: l2.length, recorded };
}
