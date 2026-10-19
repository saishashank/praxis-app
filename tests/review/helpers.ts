// Synthetic database state for the Evening Review tests (M5 T9). Test support only. Everything is
// synthetic (codes ZZ*, dates in Oct 2026). The database goes through the REAL migrations; the
// cohorts are the real E01/E02 starts, the NAV rows, orders, fills, trades, alerts and runs are
// inserted directly so that each section can be tested from a known state.
import type { Client } from "@libsql/client";
import { buildExecutionRegistry, planInitialStart, resolveCohortParams } from "@/lib/arena/cohort";
import { seedExecutions, startCohorts } from "@/lib/arena/cohortWriter";
import { freshDb } from "../db/helpers";

export const MARKET = "AU";
export const D = "2026-10-19"; // Monday, a session
export const PREV = "2026-10-16"; // Friday
export const SAT = "2026-10-17"; // Saturday (non-trading)
export const START = "2026-10-14";
export const NOW = new Date("2026-10-19T09:30:00.000Z");
export const APP = "https://praxis.example.test";

export async function exec(db: Client, sql: string, args: (string | number | null)[] = []) {
  return db.execute({ sql, args });
}

export async function mainWorld(opts: { mode?: "full" | "data_only" } = {}): Promise<Client> {
  const db = await freshDb("main");
  await exec(db, "UPDATE market SET mode = ? WHERE code = ?", [opts.mode ?? "full", MARKET]);
  const registry = buildExecutionRegistry();
  await seedExecutions(db, registry);
  const starts = planInitialStart({
    registry,
    startD: START,
    paramsFor: () => resolveCohortParams({ costProfile: "P5" }),
    masterSeed: 20_261_011n,
    controlsPerFamily: 1,
  }).filter((s) => ["E01", "E02"].includes(s.executionId));
  await startCohorts(db, starts);
  return db;
}

export async function cohortOf(db: Client, executionId: string): Promise<string> {
  const r = await exec(db, "SELECT id FROM cohort WHERE execution_id = ?", [executionId]);
  return String(r.rows[0]!.id);
}

export async function addNav(
  db: Client,
  cohortId: string,
  d: string,
  navMicro: bigint,
  extra: { positions?: bigint; sleeveUnreal?: bigint } = {},
): Promise<void> {
  const positions = extra.positions ?? 0n;
  await exec(
    db,
    `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
       div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
       liq_nav_micro, open_positions, invariants_ok)
     VALUES (?, ?, ?, 0, 0, ?, 0, 0, ?, 0, ?, ?, ?, 1)`,
    [
      cohortId,
      d,
      Number(navMicro - positions),
      Number(positions),
      Number(extra.sleeveUnreal ?? 0n),
      Number(navMicro),
      Number(navMicro),
      positions > 0n ? 1 : 0,
    ],
  );
}

export async function addRun(
  db: Client,
  key: string,
  status = "success",
  job = "arena-x",
): Promise<void> {
  await exec(
    db,
    `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [job, MARKET, key, D, "2026-10-19T08:00:00.000Z", "2026-10-19T08:05:00.000Z", status],
  );
}

export async function addMarker(db: Client, d: string, kind: "data" | "non-trading" = "data") {
  await exec(
    db,
    "INSERT INTO completion_marker (market, d, kind, at, run_id, outcome) VALUES (?, ?, ?, ?, NULL, 'ok')",
    [MARKET, d, kind, `${d}T08:50:00.000Z`],
  );
}

/** The nightly state of a normal trading day D: runs 2a/2b/3, marker, NAV rows for D-1 and D. */
export async function tradingDay(db: Client): Promise<{ e01: string; e02: string }> {
  const e01 = await cohortOf(db, "E01");
  const e02 = await cohortOf(db, "E02");
  await addNav(db, e01, PREV, 601_000_000n);
  await addNav(db, e01, D, 604_500_000n, { positions: 100_000_000n });
  await addNav(db, e02, PREV, 600_000_000n);
  await addNav(db, e02, D, 597_000_000n);
  await addMarker(db, D);
  await addRun(db, `arena-2a:${MARKET}:${D}`, "success", "arena-close");
  await addRun(db, `arena-2b:${MARKET}:${D}`, "success", "arena-signals");
  await addRun(db, `arena-3:${MARKET}:${D}`, "success", "arena-review");
  return { e01, e02 };
}

let n = 0;
const sha = (): string => (++n).toString(16).padStart(64, "0");

export const CARD_ID = `card:sig:${D}:ZZUP:E01`;

export async function addCard(db: Client, cohortId: string): Promise<string> {
  await exec(
    db,
    `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
       evidence_json, schema_version, agent_version, inputs_ref, decided_at)
     VALUES (?, ?, ?, 'F1', 'F1.v1', 'F1', 'ZZUP', 'NEUTRAL', '1', '[]', '{}', 1, 'a1', 'x', ?)`,
    [`sig:${D}:ZZUP`, MARKET, D, `${D}T08:00:00.000Z`],
  );
  const card = {
    v: 1,
    market: MARKET,
    d: D,
    code: "ZZUP",
    family: "F1",
    execution: "E01",
    rule_version: "F1.v1",
    variant: "F1",
    regime: "NEUTRAL",
    taken: true,
    not_taken_reason: null,
    thesis: "Guidance upgrade with a rising trend.",
    rules_fired: [{ rule: "R1", value: "3.2", threshold: "2", pass: true }],
    rank_score: "1",
    evidence: {
      events: [],
      insider_flow: "unknown",
      short_interest: "unknown",
      data_quality_flags: [],
      other_flags: [],
    },
    thesis_breakers: [{ id: "TB-NEG", check: "Negative announcement" }],
    exit_plan: [{ rule: "stop", tag: "IS", via: null, kind: "stop", detail: {} }],
    sizing: {
      available: true,
      accepted: true,
      reasons: [],
      qty: "100",
      fill_price_micro: "1500000",
      order_value_micro: "150000000",
      half_size: false,
    },
    cost: {
      available: true,
      reason: null,
      entry_brokerage_micro: "9500000",
      entry_slippage_micro: "0",
      exit_brokerage_micro: "9500000",
      exit_slippage_micro: "0",
      cost_estimate_micro: "19000000",
      order_value_micro: "150000000",
      break_even_ppm: 126000,
    },
    scenario: {
      insufficient_history: true,
      n: 3,
      reason: "n < 30",
      p10_ppm: null,
      p50_ppm: null,
      p90_ppm: null,
      split_version: null,
      as_of_roll_d: null,
      variant: "F1",
      rule_version: "F1.v1",
    },
    footnote: "Simulation only.",
  };
  await exec(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status, card_id, signal_id)
     VALUES ('o-card', ?, ?, 'ZZUP', 'buy', 'entry', 100, 'pending', ?, ?)`,
    [cohortId, D, CARD_ID, `sig:${D}:ZZUP`],
  );
  await exec(
    db,
    `INSERT INTO decision_card (id, signal_id, execution_id, cohort_id, taken, order_id, card_json, card_sha,
       schema_version, decided_at) VALUES (?, ?, 'E01', ?, 1, 'o-card', ?, ?, 1, ?)`,
    [CARD_ID, `sig:${D}:ZZUP`, cohortId, JSON.stringify(card), sha(), `${D}T08:00:00.000Z`],
  );
  await exec(
    db,
    "INSERT INTO card_note (card_id, kind, text, provider, fallback_depth) VALUES (?, 'summary', ?, NULL, 'rules-only')",
    [CARD_ID, "ZZUP F1 note."],
  );
  return CARD_ID;
}

