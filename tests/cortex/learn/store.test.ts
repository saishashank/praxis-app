// @vitest-environment node
// The learning Cortex's store (migration 0031, design C.7 "store.ts"; D-923): batched insert-or-ignore,
// date-range reads by primary-key prefix, the leader as of a session. Synthetic ZZ rows only.
import { describe, expect, afterEach, it } from "vitest";
import type { AngleDayRow } from "@/lib/cortex/learn/scorecard";
import {
  angleDaysSince,
  compareRowsSince,
  eventsSince,
  featureNights,
  insertAngleDays,
  insertCompareRows,
  insertLeader,
  LEARN_BATCH,
  leaderMap,
  logEvent,
  type CompareRow,
  type LeaderRow,
} from "@/lib/cortex/learn/store";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const day = (i: number): string => `2026-10-${String(i).padStart(2, "0")}`;

const angleRow = (d: string, k: number, horizon: 1 | 20 = 1): AngleDayRow => ({
  market: "AU",
  d,
  angleId: `A-D1-${String(k).padStart(2, "0")}`,
  angleVersion: 1,
  horizon,
  featureD: "2026-09-30",
  n: 40,
  ic: k % 2 === 0 ? null : 0.05,
  topExcessPpm: 1000 * k,
  bottomExcessPpm: -1000 * k,
  basePpm: 10,
  regime: "RISK-ON",
  resultsSeason: (k % 2) as 0 | 1,
  psiPpm: k % 3 === 0 ? null : 5,
  excludedNews: 1,
  activeSetHash: "zzh",
  manifestId: "zzm",
});

describe("cortex_angle_day", () => {
  it("writes in batches, ignores a re-run and reads a date range in key order", async () => {
    const db = await freshDb("main");
    const rows: AngleDayRow[] = [];
    for (let i = 1; i <= 25; i += 1)
      for (let k = 1; k <= 9; k += 1) rows.push(angleRow(day(i), k), angleRow(day(i), k, 20));
    expect(rows.length).toBeGreaterThan(LEARN_BATCH);
    expect(await insertAngleDays(db, rows)).toEqual({ inserted: rows.length });
    expect(await insertAngleDays(db, rows)).toEqual({ inserted: 0 });
    const got = await angleDaysSince(db, "AU", day(24));
    expect(got).toHaveLength(36);
    expect(got[0]).toEqual(angleRow(day(24), 1));
    expect(got[1]).toEqual(angleRow(day(24), 1, 20));
    expect(got.find((r) => r.angleId === "A-D1-02")!.ic).toBeNull();
    expect(got.find((r) => r.angleId === "A-D1-03")!.psiPpm).toBeNull();
    expect(await angleDaysSince(db, "AU", day(2), day(3))).toHaveLength(36);
    expect(await angleDaysSince(db, "XX", day(1))).toEqual([]);
  });
});

describe("cortex_learn_compare", () => {
  it("round trips and ignores a duplicate", async () => {
    const db = await freshDb("main");
    const c: CompareRow = {
      market: "AU",
      decisionD: "2026-10-01",
      family: "F1",
      bookId: "ZZB",
      fixedRuleVersion: "F1.v2-mom",
      learnerRuleVersion: "F1.learn",
      learnerGeneration: 0,
      fixedCode: "ZZA",
      learnerCode: null,
      agree: 0,
      fixedRet1Ppm: 100,
      learnerRet1Ppm: null,
      fixedRet20Ppm: 2000,
      learnerRet20Ppm: null,
      maturedD: "2026-10-29",
      regime: "NEUTRAL",
    };
    const d2 = { ...c, decisionD: "2026-10-02", agree: 1 as const, learnerCode: "ZZA" };
    expect(await insertCompareRows(db, [c, d2])).toEqual({ inserted: 2 });
    expect(await insertCompareRows(db, [c])).toEqual({ inserted: 0 });
    expect(await compareRowsSince(db, "AU", "2026-10-01")).toEqual([c, d2]);
    expect(await compareRowsSince(db, "AU", "2026-10-02", "2026-10-02")).toEqual([d2]);
  });
});

