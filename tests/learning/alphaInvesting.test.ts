// @vitest-environment node
// Alpha-investing pools (M6 T4; ARN-063): the hand table, the DB chaining trigger, exhaustion, once per
// window and the carry across rolls.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  alphaLevel,
  alphaSequence,
  alphaStep,
  poolExhausted,
  poolId,
  readPoolState,
  recordAlphaTest,
} from "@/lib/learning/alphaInvesting";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const params = defaultAgentParams();

describe("alpha-investing hand table (W0 = 0.10, payout 0.05, spend fraction 0.1; VAL-116, D-231)", () => {
  // Re-pinned in M14 (D-231): the level is f x W with f = 0.1 instead of W / (2 + W). Cost of a
  // non-rejection is alpha / (1 - alpha); a rejection pays 0.05.
  // j  W          alpha_j = 0.1 W   p      outcome  W after
  // 1  0.10       0.010             0.005  reject   0.10 + 0.05 = 0.15
  // 2  0.15       0.015             0.500  keep     0.15 - 0.015 / 0.985 = 0.134772
  // 3  0.134772   0.013477          0.010  reject   0.134772 + 0.05 = 0.184772
  // 4  0.184772   0.018477          0.200  keep     0.184772 - 0.018477 / 0.981523 = 0.165947
  // 5  0.165947   0.016595          0.001  reject   0.165947 + 0.05 = 0.215947
  const ps = [0.005, 0.5, 0.01, 0.2, 0.001];
  const table = [
    { w: 0.1, alpha: 0.01, rejected: true, after: 0.15 },
    { w: 0.15, alpha: 0.015, rejected: false, after: 0.134772 },
    { w: 0.134772, alpha: 0.013477, rejected: true, after: 0.184772 },
    { w: 0.184772, alpha: 0.018477, rejected: false, after: 0.165947 },
    { w: 0.165947, alpha: 0.016595, rejected: true, after: 0.215947 },
  ];

  it("matches the table step by step", () => {
    const seq = alphaSequence(0.1, ps, 0.05);
    expect(seq).toHaveLength(5);
    seq.forEach((s, i) => {
      expect(s.wBefore).toBeCloseTo(table[i]!.w, 6);
      expect(s.alphaJ).toBeCloseTo(table[i]!.alpha, 6);
      expect(s.rejected).toBe(table[i]!.rejected);
      expect(s.wAfter).toBeCloseTo(table[i]!.after, 6);
    });
  });

  it("level formula, boundary p = alpha_j rejects, wealth never negative, zero wealth refuses", () => {
    expect(alphaLevel(0.1)).toBeCloseTo(0.01, 15);
    expect(alphaLevel(0.1, 0.25)).toBeCloseTo(0.025, 15);
    const w = 0.15;
    expect(alphaStep(w, alphaLevel(w), 0.05).rejected).toBe(true);
    expect(alphaStep(w, alphaLevel(w) + 1e-9, 0.05).rejected).toBe(false);
    expect(alphaStep(0.06, 1, 0.05).wAfter).toBeGreaterThanOrEqual(0);
    expect(() => alphaStep(0, 0.01, 0.05)).toThrow(/exhausted/);
    expect(alphaSequence(0, [0.01, 0.01], 0.05)).toEqual([]);
  });

  it("is exhausted when the next level is below 0.005: after 7 non-rejections from W0 = 0.1", () => {
    const seq = alphaSequence(0.1, Array<number>(20).fill(1), 0.05);
    expect(seq).toHaveLength(7);
    const last = seq[6]!;
    expect(last.wAfter).toBeCloseTo(0.047552, 6);
    expect(poolExhausted(last.wAfter)).toBe(true);
    expect(poolExhausted(seq[5]!.wAfter)).toBe(false);
    // boundary: W = 0.05 gives exactly 0.005, which is not below the level
    expect(poolExhausted(0.05)).toBe(false);
    expect(poolExhausted(0.0499)).toBe(true);
    expect(() => alphaStep(last.wAfter, 0.5, 0.05)).toThrow(/exhausted/);
  });
});

