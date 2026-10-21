// @vitest-environment node
// Kill switch (M4 T15; ARN-093, docs/M4_design.md 4.10, decision 28): known answers for the look
// levels, the look schedule, K and the three criteria; the database side on synthetic forward rows
// (a trip recommends, writes once, and never touches a cohort or an order).
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, isWeekend } from "@/lib/data/calendar";
import { setConfig } from "@/lib/config/store";
import { killSwitchLevel } from "@/lib/stats/gates";
import {
  ensureLooksPerYear,
  evaluateCif,
  evaluateExpectancy,
  evaluateKillSwitch,
  evaluateWinRate,
  expectedTradesPerYear,
  lookLevel,
  looksPerYear,
  looksReached,
  type ForwardTrade,
  type KillSwitchParams,
  type LookInput,
} from "@/lib/stats/killSwitch";
import { cleanupTempDbs } from "../db/helpers";
import { freshReplayDb } from "../arena/replayHarness";

afterAll(cleanupTempDbs);

const P = { bootstrapReplicationsMin: 1000, progressMinNeff: 3 } as const;
const input = (over: Partial<LookInput>): LookInput => ({
  k: 1,
  alpha: lookLevel(1, 0.05, 3),
  trades: [],
  baseline: { meanNet: null, winRate: null, cifTargetLower90: null },
  cif: null,
  block: 2,
  params: P,
  scope: "ks:test",
  ...over,
});

describe("levels, schedule and K", () => {
  it("look k level is (0.05 / 3) / 2^k and equals the library helper", () => {
    expect(lookLevel(1, 0.05, 3)).toBeCloseTo(0.05 / 6, 15);
    expect(lookLevel(2, 0.05, 3)).toBeCloseTo(0.05 / 12, 15);
    expect(lookLevel(3, 0.05, 3)).toBeCloseTo(0.05 / 24, 15);
    for (let k = 1; k <= 6; k += 1) expect(lookLevel(k, 0.05, 3)).toBe(killSwitchLevel(k));
    // alpha spending: the levels of any number of looks never exceed the criterion's 0.05 / 3
    let spent = 0;
    for (let k = 1; k <= 12; k += 1) spent += lookLevel(k, 0.05, 3);
    expect(spent).toBeLessThan(0.05 / 3);
    expect(spent).toBeCloseTo((0.05 / 3) * (1 - 2 ** -12), 12);
    expect(() => lookLevel(0, 0.05, 3)).toThrow(RangeError);
  });

  it("looks are reached at 20, 40, 60 closed trades, at most K", () => {
    expect(looksReached(19, 20, 5)).toBe(0);
    expect(looksReached(20, 20, 5)).toBe(1);
    expect(looksReached(59, 20, 5)).toBe(2);
    expect(looksReached(60, 20, 5)).toBe(3);
    expect(looksReached(1000, 20, 5)).toBe(5);
    expect(looksReached(1000, 20, 1)).toBe(1);
  });

  it("K = max(1, ceil(expected trades a year / 20)), inside the key's range", () => {
    expect(looksPerYear(0, 20)).toBe(1);
    expect(looksPerYear(19.9, 20)).toBe(1);
    expect(looksPerYear(20, 20)).toBe(1);
    expect(looksPerYear(20.5, 20)).toBe(2);
    expect(looksPerYear(100, 20)).toBe(5);
    expect(looksPerYear(126, 20)).toBe(7);
    expect(looksPerYear(1_000_000, 20)).toBe(52); // the key's upper bound
  });
});

