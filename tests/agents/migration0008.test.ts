// @vitest-environment node
// Main DB migration 0008_agents (M4 T1, docs/M4_design.md section 3, D-078). HIGH-RISK (money trail
// and validation evidence): up/down/up, every append-only / one-way / prune-only trigger refuses the
// forbidden write, the allowed transitions pass, CHECK constraints, integer-only money, the four
// new arena_order columns, backup round trip. All values are synthetic.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { dumpDatabase, restoreDatabase } from "../../scripts/backup/core.mjs";
import {
  AGENT_APPEND_ONLY_TABLES,
  AGENT_COLUMNS,
  AGENT_FOREVER_TABLES,
  AGENT_MONEY_COLUMNS,
  AGENT_ONE_WAY_TABLES,
  AGENT_PRUNED_TABLES,
  AGENT_REAL_COLUMNS,
  AGENT_TABLES,
} from "@/lib/agents/schema";
import { ARENA_COLUMNS } from "@/lib/arena/schema";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";
import { createClient } from "@libsql/client";

afterEach(cleanupTempDbs);

type V = string | number | null;
const q = async (db: Client, sql: string, args: V[] = []) =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const run = (db: Client, sql: string, args: V[] = []) => db.execute({ sql, args });
const ins = (db: Client, table: string, row: Record<string, V>) =>
  run(
    db,
    `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(", ")})`,
    Object.values(row),
  );

const TODAY = new Date().toISOString().slice(0, 10);
const OLD = "2020-01-01";
const AT = "2026-10-12T08:10:00.000Z";
const HEX64 = "a".repeat(64);

