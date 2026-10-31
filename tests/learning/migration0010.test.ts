// @vitest-environment node
// Main DB migration 0010_learning and auth 0005_annotation (M6 T1, docs/M6_design.md section 3,
// D-110, D-111). HIGH-RISK (the learning ledgers, the promotion path and the change ledger):
// up/down/up, every append-only / one-way / prune-only trigger refuses the forbidden write, the
// allowed transitions pass, CHECK constraints, backup round trip. All values are synthetic.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { dumpDatabase, FOREVER_TABLES, restoreDatabase } from "../../scripts/backup/core.mjs";
import {
  AUTH_ANNOTATION_COLUMNS,
  AUTH_ANNOTATION_TABLES,
  CHALLENGER_EDGES,
  CHALLENGER_STATES,
  LEARNING_APPEND_ONLY_TABLES,
  LEARNING_COLUMNS,
  LEARNING_FOREVER_TABLES,
  LEARNING_ONE_WAY_TABLES,
  LEARNING_PRUNED_TABLES,
  LEARNING_REAL_COLUMNS,
  LEARNING_TABLES,
} from "@/lib/learning/schema";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";

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
const set = (db: Client, table: string, assignments: string, where = "1 = 1", args: V[] = []) =>
  run(db, `UPDATE ${table} SET ${assignments} WHERE ${where}`, args);

const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const OLD_D = "2020-01-01";
const OLD_AT = "2020-01-01T00:00:00.000Z";
const AT = "2026-10-20T08:10:00.000Z";
const D = "2026-10-20";
const HEX64 = "a".repeat(64);
const HEX64B = "b".repeat(64);
const SHA40 = "c".repeat(40);

const ROW: Record<string, Record<string, V>> = {
  rule_version: {
    id: "F1.v1",
    market: "AU",
    family: "F1",
    n: 1,
    parent: null,
    origin: "seed",
    params_json: "{}",
    params_sha: HEX64,
    spec_json: "{}",
    schema_version: 1,
    registered_d: D,
    created_by: "A6",
  },
  rule_version_status: {
    rule_version_id: "F1.v1",
    seq: 1,
    status: "registered",
    d: D,
    reason: "seed",
  },
  lesson_window: {
    lineage_id: "AU:F1",
    split_version: 1,
    l1_start_d: "2020-01-01",
    l1_end_d: "2021-06-30",
    purge: 60,
    l2_start_d: "2021-09-30",
    l2_end_d: "2022-06-30",
    block: 5,
    frozen_run: "run1",
  },
  lesson: {
    id: "L-AU-LT-REGIME-abcd1234-F1.v1",
    market: "AU",
    scope: "lineage",
    lineage_id: "AU:F1",
    template_id: "LT-REGIME",
    template_version: 1,
    subject_json: "{}",
    rule_version: "F1.v1",
    metric: "mean_excess",
    direction: 1,
    param_hint: null,
    created_d: D,
    created_run: "run1",
  },
  lesson_grade: {
    lesson_id: "L-AU-LT-REGIME-abcd1234-F1.v1",
    seq: 1,
    grade: "L1",
    split_version: 1,
    window: "l1",
    n: 40,
    blocks: 16,
    estimate: 0.01,
    lower: 0.002,
    upper: 0.02,
    p: null,
    alpha_j: null,
    B: 1000,
    state_text: "",
    reachable_d: null,
    run_id: "run1",
    d: D,
    corrects_seq: null,
  },
  alpha_wealth: {
    pool: "AU:F1",
    seq: 1,
    lesson_id: "L-AU-LT-REGIME-abcd1234-F1.v1",
    window_key: "1:l2",
    w_before: 0.1,
    alpha_j: 0.1 / 2.1,
    p: 0.01,
    rejected: 1,
    w_after: 0.15,
    run_id: "run1",
  },
  attribution: {
    subject_kind: "trade",
    subject_id: "T1",
    version: 1,
    market: "AU",
    d: D,
    final: 0,
    tags_json: "{}",
    mfe_ppm: 50_000,
    mae_ppm: -20_000,
    hold_sessions: 3,
    cost_micro: 1_000_000,
    slippage_micro: 500_000,
    net_micro: null,
    excess_ppm: null,
    stress_ppm: null,
  },
  blocked_trade: {
    signal_id: "sig1",
    execution_id: "E01",
    market: "AU",
    d: D,
    reason: "capacity",
    card_id: null,
    counterfactual_row_id: null,
    counterfactual_net_ppm: null,
    final: 0,
  },
  comparison_result: {
    market: "AU",
    kind: "nightly",
    pair_id: "twins:E01:E02",
    d: TODAY,
    n_a: 40,
    n_b: 41,
    estimate: 0.001,
    lower: -0.01,
    upper: 0.01,
    p: null,
    bh_rank: null,
    discovery: 0,
    block: 5,
    B: 1000,
    label: "descriptive - not a finding",
  },
  comparison_finding: {
    id: "cf:twins:E01:E02:2026-10-17",
    pair_id: "twins:E01:E02",
    direction: 1,
    detected_d: "2026-10-17",
    look_due_d: "2026-12-01",
    state: "candidate",
    lockout_until_d: null,
    look_result_ref: null,
  },
  critique: {
    subject_kind: "lesson",
    subject_id: "L-AU-LT-REGIME-abcd1234-F1.v1",
    run_id: "run1",
    checks_json: "{}",
    passed: 1,
    access_trial_id: null,
    d: D,
  },
  critique_note: {
    subject_kind: "lesson",
    subject_id: "L-AU-LT-REGIME-abcd1234-F1.v1",
    run_id: "run1",
    kind: "concerns",
    text: "template concern",
    provider: null,
    model_id: null,
    fallback_depth: "rules-only",
    tokens_in: 0,
    tokens_out: 0,
    prompt_sha: null,
    deferred: 0,
  },
  challenger: {
    id: "C-AU-F1-1",
    lineage_id: "AU:F1",
    rule_version_id: "F1.v2",
    incumbent_version_id: "F1.v1",
    origin: "generator",
    lesson_ids_json: "[]",
    state: "proposed",
    state_d: D,
    trial_id: "trial1",
    shakedown_ok_sessions: 0,
    shadow_viewed_d: null,
    ready: 0,
  },
  challenger_event: {
    challenger_id: "C-AU-F1-1",
    seq: 1,
    from_state: null,
    to_state: "proposed",
    d: D,
    actor: "A6",
    reason: "generator",
    ref_json: "{}",
  },
  promotion: {
    id: "P1",
    market: "AU",
    family: "F1",
    kind: "promotion",
    from_version: "F1.v1",
    to_version: "F1.v2",
    challenger_id: "C-AU-F1-1",
    approved_at: AT,
    approved_by: "u1",
    status: "pending",
    applied_d: null,
    group_id: "TW-F1",
  },
  change_ledger: {
    market: "AU",
    kind: "lane_a_playbook",
    target: "knowledge/au/agent-playbooks/A1.md",
    before_json: null,
    after_json: "{}",
    diff_text: null,
    lesson_ids_json: "[]",
    challenger_id: null,
    effective_d: D,
    actor: "A6",
    audit_ref: null,
    created_at: AT,
  },
  playbook_version: {
    market: "AU",
    agent: "A1",
    n: 1,
    content: "x",
    content_sha: HEX64,
    tokens_est: 1,
    change_id: 1,
    effective_d: D,
  },
  plan_item: {
    market: "AU",
    d: D,
    rank: 1,
    kind: "lane_a_change",
    reason: "no-lesson:lane_a_change",
    lesson_id: null,
    lane: "A",
    measure_json: "{}",
  },
  plan_review: {
    market: "AU",
    plan_d: D,
    rank: 1,
    reviewed_d: "2026-10-21",
    outcome: "not_yet_due",
    evidence_json: "{}",
  },
  document: {
    path: "knowledge/au/families/F1.md",
    version: 1,
    market: "AU",
    doc_type: "family",
    front_json: "{}",
    body: "x",
    body_sha: HEX64,
    source_ids_json: "[]",
    d: D,
    created_at: AT,
  },
  kb_archive_run: {
    run_id: "ka1",
    d: TODAY,
    status: "running",
    files_changed: 0,
    commit_sha: null,
    started_at: NOW,
    finished_at: null,
  },
  factor_bucket_stat: {
    market: "AU",
    family: "F1",
    rule_version: "F1.v1",
    split_version: 1,
    factor: "volume_ratio",
    bucket: 1,
    edges_json: "[]",
    n: 30,
    median_net_ppm: 1000,
    family_median_ppm: 500,
  },
  pick: {
    market: "AU",
    d: D,
    profile: "balanced",
    rank: 1,
    code: "ZZAA",
    family: "F1",
    tier: "U1",
    rule_version: "F1.v1",
    signal_id: "sig1",
    card_id: null,
    label: "UNVALIDATED",
    reference_micro: 4_000_000,
    buy_max_micro: 4_050_000,
    valid_until_d: "2026-10-22",
    stop_micro: 3_700_000,
    aim_micro: 4_400_000,
    aim_reach_ppm: 400_000,
    n_similar: 87,
    bad_ppm: -60_000,
    typical_ppm: 30_000,
    good_ppm: 110_000,
    time_frame_sessions: 15,
    size_micro: 1_000_000_000,
    risk_micro: 80_000_000,
    factors_json: "{}",
    based_on_json: "[]",
    pick_sha: HEX64,
    created_at: AT,
  },
  pick_outcome: {
    market: "AU",
    d: D,
    profile: "balanced",
    rank: 1,
    kind: "pick",
    code: "ZZAA",
    published_sha: HEX64,
    state: "waiting",
    entry_d: null,
    entry_micro: null,
    exit_d: null,
    exit_micro: null,
    exit_reason: null,
    net_micro: null,
    net_ppm: null,
    updated_d: D,
  },
  bakeoff_result: {
    run_id: "bo1",
    model_id: "mock",
    category: "triage",
    items: 10,
    json_valid_pct: 100,
    invented_numbers: 0,
    injection_resistance_pct: 100,
    detection_pct: null,
    triage_agreement_pct: 90,
    passes: 1,
    report_sha: HEX64,
    trains_on_prompts_checked_d: D,
  },
};

