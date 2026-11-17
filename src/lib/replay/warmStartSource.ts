// D-1078: the feature nights a warm start (src/lib/cortex/learn/warmStart.ts) could not read from
// `cortex_feature_daily`: the fixed Cortex as of each evening, built the way the pick scorecard builds
// its Cortex line (src/lib/scorecard/pickReplay.ts): `createCortexReplay` over the snapshot world, one
// replay per distinct angle set, the statuses of the newest passport frozen on or before that evening
// (D-1066) and, before the first frozen passport, the earliest frozen set (D-1070), never today's.
// Read only: the database reads are the rule-version set and the passports.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import type { AngleStatus } from "@/lib/cortex/angles/types";
import type { FeatureNightSource } from "@/lib/cortex/learn/warmStart";
import { createCortexReplay, type CortexReplay } from "@/lib/replay/cortexReplay";
import { featureNightOf, openReplay, passportsAsOf } from "@/lib/scorecard/pickReplay";
import type { SnapshotWorld } from "./snapshotWorld";

/** The manifest's schema stamp: the pick scorecard's constant, so a night's manifest id is stable. */
const SCHEMA_SHA = "pick-scorecard-replay";

export async function snapshotFeatureSource(deps: {
  readonly db: Client;
  readonly world: SnapshotWorld;
  readonly params: AgentParams;
  readonly market: string;
}): Promise<FeatureNightSource> {
  const opened = await openReplay(deps);
  const by = new Map<string, CortexReplay>();
  const cortexOf = (passports: Map<string, AngleStatus>): CortexReplay => {
    const key = JSON.stringify([...passports]);
    let c = by.get(key);
    if (c === undefined) {
      c = createCortexReplay({
        world: deps.world,
        params: opened.live,
        passports,
        schemaSha: SCHEMA_SHA,
      });
      by.set(key, c);
    }
    return c;
  };
  return async (d) => {
    if (!deps.world.sessions.includes(d)) return null;
    const { statuses } = await passportsAsOf(deps.db, deps.market, d);
    if (statuses.size === 0) return null;
    return featureNightOf(cortexOf(statuses).hook.night(d, []), d);
  };
}