// One valid row per table (primary keys that a second row can vary). Pruned tables use today's date.
const ROW: Record<string, Record<string, V>> = {
  index_bar: {
    market: "AU",
    index_code: "AXJO",
    d: "2026-10-12",
    o_micro: 8_000_000_000,
    h_micro: 8_100_000_000,
    l_micro: 7_900_000_000,
    c_micro: 8_050_000_000,
    source: "yahoo",
    published_at: AT,
    ingested_at: AT,
  },
  short_interest: {
    market: "AU",
    code: "ZZAA",
    as_of: TODAY,
    short_ppm: 25_000,
    published_at: AT,
    ingested_at: AT,
    assumed_time: 0,
    source: "asic",
  },
  insider_notice: {
    market: "AU",
    ann_id: "N1",
    code: "ZZAA",
    kind: "director_buy",
    value_micro: 5_000_000,
    published_at: AT,
    parser_version: "p1",
  },
  indicator_daily: {
    market: "AU",
    code: "ZZAA",
    d: TODAY,
    ind_version: 1,
    close_adj_micro: 10_000_000,
    sma5_micro: 9_900_000,
    sma50_micro: 9_500_000,
    sma200_micro: 9_000_000,
    atr20_micro: 400_000,
    rsi2: 8.5,
    rsi14: 41.25,
    ret126_ppm: 120_000,
    ret126_pct_tier: 800_000,
    high250: 1,
    vol_ratio_ppm: 1_500_000,
    adv20_micro: 200_000_000,
    range_pos_ppm: 750_000,
    vol20: 0.021,
    vol_decile: 7,
  },
  pattern_daily: {
    market: "AU",
    code: "ZZAA",
    d: TODAY,
    pattern: "hammer",
    version: 1,
    hit: 1,
  },
  regime_daily: {
    market: "AU",
    d: "2026-10-12",
    version: 1,
    close_micro: 8_050_000_000,
    sma200_micro: 7_900_000_000,
    vol20: 0.01,
    vol_pct: 42.5,
    fall5_ppm: 12_000,
    raw_state: "RISK-ON",
    state: "RISK-ON",
    exit_streak: 0,
  },
  event: {
    market: "AU",
    source: "asx",
    ann_id: "A1",
    code: "ZZAA",
    published_at: AT,
    timed: 1,
    day0_d: "2026-10-12",
    group_key: "ZZAA:2026-10-12",
    category: "results",
    price_sensitive: 1,
    ar_ppm: 41_000,
    ar_num: "41000000000000000000",
    ar_den: "1000000000000000000000",
    vol_ratio_ppm: 2_400_000,
    polarity: 1,
    rule_version: "EVENT_RULES_V1",
    category_llm: null,
    polarity_llm: null,
  },
  insider_flow_score: {
    market: "AU",
    code: "ZZAA",
    d: TODAY,
    score_q: 2,
    inputs_json: "{}",
  },
  signal: {
    id: "sig:AU:2026-10-12:F1:rv1:F1:ZZAA",
    market: "AU",
    d: "2026-10-12",
    family: "F1",
    rule_version: "rv1",
    variant: "F1",
    code: "ZZAA",
    regime: "RISK-ON",
    rank_score: "0.93",
    rules_json: "[]",
    evidence_json: "{}",
    classes: null,
    group_key: null,
    partial: 0,
    schema_version: 1,
    agent_version: "a1",
    inputs_ref: "run1",
    decided_at: AT,
  },
  decision_card: {
    id: "card:sig:AU:2026-10-12:F1:rv1:F1:ZZAA:E01",
    signal_id: "sig:AU:2026-10-12:F1:rv1:F1:ZZAA",
    execution_id: "E01",
    cohort_id: null,
    taken: 0,
    not_taken_reason: "rank",
    order_id: null,
    card_json: "{}",
    card_sha: HEX64,
    schema_version: 1,
    decided_at: AT,
  },
  card_note: {
    card_id: "card:sig:AU:2026-10-12:F1:rv1:F1:ZZAA:E01",
    kind: "summary",
    text: "template",
    provider: null,
    model_id: null,
    fallback_depth: "rules-only",
    tokens_in: 0,
    tokens_out: 0,
    prompt_sha: null,
  },
  stop_level: {
    trade_id: "T1",
    d: "2026-10-13",
    rule: "trail",
    cohort_id: "K1",
    level_micro: 950_000,
  },
  c2_selection: {
    cohort_id: "K1",
    d: "2026-10-12",
    matched_signal_id: "sig:AU:2026-10-12:F1:rv1:F1:ZZAA",
    code: "ZZBB",
    skipped: 0,
    skip_reason: null,
    pool_size: 12,
    rng_draw: 123456789,
  },
  lineage: { id: "AU:F1", created_d: "2026-10-12", parent: null },
  lineage_split: {
    lineage_id: "AU:F1",
    version: 1,
    block_sessions: 12,
    holdout_len: 378,
    validation_len: 504,
    purge: 140,
    data_end_d: "2026-10-09",
    holdout_start_d: "2025-03-01",
    holdout_end_d: "2026-09-01",
    validation_start_d: "2023-03-01",
    validation_end_d: "2025-02-01",
    dev_end_d: "2022-09-01",
    deferred_until_d: null,
    reason: "create",
    measured_on_run: "run1",
  },
  trial_ledger: {
    id: "tr1",
    market: "AU",
    lineage_id: "AU:F1",
    split_version: 1,
    kind: "validation_access",
    rule_version: "rv1",
    variant: "F1",
    run_id: "run1",
    d: "2026-10-12",
  },
  ledger_row: {
    id: "lr:AU:F1:rv1:F1:ZZAA:2026-10-13",
    signal_id: "sig:AU:2026-10-12:F1:rv1:F1:ZZAA",
    group_key: null,
    entry_d: "2026-10-13",
    exit_d: null,
    exit_tag: null,
    qty: 60,
    fill_in_micro: 10_000_000,
    fill_out_micro: null,
    brok_in_micro: 5_000_000,
    brok_out_micro: null,
    stress_in_micro: 10_050_000,
    stress_out_micro: null,
    qty_out: null,
    dividend_micro: 0,
    gross_num: null,
    gross_den: null,
    timed: 1,
    forward: 1,
  },
  ledger_control: {
    row_id: "lr:AU:F1:rv1:F1:ZZAA:2026-10-13",
    idx: 1,
    code: "ZZBB",
    entry_d: "2026-10-13",
    exit_d: "2026-10-20",
    net_num: 3,
    net_den: 100,
    stress_num: 1,
    stress_den: 100,
  },
  replay_run: {
    id: "run1",
    kind: "light",
    market: "AU",
    snapshot_sha: HEX64,
    commit_sha: "c".repeat(40),
    params_sha: HEX64,
    seed: 42,
    node_version: "v24.0.0",
    files_json: "[]",
    minutes: 12.5,
  },
  validation_result: {
    id: "vr1",
    run_id: "run1",
    lineage_id: "AU:F1",
    rule_version: "rv1",
    variant: "F1",
    split_version: 1,
    test: "i",
    level: 0.000417,
    B: 48000,
    n: 120,
    blocks: 16,
    stat: 2.1,
    p: 0.02,
    mde: 0.01,
    lower: -0.01,
    upper: 0.03,
    L_used: 6,
    m_used: 20,
    outcome: "not significant",
    reachable_d: null,
  },
  label: {
    id: "lb1",
    execution_id: "E01",
    rule_version: "rv1",
    variant: "F1",
    label: "UNVALIDATED",
    qualifiers_json: "[]",
    cost_infeasible: 0,
    n: 12,
    mde: null,
    d: "2026-10-12",
    result_ids: "[]",
  },
  replay_stat: {
    run_id: "run1",
    scope: "AU:F1",
    metric: "scenario",
    d: TODAY,
    value_json: "{}",
  },
  killswitch_look: {
    lineage_id: "AU:F1",
    rule_version: "rv1",
    criterion: "expectancy",
    look_k: 1,
    d: "2026-10-12",
    trades: 20,
    stat: -1.2,
    p: 0.4,
    alpha_k: 0.00833,
    triggered: 0,
  },
  llm_cache: {
    role: "R2",
    model_id: "m1",
    prompt_sha: HEX64,
    kb_version: "kb1",
    response_json: "{}",
    expires_at: "2999-01-01T00:00:00.000Z",
  },
  llm_call: {
    id: "call1",
    role: "R2",
    provider: "rules-only",
    model_id: null,
    fallback_depth: "rules-only",
    tokens_in: 0,
    tokens_out: 0,
    cached: 0,
    outcome: "ok",
    injection_filtered: 0,
    market: "AU",
    d: TODAY,
  },
};