// Insert order respects the cross-check guards (parents first).
const SEED_ORDER = [
  "rule_version",
  "rule_version_status",
  "lesson_window",
  "lesson",
  "lesson_grade",
  "alpha_wealth",
  "attribution",
  "blocked_trade",
  "comparison_result",
  "comparison_finding",
  "critique",
  "critique_note",
  "challenger",
  "challenger_event",
  "promotion",
  "change_ledger",
  "playbook_version",
  "plan_item",
  "plan_review",
  "document",
  "kb_archive_run",
  "factor_bucket_stat",
  "pick",
  "pick_outcome",
  "bakeoff_result",
] as const;

async function seeded(): Promise<Client> {
  const db = await freshDb("main");
  for (const t of SEED_ORDER) await ins(db, t, ROW[t]);
  return db;
}

const TABLES = Object.values(LEARNING_TABLES);

describe("main migration 0010_learning: shape", () => {
  it("is the tenth main migration", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[9]).toMatchObject({ version: 10, name: "learning" });
  });

  it("creates exactly the 25 tables of schema.ts with the columns in order", async () => {
    const db = await freshDb("main");
    expect(TABLES).toHaveLength(25);
    expect(Object.keys(ROW).sort()).toEqual([...TABLES].sort());
    for (const t of TABLES) {
      const cols = (await q(db, `PRAGMA table_info(${t})`)).map((r) => r.name);
      expect(cols, t).toEqual([...LEARNING_COLUMNS[t]]);
    }
  });

  it("every table is STRICT; REAL columns are exactly the statistics listed", async () => {
    const db = await freshDb("main");
    for (const t of TABLES) {
      expect((await q(db, `SELECT strict FROM pragma_table_list('${t}')`))[0].strict, t).toBe(1);
      const real: string[] = [];
      for (const c of await q(db, `PRAGMA table_info(${t})`)) {
        expect(["INTEGER", "TEXT", "REAL"], `${t}.${String(c.name)}`).toContain(c.type);
        if (c.type === "REAL") real.push(String(c.name));
        if (String(c.name).endsWith("_micro") || String(c.name).endsWith("_ppm")) {
          expect(c.type, `${t}.${String(c.name)}`).toBe("INTEGER");
        }
      }
      const listed =
        (LEARNING_REAL_COLUMNS as Record<string, readonly string[]>)[t] ?? ([] as string[]);
      expect(real.sort(), t).toEqual([...listed].sort());
    }
  });

  it("the table sets cover every table once (append-only + one-way; forever + pruned)", () => {
    const all = [...TABLES].sort();
    expect([...LEARNING_APPEND_ONLY_TABLES, ...LEARNING_ONE_WAY_TABLES].sort()).toEqual(all);
    expect([...LEARNING_FOREVER_TABLES, ...Object.keys(LEARNING_PRUNED_TABLES)].sort()).toEqual(
      all,
    );
  });

  it("seeds nothing", async () => {
    const db = await freshDb("main");
    for (const t of TABLES) expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(0);
  });

  it("a valid row for every table inserts; the same insert twice is a UNIQUE error, not a replace", async () => {
    const db = await seeded();
    for (const t of TABLES) {
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(1);
    }
    for (const t of SEED_ORDER) {
      if (t === "change_ledger") continue; // AUTOINCREMENT id: a second insert is a new row
      await expect(ins(db, t, ROW[t]), t).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    }
    // ON CONFLICT DO NOTHING stays idempotent through the insert guards.
    const guarded: [string, Record<string, V>][] = [
      ["lesson_grade", ROW.lesson_grade],
      ["alpha_wealth", ROW.alpha_wealth],
      ["attribution", ROW.attribution],
      ["rule_version_status", ROW.rule_version_status],
      ["challenger_event", ROW.challenger_event],
      ["playbook_version", ROW.playbook_version],
      ["document", ROW.document],
    ];
    for (const [t, row] of guarded) {
      const cols = Object.keys(row).join(", ");
      const marks = Object.keys(row)
        .map(() => "?")
        .join(", ");
      await run(
        db,
        `INSERT INTO ${t} (${cols}) VALUES (${marks}) ON CONFLICT DO NOTHING`,
        Object.values(row),
      );
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n, t).toBe(1);
    }
  });
});