async function insertLesson(db: Awaited<ReturnType<typeof freshDb>>, id: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO lesson (id, market, scope, lineage_id, template_id, template_version, subject_json,
            rule_version, metric, direction, param_hint, created_d, created_run)
          VALUES (?, 'AU', 'lineage', 'AU:F1', 'LT-REGIME', 1, '{}', 'F1.v1', 'mean_excess', 1, NULL, '2026-01-02', 'r0')`,
    args: [id],
  });
}

describe("alpha_wealth ledger", () => {
  const pool = poolId("AU", "F1");

  it("writes the hand table exactly and the chaining trigger accepts every row", async () => {
    const db = await freshDb("main");
    const ps = [0.005, 0.5, 0.01, 0.2, 0.001];
    for (const [i, p] of ps.entries()) {
      const id = `L-AU-LT-REGIME-0000000${String(i)}-F1.v1`;
      await insertLesson(db, id);
      const out = await recordAlphaTest(db, {
        pool,
        lessonId: id,
        windowKey: "AU:F1:s1:l2",
        p,
        runId: "run-1",
        params,
      });
      expect(out.kind).toBe("tested");
    }
    const rows = (await db.execute("SELECT * FROM alpha_wealth ORDER BY seq")).rows;
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5]);
    expect(Number(rows[0]!.w_before)).toBe(0.1);
    for (let i = 1; i < rows.length; i += 1) {
      expect(Number(rows[i]!.w_before)).toBe(Number(rows[i - 1]!.w_after));
    }
    expect(Number(rows[4]!.w_after)).toBeCloseTo(0.215947, 6);
    expect((await readPoolState(db, pool, params)).wealth).toBe(Number(rows[4]!.w_after));
  });

  it("tests a lesson once per window, carries wealth to a new window, and keeps pools apart", async () => {
    const db = await freshDb("main");
    const id = "L-AU-LT-REGIME-00000001-F1.v1";
    await insertLesson(db, id);
    const first = await recordAlphaTest(db, {
      pool,
      lessonId: id,
      windowKey: "w1",
      p: 0.01,
      runId: "a",
      params,
    });
    expect(first.kind).toBe("tested");
    const again = await recordAlphaTest(db, {
      pool,
      lessonId: id,
      windowKey: "w1",
      p: 0.01,
      runId: "b",
      params,
    });
    expect(again.kind).toBe("existing");
    await expect(
      recordAlphaTest(db, { pool, lessonId: id, windowKey: "w1", p: 0.2, runId: "c", params }),
    ).rejects.toThrow(/stored p/);
    // A roll: a new window of the same lesson continues from 0.15 (never reset).
    const next = await recordAlphaTest(db, {
      pool,
      lessonId: id,
      windowKey: "w2",
      p: 0.9,
      runId: "d",
      params,
    });
    expect(next.kind === "tested" && next.row.w_before).toBe(0.1 + 0.05);
    expect((await readPoolState(db, pool, params)).seq).toBe(2);
    // Another pool starts at W0.
    expect(await readPoolState(db, poolId("AU", null), params)).toEqual({
      seq: 0,
      wealth: 0.1,
      exhausted: false,
    });
    expect(poolId("AU", null)).toBe("AU:*");
  });

  it("an exhausted pool runs no test and writes nothing", async () => {
    const db = await freshDb("main");
    const id = "L-AU-LT-REGIME-00000002-F1.v1";
    await insertLesson(db, id);
    const dead = { ...params, learning: { ...params.learning, l2AlphaW0: 0 } };
    const out = await recordAlphaTest(db, {
      pool,
      lessonId: id,
      windowKey: "w1",
      p: 0.001,
      runId: "a",
      params: dead,
    });
    expect(out.kind).toBe("exhausted");
    expect((await db.execute("SELECT COUNT(*) AS n FROM alpha_wealth")).rows[0]!.n).toBe(0);
  });
});
