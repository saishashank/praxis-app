// Shared builders for the challenger tests (M6 T9): a migrated main DB with the v1 seed, an AU:F1
// lineage with a real frozen split, and helpers to register challengers. Synthetic only (SEC-110).
import type { Client } from "@libsql/client";
import { defaultAgentParams, type AgentParams } from "@/lib/agents/params";
import type { Family } from "@/lib/agents/schema";
import { createChallenger, type CreateResult } from "@/lib/learning/challengerLifecycle";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { createLineage, createLineageSplit, type LineageSplitRecord } from "@/lib/stats/splits";
import { freshDb } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";

export const MARKET = "AU";
export const D0 = "2026-10-05"; // a Monday
export const BASE: AgentParams = defaultAgentParams();
export const LEARNING = BASE.learning;
/** Fast statistics: the bootstrap factor 2 gives B = 1,000 at m = 2 (the val110 tests do the same). */
export const FAST = { ...BASE.stats, bootstrapReplicationsFactor: 2 };

export type World = { db: Client; split: LineageSplitRecord };

export async function addLineage(db: Client, family: Family): Promise<LineageSplitRecord> {
  const lineage = createLineage(MARKET, family, "2026-01-01");
  await db.execute({
    sql: "INSERT INTO lineage (id, created_d, parent) VALUES (?, ?, NULL)",
    args: [lineage.id, lineage.created_d],
  });
  const s = createLineageSplit({
    market: MARKET,
    family,
    calendar: weekdayCalendar(2000),
    maxHoldingUpper: 120,
    primaryRows: [],
    params: BASE.stats,
  });
  await insertSplit(db, s);
  return s;
}

/** Stores a split record (a first split or a roll) as the production writer does. */
export async function insertSplit(db: Client, s: LineageSplitRecord): Promise<void> {
  await db.execute({
    sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len,
            purge, data_end_d, holdout_start_d, holdout_end_d, validation_start_d, validation_end_d,
            dev_end_d, deferred_until_d, reason, measured_on_run)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      s.lineage_id,
      s.version,
      s.block_sessions,
      s.holdout_len,
      s.validation_len,
      s.purge,
      s.data_end_d,
      s.holdout_start_d,
      s.holdout_end_d,
      s.validation_start_d,
      s.validation_end_d,
      s.dev_end_d,
      s.deferred_until_d,
      s.reason,
      s.measured_on_run,
    ],
  });
}

export async function world(families: readonly Family[] = ["F1"]): Promise<World> {
  const db = await freshDb("main");
  await seedRuleVersions(db, { market: MARKET, d: "2026-10-01" });
  let split: LineageSplitRecord | null = null;
  for (const f of families) split = await addLineage(db, f);
  return { db, split: split! };
}

export async function incumbentParams(db: Client, id = "F1.v1"): Promise<Record<string, unknown>> {
  const rs = await db.execute({
    sql: "SELECT params_json FROM rule_version WHERE id = ?",
    args: [id],
  });
  return JSON.parse(String(rs.rows[0]!.params_json)) as Record<string, unknown>;
}

/** The F1 incumbent with some keys changed. */
export async function f1With(
  db: Client,
  changes: Record<string, number>,
): Promise<Record<string, unknown>> {
  return { ...(await incumbentParams(db)), ...changes };
}

/** Registers an Owner challenger (no weekly generator cap) with a distinct trail ATR. */
export async function ownerChallenger(
  db: Client,
  i: number,
  d = D0,
  over: Partial<Parameters<typeof createChallenger>[1]> = {},
): Promise<CreateResult> {
  return createChallenger(db, {
    market: MARKET,
    family: "F1",
    origin: "owner",
    // 2.05 .. 3.95 in steps of 0.05, all inside 2..4 and never the default 3
    params: await f1With(db, { f1_trail_atr: Number((2 + 0.05 * (i + 1)).toFixed(2)) }),
    lessonIds: [],
    d,
    actor: "u-owner",
    learning: LEARNING,
    stats: BASE.stats,
    ...over,
  });
}

export const rows = async (db: Client, sql: string, args: (string | number | null)[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