describe("main migration 0010_learning: append-only, forever and prune-only", () => {
  const UPDATES: Record<string, string> = {
    rule_version: "UPDATE rule_version SET created_by = 'x'",
    rule_version_status: "UPDATE rule_version_status SET reason = 'x'",
    lesson_window: "UPDATE lesson_window SET block = 6",
    lesson: "UPDATE lesson SET metric = 'x'",
    lesson_grade: "UPDATE lesson_grade SET n = 1",
    alpha_wealth: "UPDATE alpha_wealth SET w_after = 0.2",
    attribution: "UPDATE attribution SET final = 1",
    comparison_result: "UPDATE comparison_result SET n_a = 1",
    critique: "UPDATE critique SET passed = 0",
    critique_note: "UPDATE critique_note SET text = 'y'",
    challenger_event: "UPDATE challenger_event SET reason = 'y'",
    change_ledger: "UPDATE change_ledger SET actor = 'y'",
    playbook_version: "UPDATE playbook_version SET content = 'y'",
    plan_item: "UPDATE plan_item SET reason = 'no-lesson:y'",
    plan_review: "UPDATE plan_review SET outcome = 'met'",
    document: "UPDATE document SET body = 'y'",
    factor_bucket_stat: "UPDATE factor_bucket_stat SET n = 31",
    pick: "UPDATE pick SET code = 'ZZBB'",
    bakeoff_result: "UPDATE bakeoff_result SET passes = 0",
  };
  for (const t of LEARNING_APPEND_ONLY_TABLES) {
    it(`${t}: UPDATE aborts and the row is unchanged`, async () => {
      const db = await seeded();
      const before = await q(db, `SELECT * FROM ${t}`);
      await expect(run(db, UPDATES[t])).rejects.toThrow(/append-only/);
      expect(await q(db, `SELECT * FROM ${t}`)).toEqual(before);
    });
  }

  const DELETABLE = Object.keys(LEARNING_PRUNED_TABLES);
  for (const t of TABLES.filter((x) => !DELETABLE.includes(x))) {
    it(`${t}: DELETE aborts (forever / append-only), the row stays`, async () => {
      const db = await seeded();
      await expect(run(db, `DELETE FROM ${t}`)).rejects.toThrow(/append-only|forever table/);
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n).toBe(1);
    });
  }

  const OLD_ROW: Record<string, Record<string, V>> = {
    comparison_result: { ...ROW.comparison_result, d: OLD_D },
    kb_archive_run: { ...ROW.kb_archive_run, run_id: "ka0", d: OLD_D, started_at: OLD_AT },
  };
  for (const t of DELETABLE) {
    it(`${t}: only rows beyond the retention floor can be deleted`, async () => {
      const db = await seeded();
      await ins(db, t, OLD_ROW[t]);
      await expect(run(db, `DELETE FROM ${t}`)).rejects.toThrow(/delete only/);
      const col = LEARNING_PRUNED_TABLES[t as keyof typeof LEARNING_PRUNED_TABLES].column;
      await run(db, `DELETE FROM ${t} WHERE ${col} = ?`, [OLD_ROW[t][col]]);
      expect((await q(db, `SELECT COUNT(*) AS n FROM ${t}`))[0].n).toBe(1);
    });
  }
});

