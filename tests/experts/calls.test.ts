// @vitest-environment node
// Paper tracker for expert calls (M13-lite WP7; KB-080, D-524, D-640; AT-41 (b)). A ZZ world with an index
// that rises 1 point a session, a small universe, and calls of every kind: target, horizon (short), stop,
// untracked, still undecided and no bars. Synthetic data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  callOutcome,
  luckPct,
  settleCalls,
  signedReturnPpm,
  type CallInput,
} from "@/lib/experts/calls";
import { insertClaim } from "@/lib/experts/store";
import { cleanupTempDbs } from "../db/helpers";
import { MARKET, SESSIONS, world } from "../picks/harness";

afterAll(cleanupTempDbs);

const AT = "2030-03-05T08:00:00.000Z";
const M = 1_000_000n;
const bar = (d: string, c: number) => ({ d, closeMicro: BigInt(Math.round(c * 1e6)) });
const call = (over: Partial<CallInput> = {}): CallInput => ({
  direction: "long",
  callD: "2030-01-02",
  horizonSessions: 3,
  targetMicro: null,
  stopMicro: null,
  ...over,
});

describe("signedReturnPpm", () => {
  it("is direction-signed and rounds half away from zero", () => {
    expect(signedReturnPpm("long", 10n * M, 125n * (M / 10n))).toBe(250_000);
    expect(signedReturnPpm("short", 10n * M, 125n * (M / 10n))).toBe(-250_000);
    expect(signedReturnPpm("short", 20n * M, 16n * M)).toBe(200_000);
    expect(signedReturnPpm("long", 3n * M, 3n * M + 1n)).toBe(0); // 0.33 ppm
    expect(signedReturnPpm("long", 2n * M, 2n * M + 1n)).toBe(1); // 0.5 ppm rounds away
  });
});

describe("callOutcome (pure)", () => {
  const d = (i: number) => SESSIONS[i]!;
  const bars = [bar(d(1), 10), bar(d(2), 11), bar(d(3), 12), bar(d(4), 13)];

  it("enters at the first close after the call date and exits at the horizon bar", () => {
    const o = callOutcome(call({ callD: d(0), horizonSessions: 3 }), bars, false);
    expect(o).toEqual({ state: "closed_horizon", entryD: d(1), exitD: d(4), netPpm: 300_000 });
  });

  it("closes at the target, at the stop, and takes the stop when one close would do both", () => {
    const t = callOutcome(
      call({ callD: d(0), horizonSessions: 9, targetMicro: 11n * M }),
      bars,
      false,
    );
    expect(t).toMatchObject({ state: "closed_target", exitD: d(2), netPpm: 100_000 });
    const st = callOutcome(
      call({ callD: d(0), horizonSessions: 9, stopMicro: 10n * M }),
      [bar(d(1), 10), bar(d(2), 10.5), bar(d(3), 9.9)],
      false,
    );
    expect(st).toMatchObject({ state: "closed_stop", exitD: d(3), netPpm: -10_000 });
    // nonsense levels (target below stop): one close does both and the stop wins
    const both = callOutcome(
      call({ callD: d(0), horizonSessions: 9, targetMicro: 9n * M, stopMicro: 11n * M }),
      [bar(d(1), 10), bar(d(2), 10.5)],
      false,
    );
    expect(both?.state).toBe("closed_stop");
  });

  it("a short call mirrors the levels", () => {
    const o = callOutcome(
      call({
        direction: "short",
        callD: d(0),
        horizonSessions: 9,
        targetMicro: 9n * M,
        stopMicro: 12n * M,
      }),
      [bar(d(1), 10), bar(d(2), 9.5), bar(d(3), 8.9)],
      false,
    );
    expect(o).toMatchObject({ state: "closed_target", exitD: d(3), netPpm: 110_000 });
    const st = callOutcome(
      call({ direction: "short", callD: d(0), horizonSessions: 9, stopMicro: 12n * M }),
      [bar(d(1), 10), bar(d(2), 12.1)],
      false,
    );
    expect(st).toMatchObject({ state: "closed_stop", netPpm: -210_000 });
  });

  it("is undecided without the horizon bar, until the horizon has passed", () => {
    const c = call({ callD: d(0), horizonSessions: 9 });
    expect(callOutcome(c, bars, false)).toBeNull();
    expect(callOutcome(c, bars, true)).toMatchObject({ state: "closed_horizon", exitD: d(4) });
    expect(callOutcome(c, [], false)).toBeNull();
    expect(callOutcome(c, [], true)).toEqual({
      state: "no_bars",
      entryD: null,
      exitD: null,
      netPpm: null,
    });
    expect(callOutcome(c, [bar(d(1), 10)], true)?.state).toBe("no_bars");
  });

  it("ignores bars on or before the call date and non-positive closes", () => {
    const o = callOutcome(
      call({ callD: d(1), horizonSessions: 1 }),
      [bar(d(0), 5), bar(d(1), 5), bar(d(2), 0), bar(d(3), 10), bar(d(4), 11)],
      false,
    );
    expect(o).toMatchObject({ entryD: d(3), exitD: d(4), netPpm: 100_000 });
  });
});

