// @vitest-environment node
// Comparisons (M6 T5; ARN-062, EML-037): nightly descriptive rows, weekly Benjamini-Hochberg, the one
// look, the lockout, labels, idempotent writes and determinism.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  benjaminiHochberg,
  evaluateLook,
  excludedPairs,
  findingId,
  LABEL_DESCRIPTIVE,
  LABEL_LOOK_FAILED,
  LABEL_LOOK_PASSED,
  LABEL_WEEKLY_DISCOVERY,
  LABEL_WEEKLY_NONE,
  labelNoDetectableDifference,
  labelNotEnoughData,
  lookDueDate,
  lookReady,
  lookSessionsNeeded,
  nightlyComparisons,
  readFindings,
  replicatesFor,
  statementFor,
  weeklyComparisons,
  writeComparisonRows,
  writeLook,
  writeWeekly,
  type AdvanceSessions,
  type CompRow,
  type FindingRow,
  type PairData,
} from "@/lib/learning/comparisons";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const params = defaultAgentParams();
const MARKET = "ZZ";

/** Calendar stand-in: n "sessions" = n days. */
const advance: AdvanceSessions = (d, n) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** Deterministic noise in [-1, 1) (LCG), no Math.random. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

function rows(S: number, perSession: number, shift: number, seed: number): CompRow[] {
  const n = noise(seed);
  const out: CompRow[] = [];
  for (let s = 0; s < S; s += 1)
    for (let i = 0; i < perSession; i += 1) out.push({ session: s, value: shift + n() });
  return out;
}

const pair = (id: string, shiftA: number, S = 120, seed = 1, block = 5): PairData => ({
  market: MARKET,
  pairId: id,
  a: rows(S, 2, shiftA, seed),
  b: rows(S, 2, 0, seed + 1000),
  sessionCount: S,
  block,
});