/** Arena rows a stop_level needs (execution, cohort, order, fill, open trade). */
async function seedTrade(db: Client) {
  await ins(db, "execution", {
    id: "E01",
    market: "AU",
    kind: "E",
    family: "F1",
    variant: "U",
    rule_version: "rv1",
    cost_profile: "P5",
  });
  await ins(db, "cohort", {
    id: "K1",
    execution_id: "E01",
    start_d: "2026-10-12",
    seed_micro: 600_000_000,
    rule_version: "rv1",
    params_json: "{}",
    cost_profile_version: 1,
    rng_seed: 42,
  });
  await ins(db, "arena_order", {
    id: "O1",
    cohort_id: "K1",
    decided_d: "2026-10-12",
    code: "ZZAA",
    side: "buy",
    kind: "entry",
    qty: 10,
  });
  await ins(db, "fill", {
    id: "F1",
    order_id: "O1",
    cohort_id: "K1",
    d: "2026-10-13",
    code: "ZZAA",
    side: "buy",
    qty: 10,
    rule: "open",
    ref_price_micro: 1_000_000,
    slip_micro: 5000,
    fill_price_micro: 1_005_000,
    value_micro: 10_050_000,
    brokerage_micro: 30_000_000,
    cost_profile: "P5",
    bar_o_micro: 1_000_000,
    bar_h_micro: 1_100_000,
    bar_l_micro: 900_000,
    bar_c_micro: 1_050_000,
  });
  await ins(db, "trade", {
    id: "T1",
    cohort_id: "K1",
    code: "ZZAA",
    entry_fill_id: "F1",
    stop_micro: 900_000,
  });
}

// Insert order respects the cross-check guards.
const SEED_ORDER = [
  "index_bar",
  "short_interest",
  "insider_notice",
  "indicator_daily",
  "pattern_daily",
  "regime_daily",
  "event",
  "insider_flow_score",
  "signal",
  "decision_card",
  "card_note",
  "stop_level",
  "c2_selection",
  "lineage",
  "lineage_split",
  "trial_ledger",
  "ledger_row",
  "ledger_control",
  "replay_run",
  "validation_result",
  "label",
  "replay_stat",
  "killswitch_look",
  "llm_cache",
  "llm_call",
] as const;

async function seeded(): Promise<Client> {
  const db = await freshDb("main");
  await seedTrade(db);
  for (const t of SEED_ORDER) await ins(db, t, ROW[t]);
  return db;
}

describe("main migration 0008_agents: shape", () => {
  it("is the eighth main migration", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[7]).toMatchObject({ version: 8, name: "agents" });
  });

  it("creates exactly the 25 tables of schema.ts with the columns in order", async () => {
    const db = await freshDb("main");
    const tables = Object.values(AGENT_TABLES);
    expect(tables).toHaveLength(25);
    expect(Object.keys(ROW).sort()).toEqual([...tables].sort());
    for (const t of tables) {
      const cols = (await q(db, `PRAGMA table_info(${t})`)).map((r) => r.name);
      expect(cols, t).toEqual([...AGENT_COLUMNS[t]]);
    }
  });

  it("every table is STRICT; columns are INTEGER or TEXT, REAL only where schema.ts lists it", async () => {
    const db = await freshDb("main");
    const real = AGENT_REAL_COLUMNS as Record<string, readonly string[]>;
    const seenReal: string[] = [];
    for (const t of Object.values(AGENT_TABLES)) {
      expect((await q(db, `SELECT strict FROM pragma_table_list('${t}')`))[0].strict, t).toBe(1);
      for (const c of await q(db, `PRAGMA table_info(${t})`)) {
        const name = String(c.name);
        if (c.type === "REAL") {
          expect(real[t] ?? [], `${t}.${name}`).toContain(name);
          seenReal.push(`${t}.${name}`);
        } else {
          expect(["INTEGER", "TEXT"], `${t}.${name}`).toContain(c.type);
        }
        // Money, rate and amount columns are never REAL.
        if (name.endsWith("_micro") || name.endsWith("_ppm")) expect(c.type).toBe("INTEGER");
      }
    }
    const listed = Object.entries(real).flatMap(([t, cs]) => cs.map((c) => `${t}.${c}`));
    expect(seenReal.sort()).toEqual(listed.sort());
  });

  it("money columns are exactly the *_micro columns, all INTEGER, and are listed in schema.ts", async () => {
    const db = await freshDb("main");
    for (const t of Object.values(AGENT_TABLES)) {
      const info = await q(db, `PRAGMA table_info(${t})`);
      const micro = info.filter((c) => String(c.name).endsWith("_micro")).map((c) => c.name);
      expect([...AGENT_MONEY_COLUMNS[t]], t).toEqual(micro);
    }
    expect(AGENT_MONEY_COLUMNS.ledger_row).toEqual([
      "fill_in_micro",
      "fill_out_micro",
      "brok_in_micro",
      "brok_out_micro",
      "stress_in_micro",
      "stress_out_micro",
      "dividend_micro",
    ]);
    expect(AGENT_MONEY_COLUMNS.stop_level).toEqual(["level_micro"]);
  });

  it("the table sets cover every table once (append-only + one-way; forever + pruned)", () => {
    const all = Object.values(AGENT_TABLES).sort();
    expect([...AGENT_APPEND_ONLY_TABLES, ...AGENT_ONE_WAY_TABLES].sort()).toEqual(all);
    expect([...AGENT_FOREVER_TABLES, ...Object.keys(AGENT_PRUNED_TABLES)].sort()).toEqual(all);
    expect(AGENT_ONE_WAY_TABLES).toEqual(["event", "ledger_row"]);
  });

  it("seeds nothing", async () => {
    const db = await freshDb("main");
    for (const t of Object.values(AGENT_TABLES)) {
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(0);
    }
  });

  it("a valid row for every table inserts, and the same insert twice is a UNIQUE error, not a replace", async () => {
    const db = await seeded();
    for (const t of Object.values(AGENT_TABLES)) {
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(1);
    }
    for (const t of SEED_ORDER) {
      await expect(ins(db, t, ROW[t]), t).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    }
    // INSERT ... ON CONFLICT DO NOTHING (the writer convention) leaves the first row alone.
    await run(
      db,
      "INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at) VALUES ('AU','AXJO','2026-10-12',1,1,1,1,'x','a','b') ON CONFLICT DO NOTHING",
    );
    expect((await q(db, "SELECT c_micro FROM index_bar"))[0].c_micro).toBe(8_050_000_000);
  });
});