describe("criteria, known answers", () => {
  const trades = (nets: readonly number[]): ForwardTrade[] =>
    nets.map((net, i) => ({ entrySession: i * 3, net }));

  it("win rate: exact binomial lower tail against the development win rate", () => {
    // n = 20, p0 = 0.5: P(X <= 5) = 21,700 / 2^20 = 0.020695; P(X <= 4) = 6,196 / 2^20 = 0.005909
    const five = [...Array(5).fill(0.01), ...Array(15).fill(-0.01)];
    const four = [...Array(4).fill(0.01), ...Array(16).fill(-0.01)];
    const a = evaluateWinRate(input({ trades: trades(five), baseline: base({ winRate: 0.5 }) }));
    expect(a.p).toBeCloseTo(21700 / 1048576, 10);
    expect(a.triggered).toBe(false); // 0.0207 > alpha_1 = 0.008333
    const b = evaluateWinRate(input({ trades: trades(four), baseline: base({ winRate: 0.5 }) }));
    expect(b.p).toBeCloseTo(6196 / 1048576, 10);
    expect(b.triggered).toBe(true); // 0.0059 <= 0.008333
    expect(b.stat).toBe(0.2);
    // the same four wins at look 2 (alpha_2 = 0.004167) no longer trip
    const c = evaluateWinRate(
      input({
        k: 2,
        alpha: lookLevel(2, 0.05, 3),
        trades: trades(four),
        baseline: base({ winRate: 0.5 }),
      }),
    );
    expect(c.triggered).toBe(false);
    expect(evaluateWinRate(input({ trades: trades(four) })).estimable).toBe(false);
  });

  it("CIF: needs effective N >= 3 and a baseline, then a binomial lower tail", () => {
    const at = (effectiveN: number, targets: number, lower: number | null) =>
      evaluateCif(
        input({ cif: { effectiveN, targets }, baseline: base({ cifTargetLower90: lower }) }),
      );
    expect(at(2, 0, 0.5).estimable).toBe(false);
    expect(at(3, 0, null).estimable).toBe(false);
    expect(evaluateCif(input({ baseline: base({ cifTargetLower90: 0.5 }) })).estimable).toBe(false);
    const a = at(3, 0, 0.5); // P(X <= 0 | 3, 0.5) = 0.125
    expect(a.p).toBeCloseTo(0.125, 12);
    expect(a.triggered).toBe(false);
    const b = at(3, 0, 0.9); // 0.1^3 = 0.001
    expect(b.p).toBeCloseTo(0.001, 12);
    expect(b.triggered).toBe(true);
    expect(at(5, 5, 0.9).triggered).toBe(false);
  });

  it("expectancy: a shortfall trips, an in-line series does not, too few blocks is not estimable", () => {
    const wave = (centre: number) =>
      Array.from({ length: 20 }, (_, i) => centre + 0.01 * ((i % 7) - 3));
    const short = evaluateExpectancy(
      input({ trades: trades(wave(-0.03)), baseline: base({ meanNet: 0.03 }), scope: "ks:short" }),
    );
    expect(short.estimable).toBe(true);
    expect(short.triggered).toBe(true);
    expect(short.p!).toBeLessThanOrEqual(lookLevel(1, 0.05, 3));
    expect(short.stat!).toBeLessThan(0);
    const inline = evaluateExpectancy(
      input({ trades: trades(wave(0.03)), baseline: base({ meanNet: 0.03 }), scope: "ks:inline" }),
    );
    expect(inline.triggered).toBe(false);
    expect(inline.p!).toBeGreaterThan(0.1);
    // deterministic for the same scope
    expect(
      evaluateExpectancy(
        input({
          trades: trades(wave(-0.03)),
          baseline: base({ meanNet: 0.03 }),
          scope: "ks:short",
        }),
      ),
    ).toEqual(short);
    // 20 trades inside 40 sessions with block 20 is 2 blocks (< 15): not estimable, nothing is written
    const packed = evaluateExpectancy(
      input({
        trades: wave(-0.03).map((net, i) => ({ entrySession: i * 2, net })),
        baseline: base({ meanNet: 0.03 }),
        block: 20,
      }),
    );
    expect(packed.estimable).toBe(false);
    expect(evaluateExpectancy(input({ trades: trades(wave(0)) })).estimable).toBe(false);
  });
});

function base(over: Partial<LookInput["baseline"]>): LookInput["baseline"] {
  return { meanNet: null, winRate: null, cifTargetLower90: null, ...over };
}

// ---- database side ---------------------------------------------------------------------------------------

const DAYS: string[] = [];
for (let d = "2031-01-06"; DAYS.length < 400; d = addDays(d, 1)) if (!isWeekend(d)) DAYS.push(d);

const params: KillSwitchParams = {
  tradesPerLook: 20,
  alphaTotal: 0.05,
  criteria: 3,
  maxLooksPerYear: 3,
  bootstrapReplicationsMin: 1000,
  bootstrapBlockMinSessions: 2,
  progressMinNeff: 3,
};

