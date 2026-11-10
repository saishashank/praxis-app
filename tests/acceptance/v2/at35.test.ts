// @vitest-environment node
// AT-35 Picks vs market (M11-lite WP5; ARN-103/104, UXN-288, D-490): a missed pick, a gap-stop exit and a
// dividend inside the window, settled by the real `trackPicks`, match the hand table to 0.01 pp (100 ppm).
// The figures cannot be edited or deleted after settlement, and the basis label is the total-return one.
//
// Hand table (index closes; ETF close 50 and dividend 0.50 going ex on S3 => +1 % that session):
//   session  S0    S1    S2    S3 (ex)              S4
//   close    100   100   102   102                  104
//   level    100   100   102   102 x 1.01=103.02    103.02 x 104/102 = 105.04
//   A  ZZA bought S1 open, gap stop S2 : level S0 100 -> S2 102      = +2.00 % = 20 000 ppm
//   B  ZZB bought S1 open, aim on S4   : level S0 100 -> S4 105.04   = +5.04 % = 50 400 ppm (price only: 4.00 %)
//   C  ZZC never bought, withdrawn night S3 : S0 100 -> S3 103.02    = +3.02 % = 30 200 ppm, missed
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { benchmarkLabel, TOTAL_RETURN_BASIS_LABEL } from "@/lib/picks/benchmark";
import { feeFor, getCostProfile } from "@/lib/arena/costs";
import { trackPicks } from "@/lib/picks/track";
import { setConfig } from "@/lib/config/store";
import {
  parseVendorActionsText,
  writeVendorActions,
} from "../../../src/lib/data/vendorActions/vendorActions.mjs";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterAll(cleanupTempDbs);

const S = ["2030-01-02", "2030-01-03", "2030-01-04", "2030-01-07", "2030-01-08", "2030-01-09"];
const SHA = "a".repeat(64);
const TOL = 100; // 0.01 pp in ppm

let db: Client;
const run = (sql: string, args: (string | number | null)[] = []) => db.execute({ sql, args });

async function bar(code: string, d: string, o: number, h: number, l: number, c: number) {
  await run(
    `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
     VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000000, 'test', ?, ?)`,
    [code, d, o, h, l, c, `${d}T07:00:00.000Z`, `${d}T07:00:00.000Z`],
  );
}

async function pick(rank: number, code: string) {
  await run(
    `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
       reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
       typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
       pick_sha, created_at)
     VALUES ('AU', ?, 'aggressive', ?, ?, 'F1', 'U1', 'F1.v1', 'sig', 'UNVALIDATED', 10000000, 10050000,
       ?, 9200000, 11000000, 50, -60000, 20000, 110000, 10, 1000000000, 100000000, '[]', '[]', ?,
       ?)`,
    [S[0]!, rank, code, S[5]!, SHA, `${S[0]}T07:00:00.000Z`],
  );
  await run(
    `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
     VALUES ('AU', ?, 'aggressive', ?, 'pick', ?, ?, 'waiting', ?)`,
    [S[0]!, rank, code, SHA, S[0]!],
  );
}

/** A confirmed cash dividend of `code` going ex on `exD`, known from the first session (GL-02). */
async function action(code: string, exD: string, dps: string) {
  const res = await run(
    `INSERT INTO corporate_action (market, code, type, ex_date, record_date, payload_json, evidence_json, known_at)
     VALUES ('AU', ?, 'cash_dividend', ?, NULL, ?, NULL, ?)`,
    [code, exD, JSON.stringify({ dps, pay_date: "2030-01-31" }), `${S[0]}T00:00:00.000Z`],
  );
  await db.execute({
    sql: `INSERT INTO corporate_action_event (action_id, at, status, by, note)
          VALUES (?, ?, 'auto_confirmed', 'synthetic', NULL)`,
    args: [res.lastInsertRowid as never, `${S[0]}T00:00:00.000Z`],
  });
}