describe("main migration 0008_agents: arena_order M4 columns (edited into 0007)", () => {
  it("arena_order has signal_id, card_id, max_open_micro, stop_spec after untradeable_flag", async () => {
    const db = await freshDb("main");
    // 0019 (M15) appends limit_micro after the M4 columns
    const all = (await q(db, "PRAGMA table_info(arena_order)")).map((r) => r.name);
    expect(all.at(-1)).toBe("limit_micro");
    const cols = all.slice(0, -1);
    expect(cols).toEqual([...ARENA_COLUMNS.arena_order]);
    expect(cols.slice(-4)).toEqual(["signal_id", "card_id", "max_open_micro", "stop_spec"]);
    const info = await q(db, "PRAGMA table_info(arena_order)");
    expect(info.find((c) => c.name === "max_open_micro")!.type).toBe("INTEGER");
  });

  it("the four columns are immutable on the pending -> terminal move; reason gap is accepted", async () => {
    const db = await freshDb("main");
    await seedTrade(db);
    await ins(db, "arena_order", {
      id: "O2",
      cohort_id: "K1",
      decided_d: "2026-10-12",
      code: "ZZBB",
      side: "buy",
      kind: "entry",
      qty: 5,
      signal_id: "S1",
      card_id: "C1",
      max_open_micro: 1_080_000,
      stop_spec: '{"atr_micro":1,"k":"2","cap":null,"level_micro":null}',
    });
    for (const set of [
      "signal_id = 'S2'",
      "card_id = 'C2'",
      "max_open_micro = 1",
      "stop_spec = '{}'",
      "signal_id = NULL",
    ]) {
      await expect(
        run(
          db,
          `UPDATE arena_order SET status = 'cancelled', reject_reason = 'gap', ${set} WHERE id = 'O2'`,
        ),
        set,
      ).rejects.toThrow(/other columns are immutable/);
    }
    await run(
      db,
      "UPDATE arena_order SET status = 'cancelled', reject_reason = 'gap' WHERE id = 'O2'",
    );
    expect(
      await q(db, "SELECT status, reject_reason, signal_id FROM arena_order WHERE id = 'O2'"),
    ).toEqual([{ status: "cancelled", reject_reason: "gap", signal_id: "S1" }]);
  });

  it("CHECKs: max_open_micro > 0 and stop_spec is JSON", async () => {
    const db = await freshDb("main");
    await seedTrade(db);
    const base = {
      cohort_id: "K1",
      decided_d: "2026-10-12",
      code: "ZZBB",
      side: "buy",
      kind: "entry",
      qty: 5,
    };
    await expect(ins(db, "arena_order", { id: "O3", ...base, max_open_micro: 0 })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "arena_order", { id: "O3", ...base, stop_spec: "{bad" })).rejects.toThrow(
      /CHECK/,
    );
  });
});

describe("main migration 0008_agents: up / down / up", () => {
  it("down removes every agent table, trigger and index and touches nothing else; up restores an identical schema", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    const full = await schemaOf(db);
    await migrateDown(db, ms, 16); // 0024, 0023…0020, 0019, 0018, 0017, 0016, 0015, 0014, 0013, 0012, 0011, 0010 and 0009 sit on top: take the schema as of 0008
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 7 });
    const mid = await schemaOf(db);
    for (const t of Object.values(AGENT_TABLES)) {
      expect(
        mid.some((s) => s.startsWith(`table:${t}:`)),
        t,
      ).toBe(false);
    }
    const agentNames = new Set<string>(Object.values(AGENT_TABLES));
    const nonAgent = before.filter((s) => {
      const [type, name] = s.split(":");
      if (type === "table") return !agentNames.has(name);
      return !/^(idx_(insider_notice|indicator_daily|pattern_daily|event|signal|decision_card|stop_level|trial_ledger|ledger_row|validation_result|label|llm_call)|(index_bar|short_interest|insider_notice|indicator_daily|pattern_daily|regime_daily|event|insider_flow_score|signal|decision_card|card_note|stop_level|c2_selection|lineage|lineage_split|trial_ledger|ledger_row|ledger_control|replay_run|validation_result|label|replay_stat|killswitch_look|llm_cache|llm_call)_)/.test(
        name,
      );
    });
    expect(mid).toEqual(nonAgent);
    expect(await migrateUp(db, ms)).toEqual({ applied: 17, version: 24 });
    expect(await schemaOf(db)).toEqual(full);
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 24 });
  });

  it("a fresh database and a down/up database have the same schema", async () => {
    const a = await freshDb("main");
    const b = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateDown(b, ms, 1);
    await migrateUp(b, ms);
    expect(await schemaOf(b)).toEqual(await schemaOf(a));
  });
});

