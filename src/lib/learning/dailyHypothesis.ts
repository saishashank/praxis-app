// D-921: how a strong finding of the daily loop reaches the existing learning machinery. When a feature
// has beaten the market on at least 10 of the last 15 stored nights, ONE hypothesis is opened (once, by a
// fixed id) in the expert-claim pipeline (migration 0022): a `cluster` in state `proposed` (testable at
// the end of day) with one `method` claim in status `extracted` that supports it. From there the existing
// path applies unchanged: the Owner confirms the cluster and checks the claim (LLM-069), the fit check
// maps it to a strategy family, the weekly screening tests it on the development split with the
// multiple-testing correction, and only a survivor can become a challenger (KB-040), which the usual
// grading, promotion and rollback rules judge. Nothing here changes a strategy rule or the shortlist rule.
import type { Client } from "@libsql/client";
import { appendClusterState, insertClaim, mergeClaimIntoCluster } from "@/lib/experts/store";
import { FEATURES, type FeatureKey } from "./dailyFeatures";

export const DAILY_ACTOR = "daily-learning";
/** A feature must have beaten the market on this many of the last HYP_WINDOW stored nights. */
export const HYP_WINDOW = 15; // threshold-ok: D-921 last 15 stored nights
export const HYP_MIN = 10; // threshold-ok: D-921 at least 10 of them

const STATEMENT_MAX = 600; // threshold-ok: cluster.statement length cap (migration 0022)
const NAME_MAX = 120; // threshold-ok: cluster.name length cap (migration 0022)

export const clusterIdOf = (key: FeatureKey): string => `dl-${key}`;
export const claimIdOf = (key: FeatureKey): string => `dlc-${key}`;

export type Evidence = {
  readonly nights: number;
  readonly of: number;
  readonly liftText: string;
  readonly n: number;
};

/**
 * Opens the hypothesis of a feature once. Returns true when it was opened now, false when it already
 * existed (a later night never opens it a second time, and never edits the first).
 */
export async function openHypothesis(
  db: Client,
  o: { feature: string; d: string; now: string; evidence: Evidence },
): Promise<boolean> {
  const f = FEATURES.find((x) => x.label === o.feature);
  if (f === undefined) return false;
  const statement = [
    `${f.idea}`,
    `Found by the daily learning loop: on ${o.evidence.nights} of the last ${o.evidence.of} nights the share-days with this setup beat the average liquid share by ${o.evidence.liftText} the next day (${o.evidence.n} share-days in the latest 40 sessions).`,
  ]
    .join(" ")
    .slice(0, STATEMENT_MAX);
  const tx = await db.transaction("write");
  try {
    const made = await tx.execute({
      sql: `INSERT INTO cluster (id, name, category, statement, testability, external_grade, created_at)
            VALUES (?, ?, ?, ?, 'testable_eod', 'none', ?) ON CONFLICT DO NOTHING`,
      args: [
        clusterIdOf(f.key),
        `Daily loop: ${f.label}`.slice(0, NAME_MAX),
        f.category,
        statement,
        o.now,
      ],
    });
    if (made.rowsAffected === 0) {
      await tx.rollback();
      return false;
    }
    await appendClusterState(tx, {
      clusterId: clusterIdOf(f.key),
      state: "proposed",
      reason: `daily learning ${o.d}`,
      actor: DAILY_ACTOR,
      at: o.now,
    });
    await insertClaim(tx, {
      id: claimIdOf(f.key),
      type: "method",
      testability: "testable_eod",
      clusterId: null,
      statement,
      actor: DAILY_ACTOR,
      at: o.now,
    });
    await mergeClaimIntoCluster(tx, { claimId: claimIdOf(f.key), clusterId: clusterIdOf(f.key) });
    await tx.commit();
    return true;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}