describe("cortex_learn_event", () => {
  it("logs once per (night, seq) and reads back in order", async () => {
    const db = await freshDb("main");
    const e = {
      market: "AU",
      d: "2026-10-02",
      seq: 0,
      kind: "scorecard" as const,
      evidence: { b: 2, a: [1, 2] },
      words: "Words.",
      createdAt: "2026-10-02T09:00:00.000Z",
    };
    expect(await logEvent(db, e)).toEqual({ inserted: true });
    expect(await logEvent(db, { ...e, words: "Other." })).toEqual({ inserted: false });
    const cap = {
      ...e,
      d: "2026-10-03",
      seq: 1,
      kind: "cap" as const,
      family: "F1",
      angleId: "A-D1-02",
      generation: 3,
      expiresD: "2026-10-17",
      reversesSeq: null,
    };
    await logEvent(db, cap);
    const got = await eventsSince(db, "AU", "2026-10-01");
    expect(got).toEqual([
      {
        ...e,
        family: null,
        angleId: null,
        generation: null,
        reversesSeq: null,
        expiresD: null,
      },
      cap,
    ]);
    expect(await eventsSince(db, "AU", "2026-10-03", "2026-10-03")).toHaveLength(1);
  });
});

describe("cortex_leader", () => {
  it("the latest row as of a session wins per family; no row = no entry", async () => {
    const db = await freshDb("main");
    const base: LeaderRow = {
      market: "AU",
      family: "F1",
      sinceD: "2026-10-01",
      leader: "fixed",
      learnerRuleVersion: null,
      learnerGeneration: null,
      evidence: {},
      setBy: "evaluator",
    };
    const learner: LeaderRow = {
      ...base,
      sinceD: "2026-10-10",
      leader: "learner",
      learnerRuleVersion: "F1.learn",
      learnerGeneration: 4,
      evidence: { e: 21 },
    };
    const back: LeaderRow = { ...base, sinceD: "2026-10-20", setBy: "fallback" };
    const f4: LeaderRow = { ...base, family: "F4", sinceD: "2026-10-05" };
    for (const r of [base, learner, back, f4])
      expect(await insertLeader(db, r)).toEqual({ inserted: true });
    expect(await insertLeader(db, base)).toEqual({ inserted: false });
    expect(await leaderMap(db, "AU", "2026-09-30")).toEqual(new Map());
    const mid = await leaderMap(db, "AU", "2026-10-15");
    expect(mid.get("F1")).toEqual(learner);
    expect(mid.get("F4")).toEqual(f4);
    expect((await leaderMap(db, "AU", "2026-10-20")).get("F1")).toEqual(back);
  });
});

describe("featureNights", () => {
  it("reads the given nights in one batch; an empty list reads nothing", async () => {
    const db = await freshDb("main");
    await db.execute(
      `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json, active_set_hash, manifest_id)
       VALUES ('AU', '2026-10-01', 'ZZB', '{"A-D1-02":0.5}', '{}', 'h', 'm'),
              ('AU', '2026-10-01', 'ZZA', '{"A-D1-02":null}', '{}', 'h', 'm')`,
    );
    expect(await featureNights(db, "AU", [])).toEqual(new Map());
    const got = await featureNights(db, "AU", ["2026-10-01", "2026-10-02"]);
    expect(got.get("2026-10-01")!.rows).toEqual([
      { code: "ZZA", features: { "A-D1-02": null }, activeSetHash: "h", manifestId: "m" },
      { code: "ZZB", features: { "A-D1-02": 0.5 }, activeSetHash: "h", manifestId: "m" },
    ]);
    expect(got.get("2026-10-02")).toEqual({ d: "2026-10-02", rows: [] });
  });
});