describe("main migration 0010_learning: rule versions, lessons, alpha-investing, attribution", () => {
  it("rule_version: id must match family and n; seed has no parent, others have one", async () => {
    const db = await freshDb("main");
    const r = ROW.rule_version;
    await expect(ins(db, "rule_version", { ...r, id: "F1.v2" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "rule_version", { ...r, origin: "challenger" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "rule_version", { ...r, parent: "F1.v0" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "rule_version", { ...r, family: "F7", id: "F7.v1" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "rule_version", { ...r, params_sha: "zz" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "rule_version", { ...r, params_json: "{" })).rejects.toThrow(/CHECK/);
    await ins(db, "rule_version", r);
    await ins(db, "rule_version", {
      ...r,
      id: "F1.v2",
      n: 2,
      parent: "F1.v1",
      origin: "challenger",
    });
    await expect(
      ins(db, "rule_version", { ...r, id: "F1.v2", n: 2, parent: "F1.v1", origin: "owner" }),
    ).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it("rule_version_status: needs its version, no gap, first is registered, nothing after retired", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "rule_version_status", ROW.rule_version_status)).rejects.toThrow(
      /needs its version/,
    );
    await ins(db, "rule_version", ROW.rule_version);
    await expect(
      ins(db, "rule_version_status", { ...ROW.rule_version_status, status: "live" }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "rule_version_status", ROW.rule_version_status);
    await expect(
      ins(db, "rule_version_status", { ...ROW.rule_version_status, seq: 3, status: "live" }),
    ).rejects.toThrow(/no gap/);
    for (const [seq, status] of [
      [2, "live"],
      [3, "shadow"],
      [4, "retired"],
    ] as const) {
      await ins(db, "rule_version_status", { ...ROW.rule_version_status, seq, status });
    }
    await expect(
      ins(db, "rule_version_status", { ...ROW.rule_version_status, seq: 5, status: "live" }),
    ).rejects.toThrow(/after retired/);
  });

  it("lesson: scope and lineage agree; grade rows need the lesson and consecutive seq", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "lesson", { ...ROW.lesson, scope: "market" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "lesson", { ...ROW.lesson, lineage_id: null })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "lesson", { ...ROW.lesson, direction: 0 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "lesson_grade", ROW.lesson_grade)).rejects.toThrow(/needs its lesson/);
    await ins(db, "lesson", ROW.lesson);
    await expect(ins(db, "lesson_grade", { ...ROW.lesson_grade, seq: 2 })).rejects.toThrow(
      /no gap/,
    );
    await ins(db, "lesson_grade", ROW.lesson_grade);
    await ins(db, "lesson_grade", { ...ROW.lesson_grade, seq: 2, grade: "retired", window: null });
    await expect(
      ins(db, "lesson_grade", { ...ROW.lesson_grade, seq: 3, corrects_seq: 3 }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "lesson_grade", { ...ROW.lesson_grade, seq: 3, grade: "L4" }),
    ).rejects.toThrow(/CHECK/);
  });

  it("alpha_wealth: the pool chain continues from w_after; a payout earns, a loss pays", async () => {
    const db = await freshDb("main");
    await ins(db, "lesson", ROW.lesson);
    const a = ROW.alpha_wealth;
    await expect(ins(db, "alpha_wealth", { ...a, seq: 2, w_before: 0.15 })).rejects.toThrow(
      /no gap/,
    );
    await expect(ins(db, "alpha_wealth", { ...a, rejected: 0, w_after: 0.2 })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "alpha_wealth", { ...a, rejected: 1, w_after: 0.05 })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "alpha_wealth", { ...a, w_after: -0.1, rejected: 0 })).rejects.toThrow(
      /CHECK/,
    );
    await ins(db, "alpha_wealth", a);
    await expect(ins(db, "alpha_wealth", { ...a, seq: 2, w_before: 0.2 })).rejects.toThrow(
      /continues the pool/,
    );
    await ins(db, "alpha_wealth", { ...a, seq: 2, w_before: 0.15, rejected: 0, w_after: 0.075 });
    // another pool starts on its own
    await ins(db, "alpha_wealth", { ...a, pool: "AU:*", w_before: 0.1 });
    await expect(
      ins(db, "alpha_wealth", { ...a, lesson_id: "L-none", pool: "AU:F2" }),
    ).rejects.toThrow(/needs its lesson/);
  });

  it("attribution: versions are consecutive and nothing follows a final row; blocked needs no fill", async () => {
    const db = await freshDb("main");
    const t = ROW.attribution;
    await expect(ins(db, "attribution", { ...t, version: 2 })).rejects.toThrow(/no gap/);
    await ins(db, "attribution", t);
    await ins(db, "attribution", { ...t, version: 2, final: 1, net_micro: 5, excess_ppm: 1 });
    await expect(ins(db, "attribution", { ...t, version: 3 })).rejects.toThrow(/final/);
    await expect(ins(db, "attribution", { ...t, subject_id: "T2", mfe_ppm: null })).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      ins(db, "attribution", { ...t, subject_id: "T3", mfe_ppm: 1, mae_ppm: 2 }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "attribution", {
      ...t,
      subject_kind: "blocked",
      subject_id: "B1",
      mfe_ppm: null,
      mae_ppm: null,
      hold_sessions: null,
      cost_micro: null,
      slippage_micro: null,
    });
  });

  it("lesson_window: the L1 window precedes the purge and the L2 window", async () => {
    const db = await freshDb("main");
    const w = ROW.lesson_window;
    await expect(ins(db, "lesson_window", { ...w, l2_start_d: "2021-06-30" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "lesson_window", { ...w, block: 0 })).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0010_learning: one-way tables", () => {
  it("blocked_trade: the counterfactual goes NULL to a value once; final is one-way", async () => {
    const db = await seeded();
    await set(db, "blocked_trade", "counterfactual_row_id = 'r1', counterfactual_net_ppm = 5000");
    await expect(set(db, "blocked_trade", "counterfactual_net_ppm = 6000")).rejects.toThrow(
      /only the counterfactual/,
    );
    await expect(set(db, "blocked_trade", "counterfactual_net_ppm = NULL")).rejects.toThrow(
      /only the counterfactual/,
    );
    await expect(set(db, "blocked_trade", "reason = 'x'")).rejects.toThrow(
      /only the counterfactual/,
    );
    await expect(set(db, "blocked_trade", "d = '2026-10-21'")).rejects.toThrow(
      /only the counterfactual/,
    );
    await set(db, "blocked_trade", "final = 1");
    await expect(set(db, "blocked_trade", "final = 0")).rejects.toThrow(/only the counterfactual/);
  });

  it("comparison_finding: candidate moves once; a discard carries its lockout, a look its reference", async () => {
    const db = await seeded();
    await expect(set(db, "comparison_finding", "state = 'confirmed'")).rejects.toThrow(/CHECK/);
    await expect(
      set(db, "comparison_finding", "state = 'discarded', look_result_ref = 'r1'"),
    ).rejects.toThrow(/CHECK/);
    await expect(set(db, "comparison_finding", "direction = -1")).rejects.toThrow(
      /candidate moves once/,
    );
    await set(db, "comparison_finding", "state = 'confirmed', look_result_ref = 'r1'");
    await expect(
      set(db, "comparison_finding", "state = 'candidate', look_result_ref = NULL"),
    ).rejects.toThrow(/candidate moves once|CHECK/);
    await expect(set(db, "comparison_finding", "look_result_ref = 'r2'")).rejects.toThrow(
      /candidate moves once/,
    );
    const db2 = await seeded();
    await set(
      db2,
      "comparison_finding",
      "state = 'discarded', look_result_ref = 'r1', lockout_until_d = '2027-02-01'",
    );
    await expect(set(db2, "comparison_finding", "lockout_until_d = '2027-03-01'")).rejects.toThrow(
      /candidate moves once/,
    );
  });

  it("kb_archive_run: running moves once to a final status; sha and finish time are set once", async () => {
    const db = await seeded();
    await set(
      db,
      "kb_archive_run",
      "status = 'ok', files_changed = 3, commit_sha = ?, finished_at = ?",
      "1 = 1",
      [SHA40, NOW],
    );
    await expect(set(db, "kb_archive_run", "status = 'failed'")).rejects.toThrow(/running moves/);
    await expect(set(db, "kb_archive_run", "files_changed = 2")).rejects.toThrow(/running moves/);
    await expect(
      set(db, "kb_archive_run", "commit_sha = ?", "1 = 1", ["d".repeat(40)]),
    ).rejects.toThrow(/running moves/);
    await expect(set(db, "kb_archive_run", "commit_sha = 'zz'")).rejects.toThrow(
      /CHECK|running moves/,
    );
  });

  it("promotion: starts pending, moves once to applied (with applied_d) or cancelled, nothing else changes", async () => {
    const db = await freshDb("main");
    await expect(
      ins(db, "promotion", { ...ROW.promotion, status: "applied", applied_d: D }),
    ).rejects.toThrow(/starts pending/);
    await expect(ins(db, "promotion", { ...ROW.promotion, challenger_id: null })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "promotion", { ...ROW.promotion, to_version: "F1.v1" })).rejects.toThrow(
      /CHECK/,
    );
    await ins(db, "promotion", ROW.promotion);
    await ins(db, "promotion", {
      ...ROW.promotion,
      id: "P2",
      kind: "rollback",
      challenger_id: null,
      from_version: "F1.v2",
      to_version: "F1.v3",
    });
    await expect(set(db, "promotion", "to_version = 'F1.v9'", "id = 'P1'")).rejects.toThrow(
      /pending moves once/,
    );
    await expect(set(db, "promotion", "status = 'applied'", "id = 'P1'")).rejects.toThrow(/CHECK/);
    await set(db, "promotion", "status = 'applied', applied_d = ?", "id = 'P1'", [D]);
    await expect(
      set(db, "promotion", "status = 'cancelled', applied_d = NULL", "id = 'P1'"),
    ).rejects.toThrow(/pending moves once/);
    await set(db, "promotion", "status = 'cancelled'", "id = 'P2'");
    await expect(set(db, "promotion", "approved_by = 'u2'", "id = 'P2'")).rejects.toThrow(
      /pending moves once/,
    );
  });

  it("pick_outcome: starts waiting with its published pick; waiting to bought | missed, bought to closed", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "pick_outcome", ROW.pick_outcome)).rejects.toThrow(
      /needs its published pick/,
    );
    await ins(db, "pick", ROW.pick);
    await expect(
      ins(db, "pick_outcome", { ...ROW.pick_outcome, published_sha: HEX64B }),
    ).rejects.toThrow(/needs its published pick/);
    await ins(db, "pick_outcome", ROW.pick_outcome);
    await ins(db, "pick_outcome", { ...ROW.pick_outcome, kind: "luck", code: "ZZLK" });
    await expect(set(db, "pick_outcome", "state = 'closed'", "kind = 'pick'")).rejects.toThrow(
      /CHECK|state edges/,
    );
    await set(
      db,
      "pick_outcome",
      "state = 'bought', entry_d = ?, entry_micro = 4000000",
      "kind = 'pick'",
      ["2026-10-21"],
    );
    await expect(set(db, "pick_outcome", "entry_micro = 3000000", "kind = 'pick'")).rejects.toThrow(
      /state edges/,
    );
    await expect(set(db, "pick_outcome", "state = 'missed'", "kind = 'pick'")).rejects.toThrow(
      /CHECK|state edges/,
    );
    await set(
      db,
      "pick_outcome",
      "state = 'closed', exit_d = ?, exit_micro = 4400000, exit_reason = 'aim', net_micro = 390000, net_ppm = 97500, updated_d = ?",
      "kind = 'pick'",
      ["2026-11-02", "2026-11-02"],
    );
    await expect(set(db, "pick_outcome", "net_ppm = 1", "kind = 'pick'")).rejects.toThrow(
      /state edges/,
    );
    await expect(set(db, "pick_outcome", "code = 'ZZBB'", "kind = 'luck'")).rejects.toThrow(
      /state edges/,
    );
    await set(db, "pick_outcome", "state = 'missed'", "kind = 'luck'");
    await expect(set(db, "pick_outcome", "state = 'bought'", "kind = 'luck'")).rejects.toThrow(
      /state edges/,
    );
  });

  it("pick: the stop is below, the aim above and the buy limit at or above the reference price", async () => {
    const db = await freshDb("main");
    const p = ROW.pick;
    await expect(ins(db, "pick", { ...p, stop_micro: 4_000_000 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "pick", { ...p, aim_micro: 4_000_000 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "pick", { ...p, buy_max_micro: 3_900_000 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "pick", { ...p, rank: 11 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "pick", { ...p, valid_until_d: "2026-10-19" })).rejects.toThrow(/CHECK/);
  });
});

describe("main migration 0010_learning: challenger state machine (KB-040)", () => {
  it("the schema edge table equals the trigger: every allowed edge passes, every other fails", async () => {
    for (const from of CHALLENGER_STATES) {
      for (const to of CHALLENGER_STATES) {
        if (from === to) continue;
        const db = await freshDb("main");
        // put the challenger into `from` by inserting directly in `proposed` and walking a path
        await ins(db, "challenger", ROW.challenger);
        const path: Record<string, string[]> = {
          proposed: [],
          replay: ["replay"],
          shakedown: ["replay", "shakedown"],
          review: ["replay", "shakedown", "review"],
          approved: ["replay", "shakedown", "review", "approved"],
          promoted: ["replay", "shakedown", "review", "approved", "promoted"],
          rejected: ["rejected"],
          retired: ["retired"],
        };
        for (const s of path[from]) await set(db, "challenger", "state = ?", "1 = 1", [s]);
        const allowed = CHALLENGER_EDGES[from].includes(to);
        const attempt = set(db, "challenger", "state = ?", "1 = 1", [to]);
        if (allowed) await attempt;
        else await expect(attempt, `${from} > ${to}`).rejects.toThrow(/KB-040 edges/);
        // the event table accepts exactly the same edges
        const ev = ins(db, "challenger_event", {
          ...ROW.challenger_event,
          seq: 1,
          from_state: from,
          to_state: to,
        });
        if (allowed) {
          // seq 1 already exists for a challenger row only if inserted; here the table is empty
          await ev;
        } else {
          await expect(ev, `event ${from} > ${to}`).rejects.toThrow(/CHECK/);
        }
      }
    }
  }, 120_000); // walks every challenger edge pair through a real migrated DB: slow on loaded machines and CI runners

  it("starts proposed with a zero counter and not ready", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "challenger", { ...ROW.challenger, state: "replay" })).rejects.toThrow(
      /starts proposed/,
    );
    await expect(
      ins(db, "challenger", { ...ROW.challenger, shakedown_ok_sessions: 1 }),
    ).rejects.toThrow(/starts proposed/);
    await expect(
      ins(db, "challenger", { ...ROW.challenger, rule_version_id: "F1.v1" }),
    ).rejects.toThrow(/CHECK/);
  });

  it("identity columns never change; state_d only moves forward; shadow_viewed_d never goes back", async () => {
    const db = await seeded();
    for (const c of [
      "lineage_id = 'x'",
      "rule_version_id = 'F1.v9'",
      "incumbent_version_id = 'F1.v9'",
      "origin = 'owner'",
      "lesson_ids_json = '[1]'",
      "trial_id = 'x'",
      "state_d = '2026-10-01'",
    ]) {
      await expect(set(db, "challenger", c), c).rejects.toThrow(/KB-040 edges/);
    }
    await set(db, "challenger", "shadow_viewed_d = '2026-10-20'");
    await set(db, "challenger", "shadow_viewed_d = '2026-10-22'");
    await expect(set(db, "challenger", "shadow_viewed_d = '2026-10-21'")).rejects.toThrow(
      /KB-040 edges/,
    );
    await expect(set(db, "challenger", "shadow_viewed_d = NULL")).rejects.toThrow(/KB-040 edges/);
  });

  it("the shakedown counter only grows, except for a reset to 0 while in shakedown", async () => {
    const db = await seeded();
    await set(db, "challenger", "state = 'replay'");
    await set(db, "challenger", "state = 'shakedown'");
    await set(db, "challenger", "shakedown_ok_sessions = 4");
    await set(db, "challenger", "shakedown_ok_sessions = 5");
    await expect(set(db, "challenger", "shakedown_ok_sessions = 3")).rejects.toThrow(
      /KB-040 edges/,
    );
    await set(db, "challenger", "shakedown_ok_sessions = 0"); // operational error resets the count
    await set(db, "challenger", "shakedown_ok_sessions = 10");
    await set(db, "challenger", "state = 'review'");
    await expect(set(db, "challenger", "shakedown_ok_sessions = 0")).rejects.toThrow(
      /KB-040 edges/,
    );
  });

  it("ready is only possible from review on", async () => {
    const db = await seeded();
    await expect(set(db, "challenger", "ready = 1")).rejects.toThrow(/CHECK|KB-040 edges/);
    await set(db, "challenger", "state = 'replay'");
    await set(db, "challenger", "state = 'shakedown'");
    await set(db, "challenger", "state = 'review'");
    await set(db, "challenger", "ready = 1");
    await set(db, "challenger", "ready = 0");
    await set(db, "challenger", "ready = 1");
    await set(db, "challenger", "state = 'approved'");
    await expect(set(db, "challenger", "ready = 0")).rejects.toThrow(/KB-040 edges/);
  });

  it("challenger_event: needs its challenger and consecutive seq; the first event is NULL to proposed", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "challenger_event", ROW.challenger_event)).rejects.toThrow(
      /needs its challenger/,
    );
    await ins(db, "challenger", ROW.challenger);
    await expect(
      ins(db, "challenger_event", {
        ...ROW.challenger_event,
        seq: 2,
        from_state: "proposed",
        to_state: "replay",
      }),
    ).rejects.toThrow(/no gap/);
    await expect(
      ins(db, "challenger_event", {
        ...ROW.challenger_event,
        from_state: null,
        to_state: "replay",
      }),
    ).rejects.toThrow(/CHECK/);
    await ins(db, "challenger_event", ROW.challenger_event);
    await ins(db, "challenger_event", {
      ...ROW.challenger_event,
      seq: 2,
      from_state: "proposed",
      to_state: "replay",
    });
  });
});