describe("Benjamini-Hochberg on a hand table (m = 10, q = 0.10)", () => {
  // thresholds k * 0.10 / 10 = 0.01, 0.02, ... 0.10
  // p:        .001 .008 .039 .041 .042 .055 .074 .205 .212 .216
  // p <= thr:  yes  yes  no   no   yes  yes  no   no   no   no   -> largest k = 6 (step-up)
  const ps = [0.216, 0.001, 0.042, 0.205, 0.008, 0.074, 0.039, 0.055, 0.212, 0.041];
  it("rejects ranks 1..6, including 0.039 and 0.041 that miss their own thresholds", () => {
    const res = benjaminiHochberg(
      ps.map((p, i) => ({ id: `t${i}`, p })),
      0.1,
    );
    expect(res.map((r) => r.p)).toEqual([...ps].sort((a, b) => a - b));
    expect(res.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(res.map((r) => r.discovery)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
  it("no p under its threshold gives no discovery; ties break by id", () => {
    const none = benjaminiHochberg(
      [
        { id: "a", p: 0.5 },
        { id: "b", p: 0.9 },
      ],
      0.1,
    );
    expect(none.every((r) => !r.discovery)).toBe(true);
    const tie = benjaminiHochberg(
      [
        { id: "z", p: 0.01 },
        { id: "a", p: 0.01 },
      ],
      0.1,
    );
    expect(tie.map((r) => r.id)).toEqual(["a", "z"]);
    expect(tie.every((r) => r.discovery)).toBe(true);
  });
  it("one test is plain p <= q", () => {
    expect(benjaminiHochberg([{ id: "x", p: 0.1 }], 0.1)[0]!.discovery).toBe(true);
    expect(benjaminiHochberg([{ id: "x", p: 0.11 }], 0.1)[0]!.discovery).toBe(false);
  });
});

describe("nightly descriptive rows", () => {
  it("labels every row descriptive, with an interval around the estimate, p NULL", () => {
    const [r] = nightlyComparisons(params, [pair("P1", 1)], "2026-10-20");
    expect(r!.kind).toBe("nightly");
    expect(r!.label).toBe(LABEL_DESCRIPTIVE);
    expect(r!.label).toBe("descriptive — not a finding");
    expect(r!.p).toBeNull();
    expect(r!.bh_rank).toBeNull();
    expect(r!.discovery).toBe(0);
    expect(r!.estimate).toBeGreaterThan(0.8);
    expect(r!.lower!).toBeLessThan(r!.estimate!);
    expect(r!.upper!).toBeGreaterThan(r!.estimate!);
    expect(r!.B).toBe(replicatesFor(params, params.learning.lessonBootstrapLevel));
  });
  it("fewer than comparison_min_rows on a side -> not enough data", () => {
    const small: PairData = {
      ...pair("P2", 1),
      a: rows(14, 2, 1, 5), // 28 rows < 30
    };
    const [r] = nightlyComparisons(params, [small], "2026-10-20");
    expect(r!.label).toBe("not enough data (n = 28)");
    expect(r!.label).toBe(labelNotEnoughData(28));
    expect(r!.estimate).toBeNull();
    expect(r!.lower).toBeNull();
    expect(r!.B).toBe(0);
  });
  it("exactly 30 rows per side is enough", () => {
    const edge: PairData = { ...pair("P3", 1), a: rows(15, 2, 1, 5), b: rows(15, 2, 0, 6) };
    expect(nightlyComparisons(params, [edge], "2026-10-20")[0]!.label).toBe(LABEL_DESCRIPTIVE);
  });
});

describe("weekly test", () => {
  const pairs = [
    pair("P-null1", 0, 120, 11),
    pair("P-real", 1.5, 120, 21),
    pair("P-null2", 0, 120, 31),
  ];
  const week = "2026-10-24";
  const bFor3 = replicatesFor(params, params.learning.comparisonsFdrQ / 3);

  it("finds the real difference only; BH ranks, B scales with m, candidate has direction and look date", () => {
    const out = weeklyComparisons(params, pairs, week, [], advance);
    const real = out.rows.find((r) => r.pair_id === "P-real")!;
    expect(real.discovery).toBe(1);
    expect(real.label).toBe(LABEL_WEEKLY_DISCOVERY);
    expect(real.bh_rank).toBe(1);
    expect(real.p!).toBeLessThan(0.01);
    const others = out.rows.filter((r) => r.discovery === 0);
    expect(others).toHaveLength(2);
    expect(others.every((r) => r.label === LABEL_WEEKLY_NONE)).toBe(true);
    expect(out.rows.every((r) => r.B === bFor3)).toBe(true);
    expect(out.candidates).toEqual([
      {
        id: `cf:P-real:${week}`,
        pair_id: "P-real",
        direction: 1,
        detected_d: week,
        look_due_d: advance(week, 75),
        state: "candidate",
        lockout_until_d: null,
        look_result_ref: null,
      },
    ]);
  });
  it("a negative difference gives direction -1", () => {
    const out = weeklyComparisons(params, [pair("P-neg", -1.5, 120, 41)], week, [], advance);
    expect(out.candidates[0]!.direction).toBe(-1);
  });
  it("pairs short of rows are labelled and left out of m", () => {
    const short: PairData = { ...pair("P-short", 1.5), a: rows(10, 2, 1.5, 3) };
    const out = weeklyComparisons(params, [...pairs, short], week, [], advance);
    const s = out.rows.find((r) => r.pair_id === "P-short")!;
    expect(s.label).toBe("not enough data (n = 20)");
    expect(s.p).toBeNull();
    expect(out.rows.find((r) => r.pair_id === "P-real")!.B).toBe(bFor3);
  });
  it("an open candidate or a running lockout excludes the pair; an ended lockout and a confirmed finding do not", () => {
    const f = (over: Partial<FindingRow>): FindingRow => ({
      id: "cf:P-real:2026-09-01",
      pair_id: "P-real",
      direction: 1,
      detected_d: "2026-09-01",
      look_due_d: "2026-11-15",
      state: "candidate",
      lockout_until_d: null,
      look_result_ref: null,
      ...over,
    });
    const discarded = {
      state: "discarded",
      lockout_until_d: "2026-10-30",
      look_result_ref: "r",
    } as const;
    expect(excludedPairs([f({})], week).has("P-real")).toBe(true);
    expect(excludedPairs([f(discarded)], week).has("P-real")).toBe(true);
    expect(excludedPairs([f(discarded)], "2026-10-30").has("P-real")).toBe(true);
    expect(excludedPairs([f(discarded)], "2026-10-31").has("P-real")).toBe(false);
    expect(excludedPairs([f({ state: "confirmed", look_result_ref: "r" })], week).size).toBe(0);
    const out = weeklyComparisons(params, pairs, week, [f({})], advance);
    expect(out.rows.map((r) => r.pair_id)).toEqual(["P-null1", "P-null2"]);
    expect(out.candidates).toEqual([]);
  });
});

describe("look rule", () => {
  it("needs max(75, 15 x block) sessions and >= 30 new rows per side", () => {
    expect(lookSessionsNeeded(params, 5)).toBe(75);
    expect(lookSessionsNeeded(params, 3)).toBe(75);
    expect(lookSessionsNeeded(params, 8)).toBe(120);
    expect(lookDueDate(params, "2026-10-24", 8, advance)).toBe(advance("2026-10-24", 120));
    expect(lookReady(params, 5, 30, 30, 75)).toBe(true);
    expect(lookReady(params, 5, 29, 30, 75)).toBe(false);
    expect(lookReady(params, 5, 30, 29, 75)).toBe(false);
    expect(lookReady(params, 5, 30, 30, 74)).toBe(false);
    expect(lookReady(params, 8, 30, 30, 119)).toBe(false);
    expect(lookReady(params, 8, 30, 30, 120)).toBe(true);
  });
});

describe("the one look and the lockout", () => {
  const detected = "2026-10-24";
  const lookD = advance(detected, 75);
  const cand: FindingRow = {
    id: findingId("P1", detected),
    pair_id: "P1",
    direction: 1,
    detected_d: detected,
    look_due_d: lookD,
    state: "candidate",
    lockout_until_d: null,
    look_result_ref: null,
  };
  it("passes on a confirmed direction: one-sided, label, no lockout", () => {
    const out = evaluateLook(params, cand, pair("P1", 1.5, 80, 51), lookD, 80, advance);
    expect(out.passed).toBe(true);
    expect(out.row.kind).toBe("look");
    expect(out.row.label).toBe(LABEL_LOOK_PASSED);
    expect(out.row.discovery).toBe(1);
    expect(out.row.p!).toBeLessThanOrEqual(params.learning.comparisonLookAlpha);
    expect(out.lockoutUntilD).toBeNull();
  });
  it("fails on no effect: discarded, locked out comparison_lockout_sessions sessions", () => {
    const out = evaluateLook(params, cand, pair("P1", 0, 80, 62), lookD, 80, advance);
    expect(out.passed).toBe(false);
    expect(out.row.label).toBe(LABEL_LOOK_FAILED);
    expect(out.row.discovery).toBe(0);
    expect(out.lockoutUntilD).toBe(advance(lookD, 60));
  });
  it("fails when the new data go the other way (one-sided in the detected direction)", () => {
    const out = evaluateLook(params, cand, pair("P1", -1.5, 80, 71), lookD, 80, advance);
    expect(out.passed).toBe(false);
    expect(out.row.p!).toBeGreaterThan(0.9);
  });
  it("a direction -1 candidate passes on a negative difference", () => {
    const neg = { ...cand, direction: -1 as const };
    expect(evaluateLook(params, neg, pair("P1", -1.5, 80, 81), lookD, 80, advance).passed).toBe(
      true,
    );
  });
  it("refuses an early look and a second look", () => {
    expect(() => evaluateLook(params, cand, pair("P1", 1.5, 60, 51), lookD, 60, advance)).toThrow(
      /not ready/,
    );
    const used = { ...cand, state: "confirmed", look_result_ref: "r" } as const;
    expect(() => evaluateLook(params, used, pair("P1", 1.5, 80, 51), lookD, 80, advance)).toThrow(
      /already used/,
    );
  });
});

describe("determinism", () => {
  it("same inputs give identical rows; the input order does not matter", () => {
    const ps = [pair("A", 1, 120, 1), pair("B", 0, 120, 2), pair("C", 0.5, 120, 3)];
    const x = JSON.stringify(nightlyComparisons(params, ps, "2026-10-20"));
    expect(JSON.stringify(nightlyComparisons(params, [...ps].reverse(), "2026-10-20"))).toBe(x);
    const w1 = JSON.stringify(weeklyComparisons(params, ps, "2026-10-24", [], advance));
    const w2 = JSON.stringify(
      weeklyComparisons(params, [...ps].reverse(), "2026-10-24", [], advance),
    );
    expect(w2).toBe(w1);
  });
  it("a different date or master seed gives different replicates", () => {
    const ps = [pair("A", 1, 120, 1)];
    const a = nightlyComparisons(params, ps, "2026-10-20")[0]!;
    const b = nightlyComparisons(params, ps, "2026-10-21")[0]!;
    const c = nightlyComparisons(params, ps, "2026-10-20", 7n)[0]!;
    expect(b.lower).not.toBe(a.lower);
    expect(c.lower).not.toBe(a.lower);
    expect(b.estimate).toBe(a.estimate);
  });
});

describe("persistence", () => {
  it("writes idempotently; the look moves the finding once", async () => {
    const db = await freshDb("main");
    const week = "2026-10-24";
    const ps = [pair("P-real", 1.5, 120, 21), pair("P-null", 0, 120, 31)];
    const night = nightlyComparisons(params, ps, week);
    await writeComparisonRows(db, night);
    await writeComparisonRows(db, night);
    const weekly = weeklyComparisons(params, ps, week, [], advance);
    await writeWeekly(db, weekly);
    await writeWeekly(db, weekly);
    const count = async (k: string) =>
      Number(
        (
          await db.execute({
            sql: "SELECT count(*) c FROM comparison_result WHERE kind = ?",
            args: [k],
          })
        ).rows[0]!.c,
      );
    expect(await count("nightly")).toBe(2);
    expect(await count("weekly")).toBe(2);
    const stored = await readFindings(db);
    expect(stored).toEqual(weekly.candidates);
    expect(stored).toHaveLength(1);

    const lookD = stored[0]!.look_due_d;
    const out = evaluateLook(params, stored[0]!, pair("P-real", 0, 80, 91), lookD, 80, advance);
    await writeLook(db, stored[0]!.id, out);
    await writeLook(db, stored[0]!.id, out);
    expect(await count("look")).toBe(1);
    const after = (await readFindings(db))[0]!;
    expect(after.state).toBe("discarded");
    expect(after.lockout_until_d).toBe(advance(lookD, 60));
    expect(after.look_result_ref).toBe(out.resultRef);
    const refRow = await db.execute({
      sql: "SELECT label FROM comparison_result WHERE kind = 'look' AND pair_id = ? AND d = ?",
      args: ["P-real", lookD],
    });
    expect(refRow.rows[0]!.label).toBe(LABEL_LOOK_FAILED);
    // locked out: the next weekly run skips the pair
    const next = weeklyComparisons(params, ps, advance(week, 7), await readFindings(db), advance);
    expect(next.rows.map((r) => r.pair_id)).toEqual(["P-null"]);
  });
});

describe("EML-037 statements", () => {
  it("no finding -> no detectable difference (n = ...)", () => {
    expect(statementFor({ pairId: "P1", n: 212 })).toBe(labelNoDetectableDifference(212));
    expect(statementFor({ pairId: "P1", n: 212 })).toBe("no detectable difference (n = 212)");
  });
  it("a confirmed finding states direction and numbers", () => {
    const s = statementFor({
      pairId: "P1",
      n: 90,
      confirmed: { direction: -1, estimate: -0.5, p: 0.01 },
    });
    expect(s).toContain("lower");
    expect(s).toContain("-0.5");
    expect(s).toContain("n = 90");
  });
});
