// The hand-built paper book of the M21 B3 tax tests (ARN-122, D-1222; AT-78). Synthetic ZZ codes and made-up prices only.
// Every amount is micro units (1_000_000 = 1.00). The expected figures in the tests are worked out by hand in comments.
import type { Client } from "@libsql/client";

export type FixtureTrade = {
  id: string;
  cohort: string;
  execution: string;
  code: string;
  buy: { d: string; qty: number; value: number; fee: number };
  sell?: { d: string; qty: number; value: number; fee: number };
  legacy?: boolean;
};

export const M = 1_000_000;

export const TRADES: FixtureTrade[] = [
  // ZZAA: two overlapping lots, the LATER lot (T2) is sold first, so specific lot differs from FIFO.
  {
    id: "T1",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZAA",
    buy: { d: "2025-08-01", qty: 100, value: 1000 * M, fee: 10 * M },
    sell: { d: "2025-11-03", qty: 100, value: 1400 * M, fee: 14 * M },
  },
  {
    id: "T2",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZAA",
    buy: { d: "2025-09-01", qty: 50, value: 600 * M, fee: 6 * M },
    sell: { d: "2025-10-01", qty: 50, value: 750 * M, fee: 7_500_000 },
  },
  // ZZSP: 10 shares, a 1:2 split on 2025-08-20 (20 shares), all 20 sold.
  {
    id: "T3",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZSP",
    buy: { d: "2025-07-10", qty: 10, value: 50 * M, fee: 0 },
    sell: { d: "2025-09-15", qty: 20, value: 60 * M, fee: 0 },
  },
  // ZZFY: two lots bought a day apart, sold either side of the 30 June / 1 July year boundary.
  {
    id: "T4",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZFY",
    buy: { d: "2024-01-02", qty: 5, value: 5 * M, fee: 0 },
    sell: { d: "2025-06-30", qty: 5, value: 10 * M, fee: 0 },
  },
  {
    id: "T5",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZFY",
    buy: { d: "2024-01-03", qty: 5, value: 5 * M, fee: 0 },
    sell: { d: "2025-07-01", qty: 5, value: 10 * M, fee: 0 },
  },
  // Held exactly 12 months (sold on the anniversary) and 12 months and a day.
  {
    id: "T6",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZH1",
    buy: { d: "2024-12-10", qty: 1, value: 1 * M, fee: 0 },
    sell: { d: "2025-12-10", qty: 1, value: 1_500_000, fee: 0 },
  },
  {
    id: "T7",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZH2",
    buy: { d: "2024-12-10", qty: 1, value: 1 * M, fee: 0 },
    sell: { d: "2025-12-11", qty: 1, value: 1_500_000, fee: 0 },
  },
  // A legacy close: no sale price.
  {
    id: "T8",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZLG",
    buy: { d: "2025-08-01", qty: 4, value: 4 * M, fee: 0 },
    legacy: true,
  },
  // A second strategy.
  {
    id: "T9",
    cohort: "E02@1",
    execution: "E02",
    code: "ZZE2",
    buy: { d: "2025-08-05", qty: 10, value: 20 * M, fee: 0 },
    sell: { d: "2025-09-05", qty: 10, value: 30 * M, fee: 0 },
  },
  // Still open: not realised.
  {
    id: "T10",
    cohort: "E01@1",
    execution: "E01",
    code: "ZZOP",
    buy: { d: "2025-10-10", qty: 2, value: 2 * M, fee: 0 },
  },
  // Bought 1 share at 10.00; a cash takeover at 12.00 on 2025-10-15 closes it with no sale fill (the books settle cash).
  {
    id: "T11",
    cohort: "E02@1",
    execution: "E02",
    code: "ZZTK",
    buy: { d: "2025-08-10", qty: 1, value: 10 * M, fee: 0 },
  },
];

export const TAKEOVER = {
  cohort: "E02@1",
  code: "ZZTK",
  d: "2025-10-15",
  actionId: "20",
  cash: 12 * M,
  cost: 10 * M,
};
export const LEGACY_CLOSED_D = "2025-12-20";

export const SPLIT = { cohort: "E01@1", code: "ZZSP", exD: "2025-08-20", num: 2, den: 1 };

export const DIVIDENDS = [
  // id 1: franked; id 2: franking not recorded; id 3: paid in the year before; id 4: paid then reversed
  {
    code: "ZZAA",
    pay: "2025-12-15",
    amount: 5 * M,
    payload: {
      dps: "0.05",
      pay_date: "2025-12-15",
      franking_pct: "100",
      franking_credit_micro: 2_142_857,
    },
  },
  {
    code: "ZZSP",
    pay: "2025-11-20",
    amount: 1_500_000,
    payload: { dps: "0.075", pay_date: "2025-11-20" },
  },
  {
    code: "ZZAA",
    pay: "2025-06-20",
    amount: 3 * M,
    payload: { dps: "0.03", pay_date: "2025-06-20", franking_pct: "0" },
  },
  {
    code: "ZZSP",
    pay: "2026-01-10",
    amount: 800_000,
    payload: { dps: "0.04", pay_date: "2026-01-10" },
    reversedOn: "2026-01-12",
  },
];

const PARAMS = "{}";

async function run(db: Client, sql: string, args: (string | number | null)[] = []) {
  await db.execute({ sql, args });
}

