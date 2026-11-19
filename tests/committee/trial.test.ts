// @vitest-environment node
// Committee trial statistic, verdict and nightly step (M22 C2; VAL-111, ARN-105, AT-36; D-1420, D-1421, D-1422): hand-computed
// D and p on a 6-night table, an independent brute-force cross-check with neutrals, the permutation count from the key, seeded
// determinism, the verdict rules, the outcomes read from the ledger, and the step: interim rows, the one final look, the
// switch off, the refusals. Synthetic ZZ data over the real migrations.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { readOutcomes, netPpmOf } from "@/lib/committee/outcomes";
import {
  diffOf,
  INTERIM_NOTE,
  permutationTest,
  segmentsOf,
  trialNight,
  verdictOf,
  type LabelledRow,
  type Measure,
} from "@/lib/committee/trial";
import { getConfig } from "@/lib/config/store";
import { cleanupTempDbs } from "../db/helpers";
import { build, dayOf, FROZEN, grid, NOW, switchOn, TRIAL, type Spec } from "./trialWorld";

afterEach(cleanupTempDbs);

const row = (
  night: number,
  rating: LabelledRow["rating"],
  netPpm: number,
  i = 0,
  judge: string | null = null,
): LabelledRow => ({
  d: dayOf(night),
  signalId: `s${night}-${i}`,
  rating,
  netPpm,
  judgeModel: judge,
});

/** One approved and one rejected signal per night whose outcomes differ by `delta[i]`. */
const sixNights = (delta: readonly number[]): LabelledRow[] =>
  delta.flatMap((dl, n) => [row(n, "approve", 100 + dl, 0), row(n, "reject", 100, 1)]);

describe("permutationTest: hand-computed on a 6-night table", () => {
  it("differences 1..6: D = 21/6 = 3.5 ppm; only the all-positive labeling reaches it, so p = 1/64", () => {
    const t = permutationTest(sixNights([1, 2, 3, 4, 5, 6]), 20000, "committee:x");
    expect(t.d).toBeCloseTo(3.5, 10);
    expect(t.exact).toBe(true); // 2^6 = 64 labelings, fewer than the permutations: every one is counted
    expect(t.counted).toBe(64);
    expect(t.p).toBe(1 / 64);
    expect([t.approve, t.neutral, t.reject]).toEqual([6, 0, 6]);
  });

  it("differences 5,-1,4,3,-2,6: D = 15/6 = 2.5 ppm; the labelings whose flipped nights add up to at most 3 reach it, p = 5/64", () => {
    // flipped (negative) nights must have |delta| summing to at most 3: {}, {1}, {2}, {3}, {1,2} -> 5 of 64
    const t = permutationTest(sixNights([5, -1, 4, 3, -2, 6]), 20000, "committee:x");
    expect(t.d).toBeCloseTo(2.5, 10);
    expect(t.counted).toBe(64);
    expect(t.p).toBe(5 / 64);
  });

  it("agrees with an independent brute force on two nights of three labels (36 labelings)", () => {
    const rows = [
      row(0, "approve", 30, 0),
      row(0, "neutral", -10, 1),
      row(0, "reject", 5, 2),
      row(1, "approve", 12, 0),
      row(1, "neutral", 40, 1),
      row(1, "reject", -8, 2),
    ];
    const t = permutationTest(rows, 20000, "committee:x");
    // brute force: every permutation of the three labels on each night, D = mean approve - mean reject
    const labels = ["approve", "neutral", "reject"] as const;
    const perms: (typeof labels)[number][][] = [];
    const go = (cur: (typeof labels)[number][], left: (typeof labels)[number][]): void => {
      if (left.length === 0) return void perms.push(cur);
      left.forEach((x, i) => go([...cur, x], [...left.slice(0, i), ...left.slice(i + 1)]));
    };
    go([], [...labels]);
    const out = [
      [30, -10, 5],
      [12, 40, -8],
    ];
    const D = (a: (typeof labels)[number][], b: (typeof labels)[number][]): number => {
      const ap = [
        ...a.map((l, i) => [l, out[0]![i]!] as const),
        ...b.map((l, i) => [l, out[1]![i]!] as const),
      ];
      const mean = (w: string) => {
        const v = ap.filter(([l]) => l === w).map(([, o]) => o);
        return v.reduce((s, x) => s + x, 0) / v.length;
      };
      return mean("approve") - mean("reject");
    };
    const obs = D(["approve", "neutral", "reject"], ["approve", "neutral", "reject"]);
    let atLeast = 0;
    for (const a of perms) for (const b of perms) if (D(a, b) >= obs - 1e-9) atLeast += 1;
    expect(t.counted).toBe(36);
    expect(t.p).toBe(atLeast / 36);
    expect(t.d).toBeCloseTo(obs, 9);
  });

  it("is undefined without an approved and a rejected signal", () => {
    const t = permutationTest([row(0, "approve", 5), row(0, "neutral", 6, 1)], 100, "committee:x");
    expect(t).toMatchObject({ d: null, p: null });
    expect(diffOf([row(0, "neutral", 1)])).toBeNull();
  });
});