/** A pending order created on D for the next session (no card). */
export async function addPending(db: Client, cohortId: string, id: string, code: string) {
  await exec(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status, ref_stop_micro)
     VALUES (?, ?, ?, ?, 'buy', 'entry', 50, 'pending', 1400000)`,
    [id, cohortId, D, code],
  );
}

/** An order filled on D: pending, then the fill row, then the move to filled. */
export async function addFilled(db: Client, cohortId: string, id: string, code: string) {
  await exec(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
     VALUES (?, ?, ?, ?, 'buy', 'entry', 100, 'pending')`,
    [id, cohortId, PREV, code],
  );
  await exec(
    db,
    `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro,
       fill_price_micro, value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
     VALUES (?, ?, ?, ?, ?, 'buy', 100, 'open', 1000000, 0, 1000000, 100000000, 9500000, 'P5', 1000000, 1100000, 900000, 1050000)`,
    [`f-${id}`, id, cohortId, D, code],
  );
  await exec(db, "UPDATE arena_order SET status = 'filled', fill_d = ? WHERE id = ?", [D, id]);
}

/** A closed winning trade (entry and exit fills) so that section 7 has figures. */
export async function addClosedTrade(db: Client, cohortId: string, tag: string, win: boolean) {
  const code = `ZZ${tag.toUpperCase()}`;
  const o1 = `ot-${tag}-1`;
  const o2 = `ot-${tag}-2`;
  await exec(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
     VALUES (?, ?, ?, '${code}', 'buy', 'entry', 100, 'pending')`,
    [o1, cohortId, `2026-10-14`],
  );
  const fill = (id: string, order: string, side: string, d: string, value: number) =>
    exec(
      db,
      `INSERT INTO fill (id, order_id, cohort_id, d, code, side, qty, rule, ref_price_micro, slip_micro,
         fill_price_micro, value_micro, brokerage_micro, cost_profile, bar_o_micro, bar_h_micro, bar_l_micro, bar_c_micro)
       VALUES (?, ?, ?, ?, '${code}', ?, 100, 'open', 1000000, 0, 1000000, ?, 10000000, 'P5', 1000000, 1100000, 900000, 1050000)`,
      [id, order, cohortId, d, side, value],
    );
  await fill(`fe-${tag}`, o1, "buy", "2026-10-15", 100_000_000);
  await exec(db, "UPDATE arena_order SET status = 'filled', fill_d = '2026-10-15' WHERE id = ?", [
    o1,
  ]);
  await exec(
    db,
    `INSERT INTO trade (id, cohort_id, code, entry_fill_id, stop_micro) VALUES (?, ?, '${code}', ?, 900000)`,
    [`t-${tag}`, cohortId, `fe-${tag}`],
  );
  await exec(
    db,
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, status)
     VALUES (?, ?, '2026-10-15', '${code}', 'sell', 'exit_cs', 100, 'pending')`,
    [o2, cohortId],
  );
  await fill(`fx-${tag}`, o2, "sell", PREV, win ? 130_000_000 : 80_000_000);
  await exec(db, "UPDATE arena_order SET status = 'filled', fill_d = ? WHERE id = ?", [PREV, o2]);
  await exec(db, "UPDATE trade SET exit_fill_id = ?, exit_type = 'CS' WHERE id = ?", [
    `fx-${tag}`,
    `t-${tag}`,
  ]);
}

export async function addAlert(
  db: Client,
  key: string,
  tier: "P0" | "P1" | "P2",
  detectedAt: string,
  facts: Record<string, unknown>,
  kind = "announcement",
  code: string | null = "ZZUP",
) {
  await exec(
    db,
    `INSERT INTO alert (alert_key, market, code, kind, tier, detected_at, published_at, facts_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [key, MARKET, code, kind, tier, detectedAt, detectedAt, JSON.stringify(facts)],
  );
}