async function fill(
  db: Client,
  t: FixtureTrade,
  side: "buy" | "sell",
  leg: { d: string; qty: number; value: number; fee: number },
) {
  const oid = `o-${t.id}-${side[0]}`;
  const fid = `f-${t.id}-${side[0]}`;
  const price = Math.max(1, Math.floor(leg.value / leg.qty));
  await run(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty) VALUES (?,?,?,?,?,?,?)`,
    [oid, t.cohort, leg.d, t.code, side, side === "buy" ? "entry" : "exit_cs", leg.qty],
  );
  await run(
    db,
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro, fill_price_micro,
       value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
     VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,'P5',?,?,?,?)`,
    [
      fid,
      oid,
      t.cohort,
      leg.d,
      t.code,
      side,
      leg.qty,
      side === "buy" ? "open" : "close_signal",
      price,
      price,
      leg.value,
      leg.fee,
      price,
      price,
      price,
      price,
    ],
  );
  await run(db, "UPDATE arena_order SET status = 'filled', fill_d = ? WHERE id = ?", [leg.d, oid]);
  return fid;
}

/** Writes the fixture book into a fresh main database (market AU, two strategies). */
export async function seedBook(db: Client): Promise<void> {
  for (const [id, fam] of [
    ["E01", "F1"],
    ["E02", "F2"],
  ]) {
    await run(
      db,
      "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES (?, 'AU','E',?,'U','v1','P5')",
      [id, fam!],
    );
  }
  for (const [id, ex] of [
    ["E01@1", "E01"],
    ["E02@1", "E02"],
  ]) {
    await run(
      db,
      `INSERT INTO cohort (id, execution_id, control_idx, start_d, seed_micro, rule_version, params_json,
         cost_profile_version, rng_seed) VALUES (?,?,NULL,'2024-01-01',600000000,'v1',?,1,1)`,
      [id!, ex!, PARAMS],
    );
  }
  for (const t of TRADES) {
    // the order's decision date only has to be unique per (cohort, code, kind); the day before the fill is not needed
    const buyFill = await fill(db, { ...t, buy: { ...t.buy, d: t.buy.d } }, "buy", t.buy);
    await run(
      db,
      "INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES (?,?,?,?,1000000)",
      [t.id, t.cohort, t.code, buyFill],
    );
    if (t.sell) {
      const sellFill = await fill(db, t, "sell", t.sell);
      await run(db, "UPDATE trade SET exit_type = 'CS', exit_fill_id = ? WHERE id = ?", [
        sellFill,
        t.id,
      ]);
    } else if (t.legacy) {
      await run(db, "UPDATE trade SET exit_type = 'legacy', legacy = 1 WHERE id = ?", [t.id]);
    }
  }
  await run(
    db,
    `INSERT INTO cohort_event (cohort_id, seq, kind, d, detail_json) VALUES (?,1,'ca_adjust',?,?)`,
    [
      SPLIT.cohort,
      SPLIT.exD,
      JSON.stringify({
        action_id: "9",
        type: "split",
        code: SPLIT.code,
        ratio_num: String(SPLIT.num),
        ratio_den: String(SPLIT.den),
        qty_before: "10",
        qty_after: "20",
      }),
    ],
  );
  await run(
    db,
    `INSERT INTO cohort_event (cohort_id, seq, kind, d, detail_json) VALUES (?,1,'ca_adjust',?,?)`,
    [
      TAKEOVER.cohort,
      TAKEOVER.d,
      JSON.stringify({
        action_id: TAKEOVER.actionId,
        type: "merger_cash",
        code: TAKEOVER.code,
        ratio_num: "0",
        ratio_den: "1",
        qty_before: "1",
        qty_after: "0",
      }),
    ],
  );
  for (const [account, delta] of [
    ["position_cost", -TAKEOVER.cost],
    ["cash_settled", TAKEOVER.cash],
    ["equity", TAKEOVER.cost - TAKEOVER.cash],
  ] as const) {
    await run(
      db,
      `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind, ref_type, ref_id)
       VALUES (?,?,?,?,?,'ca_dispose','corporate_action',?)`,
      [TAKEOVER.cohort, TAKEOVER.d, `ca:${TAKEOVER.actionId}`, account, delta, TAKEOVER.actionId],
    );
  }
  // the cohort moved its legacy holding (T8) on this date
  await run(
    db,
    "UPDATE cohort SET terminal_kind = 'timeout', terminal_d = ?, ttd_sessions = 1, ttd_days = 1, outcome_micro = 1 WHERE id = 'E01@1'",
    [LEGACY_CLOSED_D],
  );
  let i = 0;
  for (const dv of DIVIDENDS) {
    i += 1;
    await run(
      db,
      "INSERT INTO corporate_action (market, code, type, ex_date, payload_json) VALUES ('AU',?,'dividend','2025-01-01',?)",
      [dv.code, JSON.stringify(dv.payload)],
    );
    await run(
      db,
      "INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind, ref_type, ref_id) VALUES ('E01@1',?,?,'div_recv',?,'div_pay','dividend',?)",
      [dv.pay, `divpay:${i}`, -dv.amount, String(i)],
    );
    await run(
      db,
      "INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind, ref_type, ref_id) VALUES ('E01@1',?,?,'cash_settled',?,'div_pay','dividend',?)",
      [dv.pay, `divpay:${i}`, dv.amount, String(i)],
    );
    if (dv.reversedOn !== undefined) {
      await run(
        db,
        "INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind, ref_type, ref_id) VALUES ('E01@1',?,?,'cash_settled',?,'reversal','txn',?)",
        [dv.reversedOn, `rev:divpay:${i}`, -dv.amount, `divpay:${i}`],
      );
    }
  }
}