async function seedBaseline(db: Client, win: number, mean: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO replay_run (id, kind, market, snapshot_sha, commit_sha, params_sha, seed, node_version,
            files_json, minutes) VALUES ('run-1', 'full', 'AU', 's', 'c', 'p', 1, 'v', '{}', 1)`,
  });
  const card = {
    scope: "AU:F1|F1.v1|F1",
    n: 80,
    insufficient: false,
    winRate: { value: win },
    expectancy: { value: mean },
  };
  await db.execute({
    sql: `INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('run-1', ?, 'scorecard', '2031-01-03', ?)`,
    args: ["AU:F1|F1.v1|F1", JSON.stringify(card)],
  });
}

/** n closed forward rows of F1: entry on day 2i, exit on day 2i + 1, net return net(i). */
async function seedRows(db: Client, n: number, net: (i: number) => number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const sid = `sig:AU:${DAYS[2 * i]}:F1:F1.v1:F1:ZZ${i}`;
    await db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
              evidence_json, partial, schema_version, agent_version, inputs_ref, decided_at)
            VALUES (?, 'AU', ?, 'F1', 'F1.v1', 'F1', ?, 'RISK-ON', '1', '[]', '{}', 0, 1, 'x', 'r', 't')`,
      args: [sid, DAYS[2 * i], `ZZ${i}`],
    });
    const out = BigInt(Math.round(1_000_000 * (1 + net(i))));
    await db.execute({
      sql: `INSERT INTO ledger_row (id, signal_id, group_key, entry_d, exit_d, exit_tag, qty, fill_in_micro,
              fill_out_micro, brok_in_micro, brok_out_micro, stress_in_micro, stress_out_micro, qty_out,
              dividend_micro, gross_num, gross_den, timed, forward)
            VALUES (?, ?, NULL, ?, NULL, NULL, 100, 1000000, NULL, 0, NULL, 100000000, NULL, NULL, 0, NULL, NULL, 1, 1)`,
      args: [`lr:${i}`, sid, DAYS[2 * i]],
    });
    await db.execute({
      sql: `UPDATE ledger_row SET exit_d = ?, exit_tag = 'CS', fill_out_micro = ?, brok_out_micro = 0,
              stress_out_micro = 100000000, qty_out = 100, dividend_micro = 0, gross_num = 1, gross_den = 100
            WHERE id = ?`,
      args: [DAYS[2 * i + 1], out, `lr:${i}`],
    });
  }
}

describe("evaluateKillSwitch on a database", () => {
  let db: Client;
  beforeAll(async () => {
    db = await freshReplayDb();
    await seedBaseline(db, 0.6, 0.03);
    await seedRows(db, 60, (i) => -0.02 + 0.004 * ((i % 7) - 3)); // every trade loses
  });
  const opts = (now: string) => ({
    market: "AU",
    d: DAYS[130]!,
    params,
    now: () => now,
    sessions: DAYS,
  });

  it("writes the due looks, trips, and only recommends (one arena_control row per family)", async () => {
    const out = await evaluateKillSwitch(db, opts("2031-07-01T00:00:00.000Z"));
    const looks = await db.execute(
      "SELECT criterion, look_k, trades, p, alpha_k, triggered FROM killswitch_look ORDER BY criterion, look_k",
    );
    // looks 1..3 (K = 3, 60 trades) for expectancy and win_rate; the CIF has no baseline
    expect(looks.rows.map((r) => `${r.criterion}:${r.look_k}`)).toEqual([
      "expectancy:1",
      "expectancy:2",
      "expectancy:3",
      "win_rate:1",
      "win_rate:2",
      "win_rate:3",
    ]);
    expect(looks.rows.map((r) => Number(r.trades))).toEqual([20, 40, 60, 20, 40, 60]);
    for (const r of looks.rows) {
      expect(Number(r.alpha_k)).toBeCloseTo(0.05 / 3 / 2 ** Number(r.look_k), 12);
      expect(Number(r.triggered)).toBe(1);
    }
    expect(out.looksWritten).toBe(6);
    expect(out.recommended).toEqual(["F1"]);
    const ctl = await db.execute(
      "SELECT scope, scope_key, state, set_by, reason FROM arena_control",
    );
    expect(ctl.rows).toHaveLength(1);
    expect(ctl.rows[0]).toMatchObject({
      scope: "family",
      scope_key: "F1",
      state: "killed",
      set_by: "killswitch",
    });
    expect(String(ctl.rows[0]!.reason)).toContain("nothing was paused automatically");
    // it touched no cohort and no order
    expect((await db.execute("SELECT COUNT(*) AS n FROM cohort")).rows[0]!.n).toBe(0n);
    expect((await db.execute("SELECT COUNT(*) AS n FROM arena_order")).rows[0]!.n).toBe(0n);
  });

  it("is idempotent: a re-run writes no look and no second state row", async () => {
    const again = await evaluateKillSwitch(db, opts("2031-07-02T00:00:00.000Z"));
    expect(again).toEqual({ looksWritten: 0, triggered: 0, recommended: [] });
    expect((await db.execute("SELECT COUNT(*) AS n FROM killswitch_look")).rows[0]!.n).toBe(6n);
    expect((await db.execute("SELECT COUNT(*) AS n FROM arena_control")).rows[0]!.n).toBe(1n);
  });

  it("looks are capped at K and only due ones are made", async () => {
    const fresh = await freshReplayDb();
    await seedBaseline(fresh, 0.6, 0.03);
    await seedRows(fresh, 45, (i) => 0.03 + 0.01 * ((i % 7) - 3)); // in line with the backtest
    const out = await evaluateKillSwitch(fresh, opts("2031-07-01T00:00:00.000Z"));
    const looks = await fresh.execute(
      "SELECT DISTINCT look_k FROM killswitch_look ORDER BY look_k",
    );
    expect(looks.rows.map((r) => Number(r.look_k))).toEqual([1, 2]); // 45 trades = 2 looks
    expect(out.triggered).toBe(0);
    expect((await fresh.execute("SELECT COUNT(*) AS n FROM arena_control")).rows[0]!.n).toBe(0n);
    const capped = await evaluateKillSwitch(fresh, {
      ...opts("2031-07-01T00:00:00.000Z"),
      params: { ...params, maxLooksPerYear: 1 },
    });
    expect(capped.looksWritten).toBe(0);
  });
});