// One harmless-looking UPDATE per append-only table that would change a single column.
const UPDATES: Record<string, string> = {
  index_bar: "UPDATE index_bar SET c_micro = 1",
  short_interest: "UPDATE short_interest SET short_ppm = 1",
  insider_notice: "UPDATE insider_notice SET kind = 'director_sell'",
  indicator_daily: "UPDATE indicator_daily SET rsi2 = 1",
  pattern_daily: "UPDATE pattern_daily SET hit = 0",
  regime_daily: "UPDATE regime_daily SET state = 'SHOCK'",
  insider_flow_score: "UPDATE insider_flow_score SET score_q = 0",
  signal: "UPDATE signal SET partial = 1",
  decision_card: "UPDATE decision_card SET not_taken_reason = 'cash'",
  card_note: "UPDATE card_note SET text = 'other'",
  stop_level: "UPDATE stop_level SET level_micro = 1",
  c2_selection: "UPDATE c2_selection SET pool_size = 1",
  lineage: "UPDATE lineage SET parent = 'AU:F2'",
  lineage_split: "UPDATE lineage_split SET purge = 1",
  trial_ledger: "UPDATE trial_ledger SET d = '2026-10-13'",
  ledger_control: "UPDATE ledger_control SET net_num = 9",
  replay_run: "UPDATE replay_run SET minutes = 1",
  validation_result: "UPDATE validation_result SET p = 0.5",
  label: "UPDATE label SET label = 'FAILED'",
  replay_stat: "UPDATE replay_stat SET value_json = '[]'",
  killswitch_look: "UPDATE killswitch_look SET triggered = 1",
  llm_cache: "UPDATE llm_cache SET response_json = '[]'",
  llm_call: "UPDATE llm_call SET outcome = 'x'",
};