// ---- the database --------------------------------------------------------------------------------------

const D = SESSIONS[20]!;
const at = (i: number) => SESSIONS[i]!;

type Run = (sql: string, args?: (string | number | bigint | null)[]) => Promise<unknown>;

async function addClose(run: Run, code: string, i: number, c: number): Promise<void> {
  await run(
    `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1000000, 'test', ?, ?)`,
    [MARKET, code, at(i), c, c, c, c, `${at(i)}T07:00:00.000Z`, `${at(i)}T07:00:00.000Z`],
  );
}

type CallSeed = {
  id: string;
  code: string;
  direction: "long" | "short";
  horizon: number;
  tracked: 0 | 1;
  target?: number;
  stop?: number;
};

async function addCall(db: Client, c: CallSeed): Promise<void> {
  await insertClaim(db, {
    id: c.id,
    type: "call",
    testability: "testable_eod",
    clusterId: null,
    statement: `ZZ call ${c.id}`,
    actor: "seed",
    at: AT,
  });
  await db.execute({
    sql: `INSERT INTO expert_call (claim_id, market, code, direction, call_d, horizon_sessions, target_micro,
            stop_micro, tracked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      c.id,
      MARKET,
      c.code,
      c.direction,
      at(10),
      c.horizon,
      c.target === undefined ? null : Math.round(c.target * 1e6),
      c.stop === undefined ? null : Math.round(c.stop * 1e6),
      c.tracked,
      AT,
    ],
  });
}

const outcome = async (db: Client, id: string) =>
  (await db.execute({ sql: "SELECT * FROM expert_call_outcome WHERE claim_id = ?", args: [id] }))
    .rows[0];

let db: Client;
let run: Run;

beforeAll(async () => {
  const w = await world();
  db = w.db;
  run = w.run as Run;
  for (let i = 0; i < 40; i += 1) {
    await run(
      `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
       VALUES (?, 'AXJO', ?, ?, ?, ?, ?, 'test', ?, ?)`,
      [
        MARKET,
        at(i),
        (100 + i) * 1_000_000,
        (100 + i) * 1_000_000,
        (100 + i) * 1_000_000,
        (100 + i) * 1_000_000,
        `${at(i)}T07:00:00.000Z`,
        `${at(i)}T07:00:00.000Z`,
      ],
    );
  }
  for (const code of ["ZZU1", "ZZU2", "ZZU3", "ZZU4", "ZZC"]) {
    await run(
      `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
       VALUES (?, ?, ?, 'active', 'U1', 1e9, 1e6, 0)`,
      [MARKET, at(0), code],
    );
  }
  await db.execute({
    sql: "INSERT INTO expert (id, name, status, tier, created_at, updated_at) VALUES ('X-ZZ1', 'ZZ Expert 1', 'tracked', 'core', ?, ?)",
    args: [AT, AT],
  });
  // A: long, target hit on the 4th bar. Entry 10.0 at idx 11, exit 12.5 at idx 14.
  for (const [i, c] of [
    [11, 10],
    [12, 10.5],
    [13, 11],
    [14, 12.5],
  ] as const) {
    await addClose(run, "ZZC", i, c);
  }
  // universe closes on the entry and exit dates: +30 %, +10 %, 0 %, -10 %
  for (const [code, exit] of [
    ["ZZU1", 13],
    ["ZZU2", 11],
    ["ZZU3", 10],
    ["ZZU4", 9],
  ] as const) {
    await addClose(run, code, 11, 10);
    await addClose(run, code, 14, exit);
  }
  // B: short, horizon 3, no levels. Entry 20 (idx 11), exit 16 (idx 14).
  for (const [i, c] of [
    [11, 20],
    [12, 19],
    [13, 18],
    [14, 16],
  ] as const) {
    await addClose(run, "ZZS", i, c);
  }
  // C: long, stop 8: 10, 9, 7.
  for (const [i, c] of [
    [11, 10],
    [12, 9],
    [13, 7],
  ] as const) {
    await addClose(run, "ZZP", i, c);
  }
  // N: untracked; E: undecided (bars to idx 15, horizon 30); G: no bars at all
  for (const [i, c] of [
    [11, 10],
    [12, 11],
    [13, 12],
    [14, 13],
    [15, 14],
  ] as const) {
    await addClose(run, "ZZN", i, c);
    await addClose(run, "ZZE", i, c);
  }
  await addCall(db, {
    id: "C-A",
    code: "ZZC",
    direction: "long",
    horizon: 10,
    tracked: 1,
    target: 12,
    stop: 8,
  });
  await addCall(db, { id: "C-B", code: "ZZS", direction: "short", horizon: 3, tracked: 1 });
  await addCall(db, {
    id: "C-C",
    code: "ZZP",
    direction: "long",
    horizon: 10,
    tracked: 1,
    stop: 8,
  });
  await addCall(db, { id: "C-N", code: "ZZN", direction: "long", horizon: 3, tracked: 0 });
  await addCall(db, { id: "C-E", code: "ZZE", direction: "long", horizon: 30, tracked: 1 });
  await addCall(db, { id: "C-G", code: "ZZG", direction: "long", horizon: 5, tracked: 1 });
});

describe("settleCalls", () => {
  it("settles the decidable tracked calls once and reports tracked / settled / skipped", async () => {
    const first = await settleCalls(db, MARKET, D, SESSIONS);
    expect(first).toEqual({ tracked: 5, settled: 4, skipped: 1 });

    const a = await outcome(db, "C-A");
    expect(a).toMatchObject({
      state: "closed_target",
      entry_d: at(11),
      exit_d: at(14),
      net_ppm: 250_000,
      index_code: "AXJO",
      basis: "price_only",
      market_ret_ppm: 27_027, // 111 -> 114
      vs_market_ppm: 222_973,
      luck_pct: 25, // one of four universe codes did better (+30 % against +25 %)
      settled_d: D,
    });

    const b = await outcome(db, "C-B");
    expect(b).toMatchObject({
      state: "closed_horizon",
      net_ppm: 200_000,
      market_ret_ppm: 27_027,
      vs_market_ppm: 227_027, // a short is set against the market the other way round
      luck_pct: 0,
    });

    const c = await outcome(db, "C-C");
    expect(c).toMatchObject({
      state: "closed_stop",
      exit_d: at(13),
      net_ppm: -300_000,
      market_ret_ppm: 18_018, // 111 -> 113
      vs_market_ppm: -318_018,
      luck_pct: 100, // only ZZC has closes on both dates, and it rose
    });

    expect(await outcome(db, "C-G")).toMatchObject({
      state: "no_bars",
      entry_d: null,
      net_ppm: null,
      market_ret_ppm: null,
      vs_market_ppm: null,
    });
    expect(await outcome(db, "C-N")).toBeUndefined(); // untracked: never settled
    expect(await outcome(db, "C-E")).toBeUndefined(); // undecided: no horizon bar yet
  });

  it("is idempotent: a rerun writes nothing and changes nothing", async () => {
    const before = (await db.execute("SELECT * FROM expert_call_outcome ORDER BY claim_id")).rows;
    const again = await settleCalls(db, MARKET, at(25), SESSIONS);
    expect(again.settled).toBe(0);
    const after = (await db.execute("SELECT * FROM expert_call_outcome ORDER BY claim_id")).rows;
    expect(after.map((r) => ({ ...r }))).toEqual(before.map((r) => ({ ...r })));
  });

  it("an undecided call settles once its horizon bar exists, from the bars alone", async () => {
    for (let i = 16; i <= 20; i += 1) await addClose(run, "ZZE", i, 14 + i - 15);
    // no sessions list: only a call whose horizon bar exists is settled; horizon 30 still has none
    expect((await settleCalls(db, MARKET, D)).settled).toBe(0);
    expect(await outcome(db, "C-E")).toBeUndefined();
  });

  it("never touches a market other than the one asked for", async () => {
    expect(await settleCalls(db, "US", D, SESSIONS)).toEqual({
      tracked: 0,
      settled: 0,
      skipped: 0,
    });
  });

  it("holds the outcome back while the index has no window (picks do the same)", async () => {
    const w = await world();
    await w.run(
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES (?, 'ZZQ', ?, 5, 5, 5, 5, 1, 'test', 'x', 'x')`,
      [MARKET, at(11)],
    );
    await w.run(
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES (?, 'ZZQ', ?, 6, 6, 6, 6, 1, 'test', 'x', 'x')`,
      [MARKET, at(12)],
    );
    await addCall(w.db, { id: "C-Q", code: "ZZQ", direction: "long", horizon: 1, tracked: 1 });
    expect(await settleCalls(w.db, MARKET, D, SESSIONS)).toEqual({
      tracked: 1,
      settled: 0,
      skipped: 1,
    });
  });
});

describe("luckPct", () => {
  it("is NULL without a universe snapshot, and counts only codes with both closes", async () => {
    const w = await world();
    expect(
      await luckPct(w.db, {
        market: MARKET,
        code: "ZZC",
        direction: "long",
        entryD: at(11),
        exitD: at(14),
        netPpm: 0,
      }),
    ).toBeNull();
    expect(
      await luckPct(db, {
        market: MARKET,
        code: "ZZC",
        direction: "long",
        entryD: at(11),
        exitD: at(14),
        netPpm: 250_000,
      }),
    ).toBe(25);
    // a call that beat everyone: 0 %; one that lost to everyone: 100 %
    expect(
      await luckPct(db, {
        market: MARKET,
        code: "ZZC",
        direction: "long",
        entryD: at(11),
        exitD: at(14),
        netPpm: 400_000,
      }),
    ).toBe(0);
    expect(
      await luckPct(db, {
        market: MARKET,
        code: "ZZC",
        direction: "long",
        entryD: at(11),
        exitD: at(14),
        netPpm: -900_000,
      }),
    ).toBe(100);
  });
});