describe("permutationTest: the count and the seed", () => {
  const big = (): LabelledRow[] =>
    Array.from({ length: 30 }, (_, n) => [
      row(n, "approve", (n * 37) % 11, 0),
      row(n, "neutral", (n * 13) % 7, 1),
      row(n, "reject", (n * 29) % 5, 2),
    ]).flat();

  it("draws exactly `permutations` shuffles when the labelings are too many, and p is a multiple of 1/(P+1)", () => {
    for (const P of [500, 777]) {
      const t = permutationTest(big(), P, "committee:a");
      expect(t.exact).toBe(false);
      expect(t.counted).toBe(P);
      expect(t.permutations).toBe(P);
      const k = (t.p as number) * (P + 1);
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
      expect(t.p as number).toBeGreaterThan(0); // the observed labeling is counted: never exactly 0
    }
  });

  it("is deterministic for a scope, and the table order does not matter", () => {
    const a = permutationTest(big(), 600, "committee:a");
    const b = permutationTest([...big()].reverse(), 600, "committee:a");
    expect(b).toEqual(a);
  });
});

describe("segments and the verdict", () => {
  const frozen = { ...FROZEN, trial_sessions: 10, min_settled: 20 };
  const test = (d: number | null, p: number | null) =>
    ({
      d,
      p,
      permutations: 2000,
      counted: 2000,
      exact: false,
      approve: 8,
      neutral: 4,
      reject: 8,
    }) as const;
  const m = (over: Partial<Measure>): Measure => ({
    nights: 10,
    ratedNights: 10,
    settled: 20,
    unsettled: 0,
    lateExit: 0,
    test: test(5000, 0.01),
    segments: [],
    ...over,
  });

  it("PASS needs the sessions, the sample, p below 0.05, D above one round trip and no reversed segment", () => {
    expect(verdictOf(frozen, m({}))).toMatchObject({ verdict: "PASS", reason: "passed" });
    expect(verdictOf(frozen, m({ nights: 9 }))).toMatchObject({
      verdict: "running",
      reason: "sessions_short",
    });
    expect(verdictOf(frozen, m({ settled: 19 }))).toMatchObject({
      verdict: "running",
      reason: "sample_short",
    });
    expect(verdictOf(frozen, m({ test: test(5000, 0.05) }))).toMatchObject({
      verdict: "FAIL",
      reason: "not_significant",
    });
    expect(verdictOf(frozen, m({ test: test(1000, 0.01) }))).toMatchObject({
      verdict: "FAIL",
      reason: "below_cost",
    });
    expect(verdictOf(frozen, m({ test: test(null, null) }))).toMatchObject({
      verdict: "FAIL",
      reason: "no_contrast",
    });
  });

  it("a negative D on a judge-model segment of at least 50 stops a PASS; a small segment does not", () => {
    const seg = (n: number, d: number) => [
      { model: "a", n: 60, d: 9000 },
      { model: "b", n, d },
    ];
    expect(verdictOf(frozen, m({ segments: seg(50, -1) }))).toMatchObject({
      verdict: "FAIL",
      reason: "reversal",
      reversal: true,
    });
    expect(verdictOf(frozen, m({ segments: seg(49, -1) })).verdict).toBe("PASS");
    expect(verdictOf(frozen, m({ segments: seg(80, 0) })).verdict).toBe("PASS"); // zero is not a reversal
  });

  it("INCONCLUSIVE after twice the sessions without the sample, running before", () => {
    expect(verdictOf(frozen, m({ nights: 19, settled: 3 })).verdict).toBe("running");
    expect(verdictOf(frozen, m({ nights: 20, settled: 3 }))).toMatchObject({
      verdict: "INCONCLUSIVE",
      reason: "sample_never_met",
    });
    // the sample met late is judged, not inconclusive
    expect(verdictOf(frozen, m({ nights: 25, settled: 20 })).verdict).toBe("PASS");
  });

  it("segments are per judge model in name order", () => {
    const s = segmentsOf([
      row(0, "approve", 10, 0, "b"),
      row(0, "reject", 0, 1, "b"),
      row(1, "approve", 5, 0, "a"),
      row(1, "neutral", 9, 1, null),
    ]);
    expect(s).toEqual([
      { model: "a", n: 1, d: null },
      { model: "b", n: 2, d: 10 },
      { model: "none", n: 1, d: null },
    ]);
  });
});

