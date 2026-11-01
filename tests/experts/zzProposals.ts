// Shared builders for the M13-lite WP5 tests (proposals, F7, weekly stage, AT-40 e/f). ZZ data only.
import type { Client } from "@libsql/client";
import { screenClusters, type ScreeningSummary } from "@/lib/experts/screen";
import {
  addCluster,
  fakeReplay,
  NOW,
  RUN_D,
  screenWorld,
  TEST_PARAMS,
  type Plan,
} from "./zzScreen";

export const cid = (n: number): string => `K-${String(n).padStart(3, "0")}`;
/** The generator may propose three per lineage a week, so the expert cap (2) is the binding one. */
export const paramsWith = (learning: Partial<(typeof TEST_PARAMS)["learning"]> = {}) => ({
  ...TEST_PARAMS,
  learning: { ...TEST_PARAMS.learning, challengerGeneratorPerWeek: 3, ...learning },
});

export const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function expert(db: Client, id: string): Promise<void> {
  await db.execute({
    sql: "INSERT INTO expert (id, name, status, tier, created_at, updated_at) VALUES (?, ?, 'tracked', 'core', ?, ?)",
    args: [id, `ZZ Expert ${id}`, NOW, NOW],
  });
}
export async function linkExpert(db: Client, claimId: string, expertId: string): Promise<void> {
  await db.execute({
    sql: "INSERT OR IGNORE INTO claim_expert (claim_id, expert_id) VALUES (?, ?)",
    args: [claimId, expertId],
  });
}

/** `n` planted clusters (strong edge, K-001 strongest) and four nulls, all confirmed with a checked claim. */
export async function plantedWorld(n = 6) {
  const w = await screenWorld();
  const planted = Array.from({ length: n }, (_, i) => cid(i + 1));
  const nulls = Array.from({ length: 4 }, (_, i) => cid(i + 20));
  const plan: Plan = Object.fromEntries(planted.map((k, i) => [k, 0.03 - 0.002 * i]));
  for (const k of [...planted, ...nulls]) await addCluster(w.db, k);
  const fr = fakeReplay(w.split, plan);
  const ctxAt = (d: string, params = paramsWith()) => ({ ...w.ctx, d, params });
  const screen = (d: string, params = paramsWith()): Promise<ScreeningSummary> =>
    screenClusters(ctxAt(d, params), { replay: fr.replay });
  return { ...w, planted, nulls, screen, ctxAt };
}
export { RUN_D };
export const rows = async (db: Client, sql: string, args: (string | number | null)[] = []) =>
  (await db.execute({ sql, args })).rows;
