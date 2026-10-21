// @vitest-environment node
// Alpha-investing pools (M6 T4; ARN-063): the hand table, the DB chaining trigger, exhaustion, once per
// window and the carry across rolls.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  alphaLevel,
  alphaSequence,
  alphaStep,
  poolId,
  readPoolState,
  recordAlphaTest,
} from "@/lib/learning/alphaInvesting";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const params = defaultAgentParams();

describe("alpha-investing hand table (W0 = 0.10, payout 0.05)", () => {
  // j  W        alpha_j = W / (2 + W)   p      outcome      W after
  // 1  0.10     0.1 / 2.1   = 0.047619  0.010  reject       0.10 + 0.05 = 0.15
  // 2  0.15     0.15 / 2.15 = 0.069767  0.500  keep         0.15 - 0.15 / 2 = 0.075   (alpha / (1 - alpha) = W / 2)
  // 3  0.075    0.075 / 2.075 = 0.036145 0.030 reject       0.075 + 0.05 = 0.125
  // 4  0.125    0.125 / 2.125 = 0.058824 0.060 keep         0.125 - 0.0625 = 0.0625
  // 5  0.0625   0.0625 / 2.0625 = 0.030303 0.020 reject     0.0625 + 0.05 = 0.1125
  const ps = [0.01, 0.5, 0.03, 0.06, 0.02];
  const table = [
    { w: 0.1, alpha: 0.047619, rejected: true, after: 0.15 },
    { w: 0.15, alpha: 0.069767, rejected: false, after: 0.075 },
    { w: 0.075, alpha: 0.036145, rejected: true, after: 0.125 },
    { w: 0.125, alpha: 0.058824, rejected: false, after: 0.0625 },
    { w: 0.0625, alpha: 0.030303, rejected: true, after: 0.1125 },
  ];

  it("matches the table step by step", () => {
    const seq = alphaSequence(0.1, ps, 0.05);
    expect(seq).toHaveLength(5);
    seq.forEach((s, i) => {
      expect(s.wBefore).toBeCloseTo(table[i]!.w, 12);
      expect(s.alphaJ).toBeCloseTo(table[i]!.alpha, 6);
      expect(s.rejected).toBe(table[i]!.rejected);
      expect(s.wAfter).toBeCloseTo(table[i]!.after, 12);
    });
  });

  it("level formula, boundary p = alpha_j rejects, wealth never negative, zero wealth refuses", () => {
    expect(alphaLevel(0.1)).toBeCloseTo(0.1 / 2.1, 15);
    const w = 0.15;
    expect(alphaStep(w, alphaLevel(w), 0.05).rejected).toBe(true);
    expect(alphaStep(w, alphaLevel(w) + 1e-9, 0.05).rejected).toBe(false);
    expect(alphaStep(1e-300, 1, 0.05).wAfter).toBeGreaterThanOrEqual(0);
    expect(() => alphaStep(0, 0.01, 0.05)).toThrow(/exhausted/);
    expect(alphaSequence(0, [0.01, 0.01], 0.05)).toEqual([]);
  });

  it("a non-rejection costs exactly W / 2 and mFDR budget is never reset by a long losing run", () => {
    const seq = alphaSequence(0.1, Array<number>(10).fill(1), 0.05);
    seq.forEach((s, i) => expect(s.wAfter).toBeCloseTo(0.1 / 2 ** (i + 1), 15));
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
    const ps = [0.01, 0.5, 0.03, 0.06, 0.02];
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
    expect(Number(rows[4]!.w_after)).toBeCloseTo(0.1125, 12);
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
    expect(await readPoolState(db, poolId("AU", null), params)).toEqual({ seq: 0, wealth: 0.1 });
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