beforeAll(async () => {
  db = await freshDb("main");
  await setConfig(db, {
    key: "c1_etf_code",
    value: "ZZETF",
    userId: null,
    now: "2030-01-01T00:00:00.000Z",
  });
  const closes = [100, 100, 102, 102, 104, 104];
  for (const [i, d] of S.entries()) {
    const c = closes[i]! * 1_000_000;
    await run(
      `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
       VALUES ('AU','AXJO',?,?,?,?,?,'yahoo_index',?,?)`,
      [d, c, c, c, c, `${d}T07:00:00.000Z`, `${d}T07:00:00.000Z`],
    );
    await bar("ZZETF", d, 50, 50, 50, 50);
  }
  // A: bought S1 open 10.0, gaps to 8.5 on S2 (stop 9.2)
  await bar("ZZA", S[0]!, 10, 10.1, 9.9, 10);
  await bar("ZZA", S[1]!, 10, 10.2, 9.9, 10.1);
  for (const i of [2, 3, 4, 5]) await bar("ZZA", S[i]!, 8.5, 8.6, 8.4, 8.5);
  // B: bought S1, quiet S2..S3, aim 11.0 reached on S4
  await bar("ZZB", S[0]!, 10, 10.1, 9.9, 10);
  for (const i of [1, 2, 3]) await bar("ZZB", S[i]!, 10, 10.2, 9.9, 10);
  await bar("ZZB", S[4]!, 10.5, 11.2, 10.4, 11);
  await bar("ZZB", S[5]!, 11, 11.1, 10.9, 11);
  // C: open above the buy zone every session
  await bar("ZZC", S[0]!, 10, 10.1, 9.9, 10);
  for (const i of [1, 2, 3, 4, 5]) await bar("ZZC", S[i]!, 11, 11.1, 10.9, 11);
  await pick(1, "ZZA");
  await pick(2, "ZZB");
  await pick(3, "ZZC");
  // (c) ARN-123: ZZB pays A$0.50 going ex on S3 while held (bought S1, exit S4); ZZD is a row settled
  // BEFORE the deploy (price only) with a dividend inside its old window.
  await action("ZZB", S[3]!, "0.50");
  await pick(4, "ZZD");
  await action("ZZD", S[2]!, "0.50");
  await run(
    `UPDATE pick_outcome SET state = 'bought', entry_d = ?, entry_micro = 10000000, updated_d = ?
     WHERE rank = 4`,
    [S[1]!, S[1]!],
  );
  await run(
    `UPDATE pick_outcome SET state = 'closed', exit_d = ?, exit_micro = 11000000, exit_reason = 'aim',
       net_micro = 95000000, net_ppm = 95000, updated_d = ? WHERE rank = 4`,
    [S[2]!, S[2]!],
  );
  await run(
    `INSERT INTO pick_check (market, d, profile, rank, night_d, valid, reason, checked_at)
     VALUES ('AU', ?, 'aggressive', 3, ?, 0, 'regime', ?)`,
    [S[0]!, S[3]!, `${S[3]}T08:00:00.000Z`],
  );
  const rows = parseVendorActionsText(
    JSON.stringify(
      [
        ["2029-12-15", "2030-01-01"],
        [S[3]!, S[4]!],
      ].map(([ex, fetched]) => ({
        code: "ZZETF",
        ex_date: ex,
        kind: "dividend",
        amount: 0.5,
        currency: "AUD",
        source: "yahoo",
        fetched_at: `${fetched}T07:30:00.000Z`,
      })),
    ),
  ).rows;
  await writeVendorActions(db, { rows });
  await trackPicks(db, { market: "AU", d: S[5]!, advWindow: 5 });
});

const mkt = async (rank: number) =>
  (await run("SELECT * FROM pick_market WHERE profile = 'aggressive' AND rank = ?", [rank]))
    .rows[0]!;