describe("outcomes from the ledger (D-1422)", () => {
  it("the net is exact ppm of the cost basis, half away from zero", () => {
    const r = {
      qty: 2,
      qty_out: 2,
      fill_in_micro: 1_000_000,
      fill_out_micro: 1_100_000,
      brok_in_micro: 5_000,
      brok_out_micro: 5_000,
      dividend_micro: 0,
    };
    // cost 2,005,000 ; proceeds 2,195,000 ; net 190,000 / 2,005,000 = 94,763.09... ppm
    expect(netPpmOf(r)).toBe(94_763);
    expect(netPpmOf({ ...r, fill_out_micro: 900_000 })).toBe(-104_738); // -210,000 / 2,005,000
  });

  it("settles closed forward rows within the horizon, counts the rest as unsettled or late, and ignores unrated skips", async () => {
    const specs: Spec[] = [
      { night: 0, rating: "approve", net: 200 },
      { night: 0, rating: "reject", net: -50 },
      { night: 1, rating: "neutral", net: null }, // no ledger row: unsettled
      { night: 1, rating: "approve", net: null, open: true }, // open: unsettled
      { night: 2, rating: "reject", net: 70, exitDays: 30 }, // closed far after the horizon of 5 sessions
      { night: 2, rating: "skipped_models", net: null }, // never counted
    ];
    const db = await build(specs);
    const out = await readOutcomes(db, { market: "AU", trialId: TRIAL, horizonSessions: 5 });
    expect(out.settled.map((s) => [s.rating, s.netPpm])).toEqual([
      ["approve", 200],
      ["reject", -50],
    ]);
    expect(out.unsettled).toBe(2);
    expect(out.lateExit).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const frozenSmall = {
  trial_sessions: 6,
  min_settled: 12,
  permutations: 2000,
  cost_threshold_ppm: 100,
};
const stepOpts = (d: string, over: Record<string, unknown> = {}) => ({
  market: "AU",
  d,
  today: d,
  now: NOW,
  ...over,
});
const results = async (db: Client) =>
  (await db.execute("SELECT * FROM committee_trial_result ORDER BY kind, d")).rows;

/** Approved signals earn +900 ppm over the rejected ones on every night. */
const winning = (nights: number): Spec[] =>
  grid(nights, (n, l) => (l === "approve" ? 1000 + (n % 3) : l === "reject" ? 100 + (n % 2) : 500));

describe("trialNight: the nightly step", () => {
  it("does nothing without a pre-registration, with the switch off, on a replay or a past date", async () => {
    const none = await build([], { prereg: false });
    await switchOn(none);
    expect(await trialNight(none, stepOpts(dayOf(0)))).toEqual({ status: "no_trial" });
    const db = await build(winning(3), { frozen: frozenSmall });
    expect(await trialNight(db, stepOpts(dayOf(3)))).toEqual({ status: "off" });
    await switchOn(db);
    expect(await trialNight(db, { ...stepOpts(dayOf(3)), replay: true })).toEqual({
      status: "refused",
    });
    expect(await trialNight(db, { ...stepOpts(dayOf(3)), today: dayOf(4) })).toEqual({
      status: "refused",
    });
    expect(await results(db)).toHaveLength(0);
  });

  it("writes one interim row a night labelled interim, not a result; a repeat the same night keeps the first", async () => {
    const db = await build(winning(3), { frozen: frozenSmall });
    await switchOn(db);
    const r = await trialNight(db, stepOpts(dayOf(3)));
    expect(r).toMatchObject({ status: "running", reason: "sample_short" });
    await trialNight(db, stepOpts(dayOf(3)));
    const rows = await results(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "interim", verdict: "running", d: dayOf(3) });
    const stats = JSON.parse(String(rows[0]!.stats_json)) as Record<string, unknown>;
    expect(stats).toMatchObject({ note: INTERIM_NOTE, nights: 3, settled: 9, permutations: 2000 });
    expect(stats.d_ppm).toBeGreaterThan(0);
    expect(await getConfig(db, "committee_enabled")).toBe("on");
  });

  it("writes the one final verdict with its look, then switches the Committee off as the system", async () => {
    const db = await build(winning(8), { frozen: frozenSmall });
    await switchOn(db);
    const r = await trialNight(db, stepOpts(dayOf(8)));
    expect(r).toEqual({ status: "final", trialId: TRIAL, verdict: "PASS" });
    const fin = (await results(db)).filter((x) => x.kind === "final");
    expect(fin).toHaveLength(1);
    expect(fin[0]).toMatchObject({ verdict: "PASS", d: dayOf(8) });
    const stats = JSON.parse(String(fin[0]!.stats_json)) as Record<string, unknown>;
    expect(stats.note).toBeUndefined();
    expect(stats).toMatchObject({ reason: "passed", settled: 24, nights: 8 });
    const look = (await db.execute("SELECT * FROM holdout_look")).rows;
    expect(look).toHaveLength(1);
    expect(look[0]).toMatchObject({ lineage: "committee_trial", market: "AU", verdict: "PASS" });
    expect(await getConfig(db, "committee_enabled")).toBe("off");
    const cv = (
      await db.execute(
        "SELECT changed_by_user_id, value_json, reason FROM config_version WHERE key = 'committee_enabled' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0]!;
    expect(cv).toMatchObject({ changed_by_user_id: null, value_json: '"off"' });
    expect(String(cv.reason)).toMatch(/Committee trial passed/);
    const log = (
      await db.execute(
        "SELECT level, source, message FROM app_log WHERE source = 'committee-trial'",
      )
    ).rows;
    expect(log).toHaveLength(1);
  });

  it("looks once: a second night after the verdict measures nothing, writes no second row and keeps the switch off", async () => {
    const db = await build(winning(8), { frozen: frozenSmall });
    await switchOn(db);
    await trialNight(db, stepOpts(dayOf(8)));
    // more outcomes arrive that would change the answer; nothing re-computes
    await build(
      grid(4, () => -5000).map((s) => ({ ...s, night: s.night + 20 })),
      { db, prereg: false },
    );
    await switchOn(db); // an Owner switches it on again: the step puts it back off
    const again = await trialNight(db, stepOpts(dayOf(9)));
    expect(again).toEqual({ status: "finished" });
    expect((await results(db)).filter((x) => x.kind === "final")).toHaveLength(1);
    expect((await db.execute("SELECT COUNT(*) n FROM holdout_look")).rows[0]!.n).toBe(1);
    expect(await getConfig(db, "committee_enabled")).toBe("off");
  });

  it("repairs a final row that has no look (a night that stopped between the two writes)", async () => {
    const db = await build(winning(8), { frozen: frozenSmall });
    await switchOn(db);
    await db.execute({
      sql: "INSERT INTO committee_trial_result (trial_id, market, d, kind, verdict, stats_json, created_at) VALUES (?, 'AU', ?, 'final', 'FAIL', '{}', ?)",
      args: [TRIAL, dayOf(8), NOW],
    });
    expect(await trialNight(db, stepOpts(dayOf(9)))).toEqual({ status: "finished" });
    expect(
      (await db.execute("SELECT verdict FROM holdout_look")).rows.map((r) => r.verdict),
    ).toEqual(["NULL"]);
  });

  it("FAIL when the sample and the sessions are met and the labels carry no signal", async () => {
    const db = await build(
      grid(8, () => 100),
      { frozen: frozenSmall },
    );
    await switchOn(db);
    expect(await trialNight(db, stepOpts(dayOf(8)))).toEqual({
      status: "final",
      trialId: TRIAL,
      verdict: "FAIL",
    });
  });

  it("INCONCLUSIVE after twice the sessions with the sample never met (ratings that never settle)", async () => {
    const db = await build(
      grid(12, () => 0).map((s) => ({ ...s, net: null })),
      { frozen: frozenSmall },
    );
    await switchOn(db);
    expect(await trialNight(db, stepOpts(dayOf(12)))).toEqual({
      status: "final",
      trialId: TRIAL,
      verdict: "INCONCLUSIVE",
    });
  });
});