describe("main migration 0010_learning: ledgers, plan, documents, bake-off", () => {
  it("change_ledger: ids are monotone and never reused (AUTOINCREMENT); kinds are enumerated", async () => {
    const db = await seeded();
    await ins(db, "change_ledger", { ...ROW.change_ledger, kind: "promotion" });
    const ids = (await q(db, "SELECT id FROM change_ledger ORDER BY id")).map((r) => Number(r.id));
    expect(ids).toEqual([1, 2]);
    await expect(ins(db, "change_ledger", { ...ROW.change_ledger, kind: "other" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      ins(db, "change_ledger", { ...ROW.change_ledger, before_json: "{" }),
    ).rejects.toThrow(/CHECK/);
  });

  it("plan_item: five ranks; a missing lesson needs the no-lesson reason; plan_review needs its item", async () => {
    const db = await freshDb("main");
    const p = ROW.plan_item;
    await expect(ins(db, "plan_item", { ...p, rank: 6 })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "plan_item", { ...p, reason: "x" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "plan_item", { ...p, lane: "C" })).rejects.toThrow(/CHECK/);
    await ins(db, "plan_item", { ...p, reason: "x", lesson_id: "L-1" });
    await expect(ins(db, "plan_review", { ...ROW.plan_review, rank: 3 })).rejects.toThrow(
      /needs its plan item/,
    );
    await ins(db, "plan_item", { ...p, rank: 2 });
    await ins(db, "plan_review", { ...ROW.plan_review, rank: 2 });
    await expect(
      ins(db, "plan_review", { ...ROW.plan_review, rank: 2, reviewed_d: "2026-10-19" }),
    ).rejects.toThrow(/UNIQUE|PRIMARY|CHECK/);
  });

  it("playbook_version: known agents only and no gap in n", async () => {
    const db = await freshDb("main");
    await expect(
      ins(db, "playbook_version", { ...ROW.playbook_version, agent: "A4" }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "playbook_version", { ...ROW.playbook_version, n: 2 })).rejects.toThrow(
      /no gap/,
    );
    await ins(db, "playbook_version", ROW.playbook_version);
    await ins(db, "playbook_version", { ...ROW.playbook_version, n: 2 });
  });

  it("document: paths stay under knowledge/ as markdown without '..'; versions have no gap", async () => {
    const db = await freshDb("main");
    const d = ROW.document;
    for (const path of [
      "src/x.md",
      "knowledge/au/x.txt",
      "knowledge/../x.md",
      "knowledge/au/..md",
      "/knowledge/au/x.md",
    ]) {
      await expect(ins(db, "document", { ...d, path }), path).rejects.toThrow(/CHECK/);
    }
    await expect(ins(db, "document", { ...d, version: 2 })).rejects.toThrow(/no gap/);
    await ins(db, "document", d);
    await ins(db, "document", { ...d, version: 2, body_sha: HEX64B });
    await expect(ins(db, "document", { ...d, doc_type: "memo", version: 3 })).rejects.toThrow(
      /CHECK/,
    );
  });

  it("bakeoff_result: a pass needs a dated trains_on_prompts check; percentages stay in range", async () => {
    const db = await freshDb("main");
    const b = ROW.bakeoff_result;
    await expect(
      ins(db, "bakeoff_result", { ...b, trains_on_prompts_checked_d: null }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "bakeoff_result", { ...b, json_valid_pct: 101 })).rejects.toThrow(/CHECK/);
    await ins(db, "bakeoff_result", { ...b, passes: 0, trains_on_prompts_checked_d: null });
  });

  it("critique_note and factor buckets reject bad values", async () => {
    const db = await freshDb("main");
    await expect(ins(db, "critique_note", { ...ROW.critique_note, kind: "other" })).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      ins(db, "critique_note", { ...ROW.critique_note, prompt_sha: "x" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "factor_bucket_stat", { ...ROW.factor_bucket_stat, bucket: 0 }),
    ).rejects.toThrow(/CHECK/);
    await expect(ins(db, "critique", { ...ROW.critique, checks_json: "{" })).rejects.toThrow(
      /CHECK/,
    );
  });
});

describe("main migration 0010_learning: up / down / up and backup", () => {
  it("down removes every table, trigger and index of 0010 and touches nothing else; up restores an identical schema", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    const full = await schemaOf(db);
    await migrateDown(db, ms, 12); // 0019, 0018 (m14), 0017 (first_ingested_at), 0016 (known_at), 0015 (vendor actions), 0014 (pick checks), 0013 (calendar history), 0012 (golive) and 0011 (ui) sit on top: take the schema as of 0010
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 9 });
    const mid = await schemaOf(db);
    for (const t of TABLES) {
      expect(
        mid.some((s) => s.startsWith(`table:${t}:`)),
        t,
      ).toBe(false);
    }
    const names = new Set<string>(TABLES);
    const rest = before.filter((s) => {
      const [type, name] = s.split(":");
      if (type === "table") return !names.has(name);
      return ![...names].some(
        (t) => name.startsWith(`${t}_`) || name === `idx_${t}` || name.startsWith(`idx_${t}_`),
      );
    });
    expect(mid).toEqual(rest);
    expect(await migrateUp(db, ms)).toEqual({ applied: 13, version: 22 }); // 0010, 0011, 0012, then 0013
    expect(await schemaOf(db)).toEqual(full);
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 22 });
  });

  it("every forever table of the migration is in the backup list; pruned tables are not", async () => {
    for (const t of LEARNING_FOREVER_TABLES) expect(FOREVER_TABLES, t).toContain(t);
    for (const t of Object.keys(LEARNING_PRUNED_TABLES)) expect(FOREVER_TABLES, t).not.toContain(t);
    for (const t of Object.values(AUTH_ANNOTATION_TABLES)) expect(FOREVER_TABLES, t).toContain(t);
  });

  it("dump and restore round-trip rows and triggers into an empty database", async () => {
    const db = await seeded();
    const d = await dumpDatabase(db, { name: "main", createdAt: AT });
    const meta = JSON.parse(d.text.split("\n")[0]);
    for (const t of LEARNING_FOREVER_TABLES) expect(meta.forever, t).toContain(t);
    for (const t of Object.keys(LEARNING_PRUNED_TABLES)) expect(meta.forever, t).not.toContain(t);
    const target = track(createClient({ url: tempDbUrl() }));
    const r = await restoreDatabase(target, d.text);
    expect(r.sha256).toEqual(d.sha256);
    await expect(run(target, "UPDATE lesson SET metric = 'x'")).rejects.toThrow(/append-only/);
    await expect(run(target, "DELETE FROM challenger")).rejects.toThrow(/forever table/);
    await expect(set(target, "challenger", "state = 'approved'")).rejects.toThrow(/KB-040 edges/);
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(await migrateUp(target, ms)).toEqual({ applied: 0, version: 22 });
  });
});

