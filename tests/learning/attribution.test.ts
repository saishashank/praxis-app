// @vitest-environment node
// Attribution (M6 T3; docs/M6_design.md 2.2, decision 25; ARN-061). Exact MFE / MAE from raw highs and
// lows re-based by the arena's exact split ratios, the tags and final flags of ledger rows, arena
// trades and blocked signals, the blocked counterfactual (= the ledger path), idempotent reruns,
// determinism and look-ahead safety. Synthetic ZZ data on a real migrated libSQL file.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS } from "@/lib/config/keys";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import type { ViewBar } from "@/lib/agents/decisionView";
import {
  attributeNight,
  computeExcursion,
  putAttribution,
  type AttributionOptions,
  type AttributionRecord,
} from "@/lib/learning/attribution";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const params = buildAgentParams((k) => CONFIG_KEYS[k].default);
const M = 1_000_000n;
const SESSIONS = [
  "2030-01-07",
  "2030-01-08",
  "2030-01-09",
  "2030-01-10",
  "2030-01-11",
  "2030-01-14",
  "2030-01-15",
  "2030-01-16",
];

const bar = (d: string, o: number, h: number, l: number, c: number): ViewBar => ({
  d,
  open: BigInt(Math.round(o * 1e6)),
  high: BigInt(Math.round(h * 1e6)),
  low: BigInt(Math.round(l * 1e6)),
  close: BigInt(Math.round(c * 1e6)),
  volume: 1000n,
});

const split = (exDate: string, id = "1", n = 2, o = 1): CorpActionRecord => ({
  id,
  code: "ZZAA",
  type: "split",
  exDate,
  payload: { new: n, old: o },
});

// entry fill 10.00 on 01-08; a 2-for-1 split goes ex on 01-10; the exit session is 01-14
const BARS = new Map<string, ViewBar>(
  [
    bar("2030-01-08", 10, 10.5, 9.8, 10.2),
    bar("2030-01-09", 10.2, 11, 10, 10.8),
    bar("2030-01-10", 5.2, 5.6, 5.1, 5.4),
    bar("2030-01-11", 5.3, 5.4, 4.4, 4.6),
    bar("2030-01-14", 5.8, 5.9, 5.2, 5.5),
    bar("2030-01-15", 50, 50, 0.1, 25), // after the exit: poison for any D before it
    bar("2030-01-16", 50, 50, 0.1, 25),
  ].map((b) => [b.d, b]),
);