describe("K computed yearly (decision 28)", () => {
  it("stores K once per calendar year from the development entry rate, then again next year", async () => {
    const db = await freshReplayDb();
    expect(
      await ensureLooksPerYear(db, {
        market: "AU",
        d: "2031-03-03",
        perLook: 20,
        now: "2031-03-03T08:00:00.000Z",
      }),
    ).toEqual({ computed: false, k: null });
    await db.execute({
      sql: `INSERT INTO replay_run (id, kind, market, snapshot_sha, commit_sha, params_sha, seed, node_version,
              files_json, minutes) VALUES ('run-1', 'full', 'AU', 's', 'c', 'p', 1, 'v', '{}', 1)`,
    });
    await db.execute({
      sql: `INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('run-1', 'all', 'family_flow', '2031-01-03', ?)`,
      args: [
        JSON.stringify([
          { family: "F1", entryRate: 0.5 },
          { family: "F4", entryRate: 0.1 },
        ]),
      ],
    });
    expect(await expectedTradesPerYear(db, "AU")).toBeCloseTo(126, 9);
    const first = await ensureLooksPerYear(db, {
      market: "AU",
      d: "2031-03-03",
      perLook: 20,
      now: "2031-03-03T08:00:00.000Z",
    });
    expect(first).toEqual({ computed: true, k: 7 }); // ceil(126 / 20)
    expect(
      await ensureLooksPerYear(db, {
        market: "AU",
        d: "2031-09-01",
        perLook: 20,
        now: "2031-09-01T08:00:00.000Z",
      }),
    ).toEqual({ computed: false, k: null });
    // an Owner edit after the computation is not overwritten within the year
    await setConfig(db, {
      key: "killswitch_max_looks_per_year",
      value: 9,
      userId: null,
      reason: "owner",
      now: "2031-09-02T08:00:00.000Z",
    });
    expect(
      (
        await ensureLooksPerYear(db, {
          market: "AU",
          d: "2031-09-03",
          perLook: 20,
          now: "2031-09-03T08:00:00.000Z",
        })
      ).computed,
    ).toBe(false);
    const next = await ensureLooksPerYear(db, {
      market: "AU",
      d: "2032-01-05",
      perLook: 20,
      now: "2032-01-05T08:00:00.000Z",
    });
    expect(next.computed).toBe(true);
    const versions = await db.execute(
      "SELECT value_json, reason FROM config_version WHERE key = 'killswitch_max_looks_per_year' ORDER BY id",
    );
    expect(versions.rows.map((r) => String(r.reason).split(" ")[0])).toEqual([
      "computed:2031",
      "owner",
      "computed:2032",
    ]);
  });
});