// ---------------------------------------------------------------------------------------------
// Auth DB 0005_annotation

async function authDb(): Promise<Client> {
  const db = await freshDb("auth");
  await ins(db, "app_user", {
    id: 1,
    email: "owner@example.test",
    role: "owner",
    status: "active",
    created_at: AT,
    updated_at: AT,
  });
  await ins(db, "app_user", {
    id: 2,
    email: "editor@example.test",
    role: "editor",
    status: "active",
    created_at: AT,
    updated_at: AT,
  });
  return db;
}

const NOTE = {
  id: 1,
  subject_kind: "lesson",
  subject_id: "L-1",
  author_id: 2,
  text: "first",
  created_at: AT,
  edited_at: null,
  deleted_at: null,
};

describe("auth migration 0005_annotation", () => {
  it("is the fifth auth migration and the tables have the documented columns", async () => {
    const ms = await loadMigrations(MIGRATIONS("auth"));
    expect(ms[4]).toMatchObject({ version: 5, name: "annotation" });
    const db = await authDb();
    for (const [t, cols] of Object.entries(AUTH_ANNOTATION_COLUMNS)) {
      expect(
        (await q(db, `PRAGMA table_info(${t})`)).map((r) => r.name),
        t,
      ).toEqual([...cols]);
    }
  });

  it("text is 1 to 1000 characters; subject kinds are enumerated; the author must exist", async () => {
    const db = await authDb();
    await expect(ins(db, "annotation", { ...NOTE, text: "" })).rejects.toThrow(/CHECK/);
    await expect(ins(db, "annotation", { ...NOTE, text: "x".repeat(1001) })).rejects.toThrow(
      /CHECK/,
    );
    await expect(ins(db, "annotation", { ...NOTE, subject_kind: "trade" })).rejects.toThrow(
      /CHECK/,
    );
    await ins(db, "annotation", { ...NOTE, text: "x".repeat(1000) });
    await run(db, "PRAGMA foreign_keys = ON");
    await expect(ins(db, "annotation", { ...NOTE, id: 2, author_id: 99 })).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it("an edit needs its history row first; the history is append-only; nothing else changes", async () => {
    const db = await authDb();
    await ins(db, "annotation", NOTE);
    // no history row yet
    await expect(
      set(db, "annotation", "text = 'second', edited_at = ?", "id = 1", [AT]),
    ).rejects.toThrow(/history row/);
    // history must start from the current text
    await expect(
      ins(db, "annotation_history", {
        annotation_id: 1,
        op: "edit",
        at: AT,
        actor_id: 1,
        before_text: "other",
        after_text: "second",
      }),
    ).rejects.toThrow(/before_text/);
    await ins(db, "annotation_history", {
      annotation_id: 1,
      op: "edit",
      at: AT,
      actor_id: 1,
      before_text: "first",
      after_text: "second",
    });
    await set(db, "annotation", "text = 'second', edited_at = ?", "id = 1", [AT]);
    await expect(set(db, "annotation", "text = 'third'", "id = 1")).rejects.toThrow(/history row/);
    await expect(set(db, "annotation", "author_id = 1", "id = 1")).rejects.toThrow(/history row/);
    await expect(set(db, "annotation", "subject_id = 'L-2'", "id = 1")).rejects.toThrow(
      /history row/,
    );
    await expect(set(db, "annotation_history", "actor_id = 2")).rejects.toThrow(/append-only/);
    await expect(run(db, "DELETE FROM annotation_history")).rejects.toThrow(/append-only/);
    await expect(run(db, "DELETE FROM annotation")).rejects.toThrow(/soft delete/);
  });

  it("a soft delete is final and keeps the text; no edit or history after it", async () => {
    const db = await authDb();
    await ins(db, "annotation", NOTE);
    await ins(db, "annotation_history", {
      annotation_id: 1,
      op: "delete",
      at: AT,
      actor_id: 1,
      before_text: "first",
      after_text: null,
    });
    await set(db, "annotation", "deleted_at = ?", "id = 1", [AT]);
    await expect(set(db, "annotation", "deleted_at = NULL", "id = 1")).rejects.toThrow(
      /history row/,
    );
    await expect(
      set(db, "annotation", "text = 'z', edited_at = ?", "id = 1", [AT]),
    ).rejects.toThrow(/history row/);
    await expect(
      ins(db, "annotation_history", {
        annotation_id: 1,
        op: "edit",
        at: AT,
        actor_id: 1,
        before_text: "first",
        after_text: "again",
      }),
    ).rejects.toThrow(/live annotation/);
    expect((await q(db, "SELECT text FROM annotation"))[0].text).toBe("first");
  });

  it("a delete history row has no after_text; an edit row has one", async () => {
    const db = await authDb();
    await ins(db, "annotation", NOTE);
    const h = { annotation_id: 1, at: AT, actor_id: 1, before_text: "first" };
    await expect(
      ins(db, "annotation_history", { ...h, op: "delete", after_text: "x" }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      ins(db, "annotation_history", { ...h, op: "edit", after_text: null }),
    ).rejects.toThrow(/CHECK/);
  });

  it("down removes both tables; up restores an identical schema", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("auth"));
    await migrateUp(db, ms);
    const full = await schemaOf(db);
    await migrateDown(db, ms, 1); // 0006 (ui) sits on top: take the schema as of 0005
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 4 });
    const mid = (await schemaOf(db)).join("\n");
    expect(mid).not.toContain("annotation");
    expect(mid).toContain("alert_user_state");
    expect(await migrateUp(db, ms)).toEqual({ applied: 2, version: 6 }); // 0005, then 0006
    expect(await schemaOf(db)).toEqual(full);
  });
});
