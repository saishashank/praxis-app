// The weekly `experts` learning stage (M13-lite WP5; D-517, D-526, D-598, D-599). Runs LAST, after rankIc, so
// the v1 generator keeps priority on the weekly cap and the KB-042 slots. Steps: parked proposals, screening,
// challenger proposals, F7 gate (WP7 appends call settlement and the KB documents). Each step has its own
// try/catch: a failing step is recorded as `degraded:<step>` in the stage stats and the stage still returns,
// so the weekly run is never blocked (as the steelman stage, D-484). Every step is idempotent, so a stage cut
// off by the budget simply runs again. Expert code is allowed to name no other stage and imports no trading
// module except through createChallenger (PRD-035).
import type { StageOutput } from "@/lib/learning/weeklyRun";
import type { WeeklyContext } from "@/lib/learning/weeklyStages";
import { evaluateF7 } from "./f7";
import { parkedProposals, proposeChallengers, type ProposalOutcome } from "./proposals";
import { screenClusters, type ScreeningSummary, type SkipReason } from "./screen";

export const SKIP_REASONS: Readonly<Record<SkipReason, 0>> = {
  invalid_fit: 0,
  no_split: 0,
  split_deferred: 0,
  no_incumbent: 0,
  insufficient_rows: 0,
  insufficient_controls: 0,
  insufficient_blocks: 0,
};

/** Counts by reason, all seven reasons present (zero-filled); `null` when the run was read back (D-599). */
export function skipCounts(s: ScreeningSummary): Record<SkipReason, number> | null {
  if (s.status === "exists") return null;
  const out: Record<SkipReason, number> = { ...SKIP_REASONS };
  for (const x of s.skipped) out[x.reason] += 1;
  return out;
}

const tally = (xs: readonly ProposalOutcome[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x.status] = (out[x.status] ?? 0) + 1;
  return out;
};

/** The stage. Never throws: a failing step becomes `degraded:<step>`. */
export async function expertsStage(c: WeeklyContext): Promise<StageOutput> {
  const degraded: string[] = [];
  const guard = async <T>(name: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      degraded.push(`degraded:${name}`);
      return null;
    }
  };

  const parked = await guard("parked", () => parkedProposals(c));
  const screening = await guard("screen", () => screenClusters(c));
  const proposals =
    screening === null ? null : await guard("propose", () => proposeChallengers(c, screening));
  const f7 = await guard("f7", () =>
    evaluateF7(c.db, { market: c.market, d: c.d, min: c.params.learning.f7MinClusters }),
  );

  return {
    stats: [
      {
        scope: c.market,
        metric: "experts",
        value: {
          parked: parked === null ? null : parked.length,
          screening:
            screening === null
              ? null
              : {
                  status: screening.status,
                  considered: screening.considered,
                  eligible: screening.eligible,
                  screened: screening.screened,
                  survivors: screening.survivors,
                  skipped: skipCounts(screening),
                },
          proposals: proposals === null ? null : tally(proposals),
          f7:
            f7 === null
              ? null
              : {
                  fires: f7.fires,
                  l2_clusters: f7.l2Clusters,
                  clusters: f7.clusters,
                  distinct_experts: f7.distinctExperts,
                  recorded: f7.recorded,
                },
          degraded,
        },
      },
    ],
  };
}
