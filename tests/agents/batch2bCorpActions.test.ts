// @vitest-environment node
// Orders that cross an ex-date (M4 T8; D-077 `order_qty_stale`; design 4.4 step 4, decision 19).
// 2b sizes on post-event terms for an action it knows; an action confirmed AFTER the order was
// written is rescaled (or the order cancelled) by 2a at the fill. Synthetic data, real engine.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePlan } from "@/lib/agents/orderPlan";
import { toBig } from "@/lib/arena/ledgerWriter";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  addAction,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden, D } from "./batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
afterEach(cleanupTempDbs);

const params = testParams();
const d = (i: number): string => DATES[i]!;
type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

type Night = { db: Client; cohortId: string };

/**
 * ZZD1 splits 2-for-1 with ex-date `splitAt`; `lateAfter` = the session after whose batch 2b the
 * action is confirmed (undefined = known from the start).
 */
async function night(
  splitAt: number,
  to: number,
  action: { type: string; payload: Record<string, unknown> },
  lateAfter?: number,
): Promise<Night> {
  const db = await freshReplayDb();
  await buildGolden(db, {}, action.type === "split" ? splitAt : undefined);
  await setMode(db, "full");
  const [cohortId] = await startCohortsAt(db, 295, ["E07"]);
  if (lateAfter === undefined) await addAction(db, "ZZD1", action.type, splitAt, action.payload);
  await runNights(db, params, 295, to, async (date) => {
    if (lateAfter !== undefined && date === d(lateAfter)) {
      await addAction(db, "ZZD1", action.type, splitAt, action.payload);
    }
  });
  return { db, cohortId: cohortId! };
}

const SPLIT = { type: "split", payload: { new: 2, old: 1 } };

async function entry(n: Night) {
  const [o] = await rows(
    n.db,
    `SELECT id, qty, status, reject_reason, stop_spec FROM arena_order
     WHERE cohort_id = ? AND code = 'ZZD1' AND kind = 'entry'`,
    [n.cohortId],
  );
  const [f] = await rows(
    n.db,
    "SELECT qty, fill_price_micro, value_micro FROM fill WHERE order_id = ?",
    [String(o!.id)],
  );
  const [t] = await rows(n.db, "SELECT stop_micro FROM trade WHERE id = ?", [`T:${String(o!.id)}`]);
  return { o: o!, f: f!, t: t! };
}

describe("an entry whose fill session is an ex-date", () => {
  it("a known split: 2b sizes on post-event terms; 2a fills exactly the ordered quantity", async () => {
    const n = await night(D + 1, D + 1, SPLIT);
    const { o, f, t } = await entry(n);
    const plan = parsePlan(String(o.stop_spec));
    expect(plan.caApplied).toHaveLength(1);
    expect(plan.caThrough).toBe(d(D));
    expect(o.status).toBe("filled");
    expect(toBig(f.qty)).toBe(toBig(o.qty));
    // post-split price is half, so the share count is about double the unsplit 336
    expect(toBig(o.qty)).toBeGreaterThan(640n);
    expect(toBig(f.value_micro)).toBeLessThanOrEqual(600_000_000n);
    // the initial stop sits below the post-split fill by the post-split ATR (scaled plan)
    expect(toBig(t.stop_micro)).toBeGreaterThan(0n);
    expect(toBig(t.stop_micro)).toBeLessThan(toBig(f.fill_price_micro));
    expect(toBig(f.fill_price_micro) - toBig(t.stop_micro)).toBeLessThan(80_000n);
  });

  it("a split confirmed after the order was written is rescaled at the fill, not refused", async () => {
    const n = await night(D + 1, D + 1, SPLIT, D);
    const { o, f, t } = await entry(n);
    expect(parsePlan(String(o.stop_spec)).caApplied).toEqual([]);
    expect(toBig(o.qty)).toBe(336n);
    expect(o.status).toBe("filled");
    expect(toBig(f.qty)).toBe(672n); // 336 x 2: the fill may exceed the pre-event order
    expect(toBig(f.fill_price_micro) - toBig(t.stop_micro)).toBeLessThan(80_000n);
    const [nav] = await rows(
      n.db,
      "SELECT invariants_ok FROM nav_daily WHERE cohort_id = ? AND d = ?",
      [n.cohortId, d(D + 1)],
    );
    expect(nav!.invariants_ok).toBe(1n);
  });

  it("a disposal (delisting) confirmed late cancels the entry", async () => {
    const n = await night(D + 1, D + 1, { type: "delisting", payload: {} }, D);
    const { o } = await entry(n);
    expect(o.status).toBe("cancelled");
    expect(o.reject_reason).toBe("corporate_action");
    expect(await rows(n.db, "SELECT 1 FROM fill")).toEqual([]);
  });
});

describe("a CS exit whose fill session is an ex-date (no order_qty_stale)", () => {
  // ZZD1 is bought on 301; its CS exit is decided on 302 and fills on 303 = the ex-date
  async function exitOf(n: Night) {
    const [o] = await rows(
      n.db,
      `SELECT id, qty, status, stop_spec FROM arena_order
       WHERE cohort_id = ? AND code = 'ZZD1' AND kind = 'exit_cs'`,
      [n.cohortId],
    );
    const [f] = await rows(n.db, "SELECT qty, d FROM fill WHERE order_id = ?", [String(o!.id)]);
    const [pos] = await rows(
      n.db,
      "SELECT open_positions FROM nav_daily WHERE cohort_id = ? AND d = ?",
      [n.cohortId, d(303)],
    );
    return { o: o!, f: f!, pos: pos! };
  }

  it("a known split: the order is written in post-event shares and sells the whole position", async () => {
    const n = await night(303, 303, SPLIT);
    const { o, f, pos } = await exitOf(n);
    expect(o.status).toBe("filled");
    expect(toBig(o.qty)).toBe(672n);
    expect(JSON.parse(String(o.stop_spec)).ca_applied).toHaveLength(1);
    expect(toBig(f.qty)).toBe(672n);
    expect(pos.open_positions).toBe(0n);
  });

  it("a split confirmed late: 2a rescales the exit and the position is sold in full", async () => {
    const n = await night(303, 303, SPLIT, 302);
    const { o, f, pos } = await exitOf(n);
    expect(toBig(o.qty)).toBe(336n); // written before the action was known
    expect(o.status).toBe("filled");
    expect(toBig(f.qty)).toBe(672n);
    expect(pos.open_positions).toBe(0n);
  });
});