describe("main migration 0008_agents: append-only tables refuse UPDATE", () => {
  it("covers every append-only table", () => {
    expect(Object.keys(UPDATES).sort()).toEqual([...AGENT_APPEND_ONLY_TABLES].sort());
  });

  for (const t of AGENT_APPEND_ONLY_TABLES) {
    it(`${t}: UPDATE aborts and the row is unchanged`, async () => {
      const db = await seeded();
      const before = await q(db, `SELECT * FROM ${t}`);
      await expect(run(db, UPDATES[t])).rejects.toThrow(/append-only/);
      expect(await q(db, `SELECT * FROM ${t}`)).toEqual(before);
    });
  }

  it("a primary-key change on an append-only table is also refused", async () => {
    const db = await seeded();
    await expect(run(db, "UPDATE signal SET id = 'x'")).rejects.toThrow(/append-only/);
    await expect(run(db, "UPDATE decision_card SET signal_id = 'x'")).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("main migration 0008_agents: DELETE", () => {
  const DELETABLE = Object.keys(AGENT_PRUNED_TABLES);
  const forever = Object.values(AGENT_TABLES).filter((t) => !DELETABLE.includes(t));

  for (const t of forever) {
    it(`${t}: DELETE aborts (forever / append-only), the row stays`, async () => {
      const db = await seeded();
      await expect(run(db, `DELETE FROM ${t}`)).rejects.toThrow(/append-only|forever table/);
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n).toBe(1);
    });
  }

  // For each pruned table: the same row as ROW[t] with an old key/date is deletable, today's is not.
  const OLD_ROW: Record<string, Record<string, V>> = {
    short_interest: { ...ROW.short_interest, as_of: OLD },
    indicator_daily: { ...ROW.indicator_daily, d: OLD },
    pattern_daily: { ...ROW.pattern_daily, d: OLD },
    insider_flow_score: { ...ROW.insider_flow_score, d: OLD },
    replay_stat: { ...ROW.replay_stat, d: OLD, metric: "old" },
    llm_call: { ...ROW.llm_call, id: "call0", d: "2020-01-01" },
    llm_cache: { ...ROW.llm_cache, kb_version: "kb0", expires_at: "2000-01-01T00:00:00.000Z" },
  };
  for (const t of DELETABLE) {
    it(`${t}: only rows beyond the retention floor can be deleted`, async () => {
      const db = await seeded();
      await ins(db, t, OLD_ROW[t]);
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n).toBe(2);
      await expect(run(db, `DELETE FROM ${t}`)).rejects.toThrow(/delete only/);
      const col = AGENT_PRUNED_TABLES[t as keyof typeof AGENT_PRUNED_TABLES].column;
      const oldVal = OLD_ROW[t][col];
      await run(db, `DELETE FROM ${t} WHERE ${col} = ?`, [oldVal]);
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n).toBe(1);
      expect((await q(db, `SELECT ${col} AS v FROM ${t}`))[0].v).toBe(ROW[t][col]);
    });
  }
});

describe("main migration 0008_agents: event (LLM fields NULL -> value once)", () => {
  it("category_llm and polarity_llm go NULL to a value once; every other column and any later change is refused", async () => {
    const db = await seeded();
    await run(db, "UPDATE event SET category_llm = 'guidance', polarity_llm = -1");
    expect(await q(db, "SELECT category_llm, polarity_llm FROM event")).toEqual([
      { category_llm: "guidance", polarity_llm: -1 },
    ]);
    // Same value again is allowed (idempotent rewrite), a different value is not.
    await run(db, "UPDATE event SET category_llm = 'guidance'");
    await expect(run(db, "UPDATE event SET category_llm = 'other'")).rejects.toThrow(
      /only category_llm and polarity_llm/,
    );
    await expect(run(db, "UPDATE event SET polarity_llm = 1")).rejects.toThrow(
      /only category_llm and polarity_llm/,
    );
    await expect(run(db, "UPDATE event SET category_llm = NULL")).rejects.toThrow(
      /only category_llm and polarity_llm/,
    );
  });

  it("refuses a change to any rule-derived column", async () => {
    const db = await seeded();
    for (const set of [
      "market = 'US'",
      "source = 'x'",
      "ann_id = 'A2'",
      "code = 'ZZBB'",
      "published_at = '2026-10-13T00:00:00.000Z'",
      "timed = 0",
      "day0_d = '2026-10-13'",
      "group_key = 'g'",
      "category = 'other'",
      "price_sensitive = 0",
      "ar_ppm = 1",
      "ar_num = '1'",
      "ar_den = '2'",
      "vol_ratio_ppm = 1",
      "polarity = 0",
      "rule_version = 'EVENT_RULES_V2'",
    ]) {
      await expect(run(db, `UPDATE event SET ${set}`), set).rejects.toThrow(
        /only category_llm and polarity_llm/,
      );
    }
    await expect(run(db, "DELETE FROM event")).rejects.toThrow(/forever table/);
  });

  it("CHECKs: category enum, polarity, ar pair all-or-none and decimal text, den positive", async () => {
    const db = await seeded();
    const base = { ...ROW.event, ann_id: "A9" };
    await expect(ins(db, "event", { ...base, category: "nope" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "event", { ...base, polarity: 2 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "event", { ...base, polarity_llm: 5 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "event", { ...base, ar_num: null })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "event", { ...base, ar_den: "0" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "event", { ...base, ar_den: "1e5" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "event", { ...base, ar_num: "1.5" })).rejects.toThrow(/CHECK/);
    // No day-0 bar yet: all three AR columns NULL together is fine; a negative numerator too.
    await ins(db, "event", { ...base, ar_ppm: null, ar_num: null, ar_den: null });
    await ins(db, "event", { ...base, ann_id: "A10", ar_num: "-5", ar_ppm: -3 });
  });
});

describe("main migration 0008_agents: ledger_row (one-way close)", () => {
  const CLOSE =
    "UPDATE ledger_row SET exit_d = '2026-10-20', exit_tag = 'CS', fill_out_micro = 11000000, brok_out_micro = 5000000, stress_out_micro = 10900000, qty_out = 60, dividend_micro = 12000, gross_num = 1, gross_den = 10";

  it("opens without an exit; the close sets all exit columns together, once; nothing else changes", async () => {
    const db = await seeded();
    await run(db, CLOSE);
    expect(
      await q(
        db,
        "SELECT exit_d, exit_tag, fill_out_micro, qty_out, dividend_micro, gross_num FROM ledger_row",
      ),
    ).toEqual([
      {
        exit_d: "2026-10-20",
        exit_tag: "CS",
        fill_out_micro: 11000000,
        qty_out: 60,
        dividend_micro: 12000,
        gross_num: 1,
      },
    ]);
    // A second close, a re-close with the same values, or reopening is refused.
    await expect(run(db, CLOSE)).rejects.toThrow(/one-way close/);
    await expect(run(db, "UPDATE ledger_row SET fill_out_micro = 1")).rejects.toThrow(
      /one-way close/,
    );
    await expect(run(db, "DELETE FROM ledger_row")).rejects.toThrow(/forever table/);
  });

  it("the re-based quantity belongs to the close and dividends never go negative (D-091)", async () => {
    const db = await seeded();
    expect(await q(db, "SELECT qty_out, dividend_micro FROM ledger_row")).toEqual([
      { qty_out: null, dividend_micro: 0 },
    ]);
    await expect(run(db, CLOSE.replace("qty_out = 60, ", ""))).rejects.toThrow(/CHECK/);
    await expect(run(db, CLOSE.replace("qty_out = 60", "qty_out = 0"))).rejects.toThrow(/CHECK/);
    await expect(
      run(db, CLOSE.replace("dividend_micro = 12000", "dividend_micro = -1")),
    ).rejects.toThrow(/CHECK/);
    await expect(run(db, "UPDATE ledger_row SET qty_out = 60")).rejects.toThrow(/one-way close/);
  });

  it("refuses a change to an entry column in the same update as the close", async () => {
    const db = await seeded();
    for (const set of [
      "id = 'x'",
      "signal_id = 'x'",
      "group_key = 'g'",
      "entry_d = '2026-10-12'",
      "qty = 61",
      "fill_in_micro = 1",
      "brok_in_micro = 1",
      "stress_in_micro = 1",
      "timed = 0",
      "forward = 0",
    ]) {
      await expect(run(db, `${CLOSE}, ${set}`), set).rejects.toThrow(/one-way close/);
    }
  });

  it("a partial close is refused by the CHECK (all exit columns or none)", async () => {
    const db = await seeded();
    await expect(run(db, "UPDATE ledger_row SET exit_d = '2026-10-20'")).rejects.toThrow(/CHECK/);
    await expect(
      run(db, "UPDATE ledger_row SET exit_tag = 'CS', fill_out_micro = 1"),
    ).rejects.toThrow(/CHECK|one-way/);
    // exit before entry
    await expect(run(db, CLOSE.replace("'2026-10-20'", "'2026-10-01'"))).rejects.toThrow(/CHECK/);
    await expect(run(db, CLOSE.replace("'CS'", "'XX'"))).rejects.toThrow(/CHECK/);
  });

  it("insert guard: no exit at insert, needs an existing signal; qty and prices must be positive", async () => {
    const db = await seeded();
    const row = { ...ROW.ledger_row, id: "lr2" };
    await expect(
      ins(db, "ledger_row", {
        ...row,
        exit_d: "2026-10-20",
        exit_tag: "CS",
        fill_out_micro: 1,
        brok_out_micro: 0,
        stress_out_micro: 1,
        qty_out: 60,
        gross_num: 0,
        gross_den: 1,
      }),
    ).rejects.toThrow(/opens without an exit/);
    await expect(ins(db, "ledger_row", { ...row, signal_id: "nope" })).rejects.toThrow(
      /existing signal/,
    );
    await expect(ins(db, "ledger_row", { ...row, qty: 0 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "ledger_row", { ...row, fill_in_micro: 0 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "ledger_row", { ...row, timed: 2 })).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0008_agents: cross-check guards and CHECKs", () => {
  it("decision_card needs a signal; card_note needs a card; stop_level needs a trade of the same cohort; ledger_control needs its row; lineage_split needs its lineage", async () => {
    const db = await freshDb("main");
    await seedTrade(db);
    await expect(ins(db, "decision_card", ROW.decision_card)).rejects.toThrow(/needs its signal/);
    await expect(ins(db, "card_note", ROW.card_note)).rejects.toThrow(/needs its decision card/);
    await expect(ins(db, "stop_level", { ...ROW.stop_level, trade_id: "nope" })).rejects.toThrow(
      /needs a trade of the same cohort/,
    );
    await expect(ins(db, "stop_level", { ...ROW.stop_level, cohort_id: "K2" })).rejects.toThrow(
      /needs a trade of the same cohort/,
    );
    await expect(ins(db, "ledger_control", ROW.ledger_control)).rejects.toThrow(
      /needs its ledger row/,
    );
    await expect(ins(db, "lineage_split", ROW.lineage_split)).rejects.toThrow(/needs its lineage/);
    await ins(db, "stop_level", ROW.stop_level);
  });

  it("decision_card: taken needs an order and no reason; not taken needs a reason and no order", async () => {
    const db = await freshDb("main");
    await ins(db, "signal", ROW.signal);
    const c = { ...ROW.decision_card };
    await expect(ins(db, "decision_card", { ...c, taken: 1 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "decision_card", { ...c, taken: 1, order_id: "O1" })).rejects.toThrow(
      /CHECK/,
    ); // still carries a not-taken reason
    await expect(ins(db, "decision_card", { ...c, not_taken_reason: null })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "decision_card", { ...c, order_id: "O1" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "decision_card", { ...c, card_sha: "xyz" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "decision_card", { ...c, card_json: "{bad" })).rejects.toThrow(/CHECK/);
    await ins(db, "decision_card", {
      ...c,
      id: "card2",
      execution_id: "E02",
      taken: 1,
      not_taken_reason: null,
      order_id: "O1",
    });
    // A second card for the same (signal, execution) is refused.
    await ins(db, "decision_card", c);
    await expect(ins(db, "decision_card", { ...c, id: "dup" })).rejects.toThrow(/UNIQUE/);
  });

  it("signal: family and regime enums, JSON columns, the (session, family, version, variant, code) key", async () => {
    const db = await freshDb("main");
    const s = ROW.signal;
    await expect(ins(db, "signal", { ...s, family: "F7" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "signal", { ...s, regime: "CALM" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "signal", { ...s, rules_json: "{bad" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "signal", { ...s, classes: "{bad" })).rejects.toThrow(/CHECK/);
    await ins(db, "signal", s);
    await expect(ins(db, "signal", { ...s, id: "other-id" })).rejects.toThrow(/UNIQUE/);
  });

  it("c2_selection: a skip carries a reason; a selection carries a code", async () => {
    const db = await freshDb("main");
    const c = ROW.c2_selection;
    await expect(ins(db, "c2_selection", { ...c, skipped: 1 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "c2_selection", { ...c, code: null })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "c2_selection", { ...c, skip_reason: "holding" })).rejects.toThrow(
      /CHECK/,
    );
    await ins(db, "c2_selection", { ...c, skipped: 1, skip_reason: "holding", code: null });
  });

  it("lineage_split: dates all-or-none; deferred splits carry deferred_until_d and no dates", async () => {
    const db = await freshDb("main");
    await ins(db, "lineage", ROW.lineage);
    const s = ROW.lineage_split;
    await expect(ins(db, "lineage_split", { ...s, version: 2, dev_end_d: null })).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      ins(db, "lineage_split", { ...s, version: 2, deferred_until_d: "2027-01-04" }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "lineage_split", {
      ...s,
      version: 2,
      holdout_start_d: null,
      holdout_end_d: null,
      validation_start_d: null,
      validation_end_d: null,
      dev_end_d: null,
      deferred_until_d: "2027-01-04",
    });
    await expect(ins(db, "lineage_split", { ...s, version: 3, reason: "other" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "lineage_split", { ...s, version: 0 })).rejects.toThrow(/CHECK/);
  });

  it("enums and ranges: trial kind, validation test, label, kill-switch criterion, replay kind, ppm and percentile bounds", async () => {
    const db = await seeded();
    await expect(
      ins(db, "trial_ledger", { ...ROW.trial_ledger, id: "t2", kind: "x" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "validation_result", { ...ROW.validation_result, id: "v2", test: "x" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "validation_result", { ...ROW.validation_result, id: "v2", p: 1.5 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "validation_result", { ...ROW.validation_result, id: "v2", level: 0 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "validation_result", { ...ROW.validation_result, id: "v2", L_used: 0 }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "label", { ...ROW.label, id: "l2", label: "PASSED" })).rejects.toThrow(
      /CHECK/,
    );
    await ins(db, "label", {
      ...ROW.label,
      id: "l2",
      label: "insufficient evidence",
      cost_infeasible: 1,
    });
    await expect(
      ins(db, "killswitch_look", { ...ROW.killswitch_look, look_k: 2, criterion: "x" }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "replay_run", { ...ROW.replay_run, id: "r2", kind: "x" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      ins(db, "replay_run", { ...ROW.replay_run, id: "r2", files_json: "{bad" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "short_interest", { ...ROW.short_interest, code: "ZZBB", short_ppm: 1_000_001 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "short_interest", { ...ROW.short_interest, code: "ZZBB", assumed_time: 2 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "insider_notice", { ...ROW.insider_notice, ann_id: "N2", kind: "x" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "insider_flow_score", { ...ROW.insider_flow_score, code: "ZZBB", score_q: 5 }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "insider_flow_score", { ...ROW.insider_flow_score, code: "ZZBB", score_q: null });
    await expect(
      ins(db, "indicator_daily", { ...ROW.indicator_daily, code: "ZZBB", rsi2: 101 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "indicator_daily", { ...ROW.indicator_daily, code: "ZZBB", vol_decile: 11 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "indicator_daily", {
        ...ROW.indicator_daily,
        code: "ZZBB",
        ret126_pct_tier: 1_000_001,
      }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "pattern_daily", { ...ROW.pattern_daily, code: "ZZBB", pattern: "doji" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "regime_daily", { ...ROW.regime_daily, d: "2026-10-13", state: "CALM" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "llm_call", { ...ROW.llm_call, id: "c2", fallback_depth: "x1" }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "llm_call", { ...ROW.llm_call, id: "c3", fallback_depth: "2" });
    await expect(
      ins(db, "card_note", { ...ROW.card_note, kind: "n2", fallback_depth: "-1" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "stop_level", { ...ROW.stop_level, d: "2026-10-14", level_micro: 0 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "index_bar", { ...ROW.index_bar, d: "2026-10-13", c_micro: -1 }),
    ).rejects.toThrow(/CHECK/);
  });

  it("STRICT refuses a fractional value in an INTEGER money column (never rounded silently)", async () => {
    const db = await seeded();
    await expect(
      ins(db, "stop_level", { ...ROW.stop_level, d: "2026-10-14", level_micro: 950_000.5 }),
    ).rejects.toThrow(/datatype|STRICT|INTEGER/i);
  });

  it("ledger_control CHECKs: positive denominators, exit not before entry", async () => {
    const db = await seeded();
    const c = { ...ROW.ledger_control, idx: 2 };
    await expect(ins(db, "ledger_control", { ...c, net_den: 0 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "ledger_control", { ...c, stress_den: 0 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "ledger_control", { ...c, exit_d: "2026-10-01" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "ledger_control", { ...c, idx: 0 })).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0008_agents: backup round trip", () => {
  it("dump and restore carry every agent table and its triggers", async () => {
    const source = await seeded();
    const d = await dumpDatabase(source, { name: "main", createdAt: AT });
    const target = track(createClient({ url: tempDbUrl() }));
    const r = await restoreDatabase(target, d.text);
    expect(r.sha256).toEqual(d.sha256);
    for (const t of Object.values(AGENT_TABLES)) {
      expect((await q(target, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(1);
    }
    expect(await schemaOf(target)).toEqual(await schemaOf(source));
    await expect(run(target, "UPDATE signal SET partial = 1")).rejects.toThrow(/append-only/);
    await expect(run(target, "UPDATE event SET code = 'ZZBB'")).rejects.toThrow(
      /only category_llm/,
    );
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(await migrateUp(target, ms)).toEqual({ applied: 0, version: 24 });
  });

  it("the meta line lists the forever agent tables (and not the pruned ones)", async () => {
    const source = await seeded();
    const d = await dumpDatabase(source, { name: "main", createdAt: AT });
    const meta = JSON.parse(d.text.split("\n")[0]);
    for (const t of ["signal", "decision_card", "ledger_row", "event", "stop_level"]) {
      expect(meta.forever, t).toContain(t);
    }
    for (const t of Object.keys(AGENT_PRUNED_TABLES)) expect(meta.forever, t).not.toContain(t);
  });
});