describe("computeExcursion: exact MFE / MAE", () => {
  const base = {
    entryFillMicro: 10n * M,
    entryD: "2030-01-08",
    sessions: SESSIONS,
    bar: (d: string) => BARS.get(d) ?? null,
  };

  it("re-bases the raw highs and lows after the split into the entry frame (mid-hold split)", () => {
    const e = computeExcursion({
      ...base,
      exitD: "2030-01-14",
      asOfD: "2030-01-16",
      actions: [split("2030-01-10")],
    })!;
    // highs in the entry frame: 10.5, 11, 11.2, 10.8, 11.8 -> MFE 18 %; lows 9.8, 10, 10.2, 8.8, 10.4 -> MAE -12 %
    expect(e.mfePpm).toBe(180_000n);
    expect(e.maePpm).toBe(-120_000n);
    expect(e.holdSessions).toBe(4);
    expect(e.lastD).toBe("2030-01-14");
    expect(e.barsUsed).toBe(5);
  });

  it("without the action the raw post-split bars would read as a crash (the re-base matters)", () => {
    const raw = computeExcursion({
      ...base,
      exitD: "2030-01-14",
      asOfD: "2030-01-16",
      actions: [],
    })!;
    expect(raw.maePpm).toBe(-560_000n);
  });

  it("an open subject runs to D; an exit after D is not seen", () => {
    const e = computeExcursion({
      ...base,
      exitD: "2030-01-14",
      asOfD: "2030-01-11",
      actions: [split("2030-01-10")],
    })!;
    expect(e).toMatchObject({
      mfePpm: 120_000n,
      maePpm: -120_000n,
      holdSessions: 3,
      lastD: "2030-01-11",
    });
  });

  it("never asks for a bar after D or after the exit", () => {
    const asked: string[] = [];
    computeExcursion({
      ...base,
      bar: (d) => {
        asked.push(d);
        return BARS.get(d) ?? null;
      },
      exitD: "2030-01-11",
      asOfD: "2030-01-16",
      actions: [],
    });
    expect(asked.every((d) => d <= "2030-01-11")).toBe(true);
  });

  it("an action before or on the entry session, or after the exit, does not re-base", () => {
    const e = computeExcursion({
      ...base,
      exitD: "2030-01-09",
      asOfD: "2030-01-16",
      actions: [split("2030-01-08", "a"), split("2030-01-10", "b")],
    })!;
    expect(e).toMatchObject({ mfePpm: 100_000n, maePpm: -20_000n });
  });

  it("two actions multiply (2-for-1 then 3-for-2)", () => {
    const px: Record<string, number> = { "2030-01-08": 1, "2030-01-09": 0.5, "2030-01-10": 0.25 };
    const e = computeExcursion({
      entryFillMicro: 1n * M,
      entryD: "2030-01-08",
      exitD: null,
      asOfD: "2030-01-10",
      sessions: SESSIONS,
      bar: (d) => (px[d] === undefined ? null : bar(d, px[d]!, px[d]!, px[d]!, px[d]!)),
      actions: [split("2030-01-09", "1", 2, 1), split("2030-01-10", "2", 3, 2)],
    })!;
    // 0.5 x 2 = 1 (0 %), 0.25 x 2 x 3/2 = 0.75 -> -25 %
    expect(e.maePpm).toBe(-250_000n);
    expect(e.mfePpm).toBe(0n);
  });

  it("rounds half away from zero in ppm", () => {
    const e = computeExcursion({
      entryFillMicro: 2_000_000n,
      entryD: "2030-01-08",
      exitD: null,
      asOfD: "2030-01-08",
      sessions: SESSIONS,
      bar: () => ({ ...bar("2030-01-08", 2, 2, 2, 2), high: 2_000_001n, low: 1_999_999n }),
      actions: [],
    })!;
    expect(e.mfePpm).toBe(1n); // 0.5 ppm -> 1
    expect(e.maePpm).toBe(-1n); // -0.5 ppm -> -1
  });

  it("is deterministic and returns null for an entry after D", () => {
    const a = computeExcursion({ ...base, exitD: null, asOfD: "2030-01-11", actions: [] });
    const b = computeExcursion({ ...base, exitD: null, asOfD: "2030-01-11", actions: [] });
    expect(a).toEqual(b);
    expect(computeExcursion({ ...base, exitD: null, asOfD: "2030-01-07", actions: [] })).toBeNull();
  });
});

// ---- the database world -----------------------------------------------------------------------------------------

