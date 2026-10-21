// Shared builders for the M6 acceptance tests: a migrated main DB with the v1 rule seed, an AU:F1
// lineage with a real frozen split, the 25 executions and their first cohorts (so a real group restart
// can run), challengers in a given state and a restart helper. Same shapes as tests/learning/promotion
// .test.ts (copied because that file's helpers are private). Synthetic only (SEC-110).
import { createClient, type Client } from "@libsql/client";
import { buildExecutionRegistry, planInitialStart, resolveCohortParams } from "@/lib/arena/cohort";
import {
  loadExecutions,
  loadLiveCohorts,
  runTerminalChecks,
  seedExecutions,
  startCohorts,
  type RestartConfig,
} from "@/lib/arena/cohortWriter";
import { sessionsBetween } from "@/lib/data/calendar";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { transitionChallenger } from "@/lib/learning/challengerLifecycle";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { MIGRATIONS, tempDbUrl, track } from "../../db/helpers";
import { addLineage, LEARNING, MARKET, ownerChallenger } from "../../learning/challengerFixtures";

export const MASTER = 20_261_011n;
export const registry = buildExecutionRegistry();
export const DATES = sessionsBetween("2026-10-05", "2027-03-31", []);
export const D0 = DATES[0]!;
export const OWNER = "u-owner";
export const AUDIT = "audit:2026-10-06:0001";
export const NOW = "2026-10-06T01:00:00.000Z";

/** Migrated DB, v1 rule versions, the F1 lineage, the 25 executions and their first cohorts. */
export async function arenaWorld(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await seedRuleVersions(db, { market: MARKET, d: "2026-10-01" });
  await addLineage(db, "F1");
  await seedExecutions(db, registry);
  await startCohorts(
    db,
    planInitialStart({
      registry,
      startD: D0,
      paramsFor: () => resolveCohortParams(),
      masterSeed: MASTER,
      controlsPerFamily: 2,
    }),
  );
  return db;
}

async function restartConfig(
  db: Client,
  over: Partial<RestartConfig> = {},
): Promise<RestartConfig> {
  const map = new Map((await loadExecutions(db)).map((e) => [e.id, e]));
  return {
    executionFor: (id) => {
      const e = map.get(id);
      if (e === undefined) throw new Error(`no execution ${id}`);
      return e;
    },
    paramsFor: () => resolveCohortParams(),
    masterSeed: MASTER,
    ...over,
  };
}

/** The live E01 target-resolves at close DATES[at], so the TW-F1 group restarts (the real step). */
export async function restartGroup(db: Client, at: number, over: Partial<RestartConfig> = {}) {
  const live = (await loadLiveCohorts(db, "TW-F1")).find((c) => c.executionId === "E01")!;
  await db.execute({
    sql: `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro,
            positions_micro, div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro,
            fin_accrued_micro, nav_micro, liq_nav_micro, open_positions, invariants_ok)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, 0, 1)`,
    args: [live.id, DATES[at]!, 1_230_000_000n, 1_230_000_000n, 1_230_000_000n],
  });
  return runTerminalChecks(db, [live.id], {
    d: DATES[at]!,
    calendar: [],
    signalsThroughD: DATES[at - 1]!,
    restart: await restartConfig(db, over),
  });
}

/** An Owner challenger moved through the real transitions to `review` (ready) or `approved`. */
export async function challengerIn(
  db: Client,
  i: number,
  state: "review" | "approved",
): Promise<string> {
  const made = await ownerChallenger(db, i, D0);
  if (made.status !== "created") throw new Error(`not created: ${JSON.stringify(made)}`);
  const id = made.id;
  const go = (to: "replay" | "shakedown" | "review" | "approved") =>
    transitionChallenger(
      db,
      { id, to, d: D0, actor: OWNER, reason: `acceptance ${to}` },
      { shakedownSessions: LEARNING.shakedownSessions },
    );
  await go("replay");
  await go("shakedown");
  await db.execute({
    sql: "UPDATE challenger SET shakedown_ok_sessions = ? WHERE id = ?",
    args: [LEARNING.shakedownSessions, id],
  });
  await go("review");
  await db.execute({ sql: "UPDATE challenger SET ready = 1 WHERE id = ?", args: [id] });
  if (state === "approved") await go("approved");
  return id;
}