describe("AT-35 picks vs market", () => {
  it("gap-stop exit: market +2.00 %, vs market = net minus market", async () => {
    const m = await mkt(1);
    const o = (await run("SELECT * FROM pick_outcome WHERE rank = 1")).rows[0]!;
    expect(o.exit_reason).toBe("gap");
    expect(m).toMatchObject({
      window_from_d: S[1],
      window_to_d: S[2],
      missed: 0,
      basis: "total_return",
    });
    expect(Math.abs(Number(m.market_ret_ppm) - 20_000)).toBeLessThanOrEqual(TOL);
    expect(Number(m.pick_net_ppm)).toBe(Number(o.net_ppm));
    expect(Number(m.vs_market_ppm)).toBe(Number(o.net_ppm) - Number(m.market_ret_ppm));
  });

  it("in-window dividend: the ex-date lifts the market to +5.04 % (price only would be +4.00 %)", async () => {
    const m = await mkt(2);
    const o = (await run("SELECT * FROM pick_outcome WHERE rank = 2")).rows[0]!;
    expect(o.exit_reason).toBe("aim");
    expect(m).toMatchObject({
      window_from_d: S[1],
      window_to_d: S[4],
      index_from_micro: 100_000_000,
    });
    expect(Math.abs(Number(m.index_to_micro) - 105_040_000)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(m.market_ret_ppm) - 50_400)).toBeLessThanOrEqual(TOL);
    expect(Number(m.vs_market_ppm)).toBe(Number(o.net_ppm) - Number(m.market_ret_ppm));
  });

  it("missed pick: would-be window to the withdrawal night, market +3.02 %, no pick figure", async () => {
    const m = await mkt(3);
    expect(m).toMatchObject({
      window_from_d: S[1],
      window_to_d: S[3],
      missed: 1,
      pick_net_ppm: null,
      vs_market_ppm: null,
    });
    expect(Math.abs(Number(m.market_ret_ppm) - 30_200)).toBeLessThanOrEqual(TOL);
  });

  it("states the basis, and the figures cannot be edited or deleted", async () => {
    expect((await mkt(2)).basis).toBe("total_return");
    expect(benchmarkLabel("total_return")).toBe(TOTAL_RETURN_BASIS_LABEL);
    await expect(run("UPDATE pick_market SET market_ret_ppm = 0")).rejects.toThrow(/append-only/);
    await expect(run("DELETE FROM pick_market")).rejects.toThrow(/append-only/);
  });

  // AT-35 (c), ARN-123 / D-956: the pick side credits the in-window dividend; a row settled before the
  // deploy stays price only and is not rewritten.
  it("(c) the pick side credits the in-window dividend: net = sale - fees - cost + 100 x A$0.50", async () => {
    const o = (await run("SELECT * FROM pick_outcome WHERE rank = 2")).rows[0]!;
    expect(o.exit_reason).toBe("aim");
    expect(o.outcome_basis).toBe("total_return");
    const qty = 100n; // A$1,000 at A$10.00
    const entry = BigInt(String(o.entry_micro));
    const exit = BigInt(String(o.exit_micro));
    const profile = getCostProfile("P5");
    const cost = qty * entry + feeFor(profile, qty * entry, "buy");
    const sale = qty * exit;
    const withDividend = sale - feeFor(profile, sale, "sell") - cost + 50_000_000n; // 100 x 0.50
    expect(BigInt(String(o.net_micro))).toBe(withDividend);
    expect(Number(o.net_ppm)).toBe(Number((withDividend * 1_000_000n + cost / 2n) / cost));
    // a zero-dividend pick of the same run is total return too, with nothing added
    const a = (await run("SELECT * FROM pick_outcome WHERE rank = 1")).rows[0]!;
    expect(a.outcome_basis).toBe("total_return");
    const aEntry = BigInt(String(a.entry_micro));
    const aCost = 100n * aEntry + feeFor(profile, 100n * aEntry, "buy");
    const aSale = 100n * BigInt(String(a.exit_micro));
    expect(BigInt(String(a.net_micro))).toBe(aSale - feeFor(profile, aSale, "sell") - aCost);
  });

  it("(c) a settled price_only row is unchanged by the deploy and cannot be switched", async () => {
    const o = (await run("SELECT * FROM pick_outcome WHERE rank = 4")).rows[0]!;
    expect(o).toMatchObject({
      state: "closed",
      net_micro: 95_000_000,
      outcome_basis: "price_only",
    });
    await expect(
      run("UPDATE pick_outcome SET outcome_basis = 'total_return' WHERE rank = 4"),
    ).rejects.toThrow(/outcome_basis is fixed/);
    await expect(run("UPDATE pick_outcome SET net_micro = 1 WHERE rank = 4")).rejects.toThrow(
      /filled once/,
    );
    await expect(
      run("UPDATE pick_outcome SET outcome_basis = 'other' WHERE rank = 1"),
    ).rejects.toThrow(/outcome_basis/);
  });

  it("a re-run writes nothing new", async () => {
    const before = (await run("SELECT COUNT(*) AS n FROM pick_market")).rows[0]!.n;
    await trackPicks(db, { market: "AU", d: S[5]!, advWindow: 5 });
    expect((await run("SELECT COUNT(*) AS n FROM pick_market")).rows[0]!.n).toBe(before);
    expect(Number(before)).toBe(3);
  });
});