type V = string | number | null;
const run = (db: Client, sql: string, args: V[] = []) => db.execute({ sql, args });
const q = async (db: Client, sql: string, args: V[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

const SIG = (d: string, code: string) => `sig:AU:${d}:F4:F4.v1:F4:${code}`;
const ROW = "lr:AU:F4:F4.v1:F4:ZZAA:2030-01-08";
const HEX = "a".repeat(64);

async function addSignal(db: Client, d: string, code: string): Promise<string> {
  const id = SIG(d, code);
  await run(
    db,
    `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
       evidence_json, classes, group_key, partial, schema_version, agent_version, inputs_ref, decided_at)
     VALUES (?, 'AU', ?, 'F4', 'F4.v1', 'F4', ?, 'RISK-ON', '1', ?, ?, NULL, 'g1', 0, 1, 'a1', 'ref', ?)`,
    [
      id,
      d,
      code,
      JSON.stringify([{ pass: true, rule: "F4.oversold", threshold: "30", value: "25" }]),
      JSON.stringify({ contributors: [], flags: [], tier: "U1" }),
      `${d}T05:00:00.000Z`,
    ],
  );
  return id;
}

async function addBars(db: Client, code: string): Promise<void> {
  for (const b of BARS.values()) {
    await run(
      db,
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES ('AU', ?, ?, ?, ?, ?, ?, 1000, 'synthetic', ?, ?)`,
      [
        code,
        b.d,
        Number(b.open) / 1e6,
        Number(b.high) / 1e6,
        Number(b.low) / 1e6,
        Number(b.close) / 1e6,
        `${b.d}T06:30:00.000Z`,
        `${b.d}T07:00:00.000Z`,
      ],
    );
  }
}

async function world(): Promise<Client> {
  const db = await freshDb("main");
  await addBars(db, "ZZAA");
  const id = await run(
    db,
    `INSERT INTO corporate_action (market, code, type, ex_date, record_date, payload_json, evidence_json)
     VALUES ('AU', 'ZZAA', 'split', '2030-01-10', NULL, '{"new":2,"old":1}', NULL)`,
  );
  await run(
    db,
    `INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (?, ?, 'auto_confirmed', 'synthetic', NULL)`,
    [Number(id.lastInsertRowid), "2030-01-10T00:00:00.000Z"],
  );
  const s1 = await addSignal(db, "2030-01-07", "ZZAA");
  await addSignal(db, "2030-01-07", "ZZBB"); // no ledger path
  await addSignal(db, "2030-01-15", "ZZCC"); // entry after D = 01-14
  // the forward ledger row: bought 60 at 10.00, sold 120 at 5.90 after the split
  await run(
    db,
    `INSERT INTO ledger_row (id, signal_id, group_key, entry_d, exit_d, exit_tag, qty, fill_in_micro, fill_out_micro,
       brok_in_micro, brok_out_micro, stress_in_micro, stress_out_micro, qty_out, dividend_micro, gross_num,
       gross_den, timed, forward) VALUES (?, ?, 'g1', '2030-01-08', NULL, NULL, 60, 10000000, NULL, 6000000, NULL,
       607000000, NULL, NULL, 0, NULL, NULL, 1, 1)`,
    [ROW, s1],
  );
  await run(
    db,
    `UPDATE ledger_row SET exit_d = '2030-01-14', exit_tag = 'CS', fill_out_micro = 5900000, brok_out_micro = 6000000,
       stress_out_micro = 700000000, qty_out = 120, dividend_micro = 0, gross_num = 109800000, gross_den = 599400000
     WHERE id = ?`,
    [ROW],
  );
  await run(
    db,
    `INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('fwd:AU', ?, 'exit_rule', '2030-01-14', ?)`,
    [`exit:${ROW}`, JSON.stringify({ flags: [], rule: "F4.cs_sma" })],
  );
  // two blocked cards of the first signal (different executions), one of the signal without a path
  const card = async (n: string, sig: string, exec: string, reason: string) =>
    run(
      db,
      `INSERT INTO decision_card (id, signal_id, execution_id, cohort_id, taken, not_taken_reason, order_id, card_json,
         card_sha, schema_version, decided_at) VALUES (?, ?, ?, NULL, 0, ?, NULL, '{}', ?, 1, '2030-01-07T05:00:00.000Z')`,
      [n, sig, exec, reason, HEX],
    );
  await card("card:1:E01", s1, "E01", "positions_full");
  await card("card:1:E02", s1, "E02", "rank");
  await card("card:2:E01", SIG("2030-01-07", "ZZBB"), "E01", "rank");
  await card("card:3:E01", SIG("2030-01-15", "ZZCC"), "E01", "gate");
  // an arena trade of the same position
  await run(
    db,
    `INSERT INTO execution (id, market, kind, family, variant, twin_group, rule_version, cost_profile)
     VALUES ('E01', 'AU', 'E', 'F4', 'U', 'T1', 'F4.v1', 'P5')`,
  );
  await run(
    db,
    `INSERT INTO cohort (id, execution_id, start_d, seed_micro, rule_version, params_json, cost_profile_version, rng_seed, live)
     VALUES ('K1', 'E01', '2030-01-07', 600000000, 'F4.v1', '{}', 1, 42, 1)`,
  );
  await run(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status, tier, signal_id)
     VALUES ('O1', 'K1', '2030-01-07', 'ZZAA', 'buy', 'entry', 60, 'pending', 'U1', ?)`,
    [s1],
  );
  await run(
    db,
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro, fill_price_micro,
       value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
     VALUES ('F1', 'O1', 'K1', '2030-01-08', 'ZZAA', 'buy', 60, 'open', 9990000, 10000, 10000000, 600000000, 6000000,
       'P5', 10000000, 10500000, 9800000, 10200000)`,
  );
  await run(db, "UPDATE arena_order SET status = 'filled', fill_d = '2030-01-08' WHERE id = 'O1'");
  await run(
    db,
    "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES ('T1', 'K1', 'ZZAA', 'F1', 9000000)",
  );
  await run(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status, tier)
     VALUES ('O2', 'K1', '2030-01-11', 'ZZAA', 'sell', 'exit_cs', 120, 'pending', 'U1')`,
  );
  await run(
    db,
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro, fill_price_micro,
       value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
     VALUES ('F2', 'O2', 'K1', '2030-01-14', 'ZZAA', 'sell', 120, 'close_signal', 5910000, 10000, 5900000, 708000000,
       6000000, 'P5', 5800000, 5900000, 5200000, 5500000)`,
  );
  await run(db, "UPDATE arena_order SET status = 'filled', fill_d = '2030-01-14' WHERE id = 'O2'");
  await run(db, "UPDATE trade SET exit_fill_id = 'F2', exit_type = 'CS' WHERE id = 'T1'");
  return db;
}

const opts = (d: string): AttributionOptions => ({
  market: "AU",
  d,
  calendar: [],
  params,
  replay: true,
});

async function addControls(db: Client): Promise<void> {
  for (const [idx, num] of [
    [1, 30_000_000],
    [2, 90_000_000],
  ] as const) {
    await run(
      db,
      `INSERT INTO ledger_control (row_id, idx, code, entry_d, exit_d, net_num, net_den, stress_num, stress_den)
       VALUES (?, ?, 'ZZXX', '2030-01-08', '2030-01-14', ?, 600000000, ?, 600000000)`,
      [ROW, idx, num, num],
    );
  }
}

const attrs = (db: Client) =>
  q(db, "SELECT * FROM attribution ORDER BY subject_kind, subject_id, version");

describe("attributeNight", () => {
  it("a closed ledger row and trade: exact MFE/MAE across the split, amounts, tags, final once controls exist", async () => {
    const db = await world();
    await addControls(db);
    const r = await attributeNight(db, opts("2030-01-14"));
    expect(r.ledgerRows).toMatchObject({ inserted: 1, final: 1 });
    expect(r.trades).toMatchObject({ inserted: 1, final: 1 });
    const [lr] = await q(db, "SELECT * FROM attribution WHERE subject_kind = 'ledger_row'");
    expect(lr).toMatchObject({
      subject_id: ROW,
      version: 1,
      final: 1,
      d: "2030-01-14",
      mfe_ppm: 180_000,
      mae_ppm: -120_000,
      hold_sessions: 4,
      cost_micro: 12_000_000,
      slippage_micro: 1_800_000,
      net_micro: 96_000_000,
      excess_ppm: 58_416, // 96/606 - mean(0.05, 0.15)
      stress_ppm: 153_213, // 93/607
    });
    const tags = JSON.parse(String(lr!.tags_json));
    expect(tags).toMatchObject({
      family: "F4",
      variant: "F4",
      rule_version: "F4.v1",
      tier: "U1",
      regime: "RISK-ON",
      kind: "ledger_row",
      exit: { d: "2030-01-14", reason: "CS:F4.cs_sma", tag: "CS" },
      events: { group_key: "g1" },
    });
    expect(tags.filters).toEqual([
      { pass: true, rule: "F4.oversold", threshold: "30", value: "25" },
    ]);
    const [tr] = await q(db, "SELECT * FROM attribution WHERE subject_kind = 'trade'");
    expect(tr).toMatchObject({
      subject_id: "T1",
      final: 1,
      mfe_ppm: 180_000,
      mae_ppm: -120_000,
      hold_sessions: 4,
      cost_micro: 12_000_000,
      slippage_micro: 1_800_000,
      net_micro: 96_000_000,
      excess_ppm: null,
      stress_ppm: null,
    });
    expect(JSON.parse(String(tr!.tags_json))).toMatchObject({
      execution: { id: "E01", kind: "E" },
      exit: { reason: "CS", tag: "CS" },
      family: "F4",
      regime: "RISK-ON",
    });
  });

  it("a closed ledger row waits (not final, excess NULL) until its controls are written, then is final once", async () => {
    const db = await world();
    await attributeNight(db, opts("2030-01-14"));
    let rows = await q(db, "SELECT * FROM attribution WHERE subject_kind = 'ledger_row'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ final: 0, excess_ppm: null, mfe_ppm: 180_000 });
    await addControls(db);
    await attributeNight(db, opts("2030-01-15"));
    rows = await q(
      db,
      "SELECT * FROM attribution WHERE subject_kind = 'ledger_row' ORDER BY version",
    );
    expect(rows.map((r) => [r.version, r.final, r.excess_ppm, r.d])).toEqual([
      [1, 0, null, "2030-01-14"],
      [2, 1, 58_416, "2030-01-15"],
    ]);
    // nothing after a final row
    const again = await attributeNight(db, opts("2030-01-16"));
    expect(again.ledgerRows.inserted).toBe(0);
    expect(
      await q(db, "SELECT COUNT(*) AS n FROM attribution WHERE subject_kind = 'ledger_row'"),
    ).toEqual([{ n: 2 }]);
  });

  it("a final row 'no controls' marker also finishes the row (excess stays NULL)", async () => {
    const db = await world();
    await run(
      db,
      `INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES ('fwd:AU', ?, 'controls_none', '2030-01-14', '{}')`,
      [`ctl:${ROW}`],
    );
    await attributeNight(db, opts("2030-01-14"));
    const [lr] = await q(db, "SELECT * FROM attribution WHERE subject_kind = 'ledger_row'");
    expect(lr).toMatchObject({ final: 1, excess_ppm: null });
  });

  it("an open subject gets a new version only when its figures moved", async () => {
    const db = await world();
    await attributeNight(db, opts("2030-01-10"));
    await attributeNight(db, opts("2030-01-10")); // same state: nothing
    await attributeNight(db, opts("2030-01-11"));
    const rows = await q(
      db,
      "SELECT version, final, d, mfe_ppm, mae_ppm, hold_sessions, net_micro FROM attribution WHERE subject_kind = 'trade' ORDER BY version",
    );
    expect(rows).toEqual([
      {
        version: 1,
        final: 0,
        d: "2030-01-10",
        mfe_ppm: 120_000,
        mae_ppm: -20_000,
        hold_sessions: 2,
        net_micro: null,
      },
      {
        version: 2,
        final: 0,
        d: "2030-01-11",
        mfe_ppm: 120_000,
        mae_ppm: -120_000,
        hold_sessions: 3,
        net_micro: null,
      },
    ]);
  });

  it("blocked signals: the counterfactual is the ledger path of the same signal, once for each execution", async () => {
    const db = await world();
    await addControls(db);
    const r = await attributeNight(db, opts("2030-01-14"));
    expect(r.blocked.blockedTrades).toBe(3);
    const b = await q(db, "SELECT * FROM blocked_trade ORDER BY signal_id, execution_id");
    expect(
      b.map((x) => [
        x.signal_id,
        x.execution_id,
        x.reason,
        x.counterfactual_row_id,
        x.counterfactual_net_ppm,
        x.final,
      ]),
    ).toEqual([
      [SIG("2030-01-07", "ZZAA"), "E01", "positions_full", ROW, 158_416, 1], // 96/606
      [SIG("2030-01-07", "ZZAA"), "E02", "rank", ROW, 158_416, 1],
      [SIG("2030-01-07", "ZZBB"), "E01", "rank", null, null, 1], // the entry session passed, no ledger row
    ]);
    const a = await q(
      db,
      "SELECT * FROM attribution WHERE subject_kind = 'blocked' ORDER BY subject_id",
    );
    expect(a.map((x) => x.subject_id)).toEqual([
      `${SIG("2030-01-07", "ZZAA")}|E01`,
      `${SIG("2030-01-07", "ZZAA")}|E02`,
      `${SIG("2030-01-07", "ZZBB")}|E01`,
    ]);
    expect(a[0]).toMatchObject({
      final: 1,
      mfe_ppm: 180_000,
      mae_ppm: -120_000,
      net_micro: 96_000_000,
      excess_ppm: 58_416,
    });
    expect(JSON.parse(String(a[0]!.tags_json))).toMatchObject({
      blocked: { reason: "positions_full", source: "card" },
      counterfactual: { final: true, ledger_row_id: ROW, net_ppm: "158416", path: "ledger_row" },
    });
    // a blocked subject without a fill keeps the trade columns NULL (D-111)
    expect(a[2]).toMatchObject({
      final: 1,
      mfe_ppm: null,
      mae_ppm: null,
      hold_sessions: null,
      cost_micro: null,
      net_micro: null,
    });
    expect(JSON.parse(String(a[2]!.tags_json)).counterfactual).toMatchObject({
      final: true,
      path: "none",
    });
  });

  it("a blocked signal whose ledger row is still open is pending: the row id is set, the outcome NULL", async () => {
    const db = await world();
    await attributeNight(db, opts("2030-01-11")); // the exit (01-14) is after D
    const b = await q(db, "SELECT * FROM blocked_trade WHERE signal_id = ? ORDER BY execution_id", [
      SIG("2030-01-07", "ZZAA"),
    ]);
    expect(b.map((x) => [x.counterfactual_row_id, x.counterfactual_net_ppm, x.final])).toEqual([
      [ROW, null, 0],
      [ROW, null, 0],
    ]);
    await addControls(db);
    await attributeNight(db, opts("2030-01-14"));
    const c = await q(db, "SELECT * FROM blocked_trade WHERE signal_id = ? ORDER BY execution_id", [
      SIG("2030-01-07", "ZZAA"),
    ]);
    expect(c.map((x) => [x.counterfactual_net_ppm, x.final])).toEqual([
      [158_416, 1],
      [158_416, 1],
    ]);
  });

  it("a signal decided on the last session has no entry session yet: pending, not final", async () => {
    const db = await world();
    await attributeNight(db, opts("2030-01-15"));
    const [b] = await q(db, "SELECT * FROM blocked_trade WHERE signal_id = ?", [
      SIG("2030-01-15", "ZZCC"),
    ]);
    expect(b).toMatchObject({ final: 0, counterfactual_row_id: null });
    await attributeNight(db, opts("2030-01-16"));
    const [c] = await q(db, "SELECT * FROM blocked_trade WHERE signal_id = ?", [
      SIG("2030-01-15", "ZZCC"),
    ]);
    expect(c).toMatchObject({
      final: 1,
      counterfactual_row_id: null,
      counterfactual_net_ppm: null,
    });
  });

  it("a rerun on the same state writes nothing; a second world gives byte-identical rows (determinism)", async () => {
    const a = await world();
    const b = await world();
    for (const db of [a, b]) {
      await addControls(db);
      await attributeNight(db, opts("2030-01-11"));
      await attributeNight(db, opts("2030-01-14"));
    }
    const dump = async (db: Client) =>
      JSON.stringify([
        (await attrs(db)).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])),
        ),
        (await q(db, "SELECT * FROM blocked_trade ORDER BY signal_id, execution_id")).map((r) =>
          Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])),
        ),
      ]);
    const before = await dump(a);
    const again = await attributeNight(a, opts("2030-01-14"));
    expect(again.ledgerRows.inserted + again.trades.inserted + again.blocked.inserted).toBe(0);
    expect(await dump(a)).toBe(before);
    expect(await dump(b)).toBe(before);
  });

  it("is look-ahead safe: bars, exits, actions and signals after D are not read", async () => {
    const db = await world();
    // poison: a later action and a later huge bar must not move D = 01-11
    await run(
      db,
      `INSERT INTO corporate_action (market, code, type, ex_date, record_date, payload_json, evidence_json)
       VALUES ('AU', 'ZZAA', 'split', '2030-01-15', NULL, '{"new":10,"old":1}', NULL)`,
    );
    await attributeNight(db, opts("2030-01-11"));
    const lr = (await q(db, "SELECT * FROM attribution WHERE subject_kind = 'ledger_row'"))[0]!;
    // open as of D although the row closes on 01-14; the poison bars of 01-15/16 are not in it
    expect(lr).toMatchObject({
      final: 0,
      mfe_ppm: 120_000,
      mae_ppm: -120_000,
      net_micro: null,
      d: "2030-01-11",
    });
    const tr = (await q(db, "SELECT * FROM attribution WHERE subject_kind = 'trade'"))[0]!;
    expect(tr).toMatchObject({ final: 0, net_micro: null, mfe_ppm: 120_000 });
    // no blocked subject for the signal decided after D
    const b = await q(db, "SELECT signal_id FROM blocked_trade WHERE market = 'AU'");
    expect(b.map((x) => x.signal_id)).not.toContain(SIG("2030-01-15", "ZZCC"));
    // the decision view of D refuses a later date outright
    await expect(
      import("@/lib/agents/decisionView").then(({ createDecisionView }) =>
        createDecisionView(db, {
          market: "AU",
          d: "2030-01-11",
          cutoff: "2030-01-11T23:00:00.000Z",
        }).bars("ZZAA", 3, "2030-01-14"),
      ),
    ).rejects.toThrow();
  });

  it("a final attribution is never rewritten: a contradicting recomputation raises", async () => {
    const db = await world();
    await addControls(db);
    await attributeNight(db, opts("2030-01-14"));
    const rec: AttributionRecord = {
      kind: "ledger_row",
      id: ROW,
      market: "AU",
      d: "2030-01-16",
      final: true,
      tags: {},
      mfePpm: 1n,
      maePpm: 0n,
      holdSessions: 1,
      costMicro: 0n,
      slippageMicro: 0n,
      netMicro: null,
      excessPpm: null,
      stressPpm: null,
    };
    await expect(putAttribution(db, rec)).rejects.toThrow(/final row differs/);
  });
});
