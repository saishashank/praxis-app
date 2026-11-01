// @vitest-environment node
// Migration 0019_cortex (M15 P1; docs/M15_design.md section 3): every table applies, rolls back and
// comes back identical; every append-only guard fires; the two once-only columns and the CHECKs that
// carry a rule (result after log, label needs its validation, an Owner kill only suspends, F7 never
// allowed); arena_order.limit_micro; the FRED register row. Synthetic ZZ data only (SEC-110).
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const J = "'{}'";
const D = "'2030-03-05'";

/** One valid INSERT per new table. */
const INSERTS: Record<string, string> = {
  angle_passport: `INSERT INTO angle_passport (market, angle_id, version, domain, cluster, orientation, kind,
    inputs_json, history_fields_json, status, horizon_sessions, evidence_json, measured_json, frozen_at)
    VALUES ('AU', 'A-D1-01', 1, 1, 'momentum', 1, 'score', '["bar_au"]', ${J}, 'candidate', 20, ${J}, NULL, 't0')`,
  cortex_feature_daily: `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json,
    active_set_hash, manifest_id) VALUES ('AU', ${D}, 'ZZA', ${J}, ${J}, 'h', 'm1')`,
  cortex_ledger_cell: `INSERT INTO cortex_ledger_cell (cell_id, market, family, angle_id, kind, spec_json,
    logged_at, split) VALUES ('c1', 'AU', 'F1', 'A-D1-01', 'grid', ${J}, '2030-03-05T00:00:00Z', 'development')`,
  cortex_map: `INSERT INTO cortex_map (market, family, rule_version, fitted_at, params_json, active_set_hash,
    n_eff, pool, fit_split) VALUES ('AU', 'F1', 'v1', '2030-03-05T00:00:00Z', ${J}, 'h', 210.5, 'all', 'development')`,
  cortex_night: `INSERT INTO cortex_night (market, d, status, reason, manifest_id, universe_n, bars_n,
    feature_rows, runtime_ms, active_set_hash, map_fitted_at)
    VALUES ('AU', ${D}, 'ran', NULL, 'm1', 10, 10, 10, 5, 'h', NULL)`,
  cortex_decision: `INSERT INTO cortex_decision (market, d, book_id, code, arm, family, s, p, gate_trace_json,
    manifest_id) VALUES ('AU', ${D}, 'E01', 'ZZA', 'shadow', 'F7', 0.5, 0.6, '[]', 'm1')`,
  cortex_outcome: `INSERT INTO cortex_outcome (market, d, book_id, code, arm, fill_status, scored_at)
    VALUES ('AU', ${D}, 'E01', 'ZZA', 'live', 'unfilled', 't1')`,
  cortex_abstain: `INSERT INTO cortex_abstain (market, d, book_id, gate_id, label, detail_json)
    VALUES ('AU', ${D}, 'E01', 'G03_family_status', 'not yet allowed', ${J})`,
  family_status: `INSERT INTO family_status (market, family, since_d, status, evidence_json, set_by)
    VALUES ('AU', 'F1', ${D}, 'shadow', ${J}, 'import')`,
  cortex_state: `INSERT INTO cortex_state (market, code, kind, from_d, state, basis_json)
    VALUES ('AU', 'ZZA', 'halt', ${D}, 'halt', ${J})`,
  input_manifest: `INSERT INTO input_manifest (manifest_id, market, d, sources_json, schema_sha,
    row_counts_json, created_at) VALUES ('m1', 'AU', ${D}, '[]', 'sha', ${J}, 't0')`,
  label_validation: `INSERT INTO label_validation (validation_id, market, kind, result_json, created_at)
    VALUES ('v1', 'AU', 'paraphrase', ${J}, 't0')`,
  text_label: `INSERT INTO text_label (market, announcement_id, label_kind, model_id, produced_at, value,
    cited_span, manifest_id, validation_id) VALUES ('AU', 'a1', 'tone', 'mdl', 't0', 'up', NULL, 'm1', 'v1')`,
  opinion_track: `INSERT INTO opinion_track (market, opinion_id, kind, code, d, value_json)
    VALUES ('AU', 'o1', 'committee', 'ZZA', ${D}, ${J})`,
  cortex_statement: `INSERT INTO cortex_statement (statement_id, market, family, kind, text, numbers_json,
    n_eff_live, created_at) VALUES ('s1', 'AU', 'F1', 'allowed_weak', 'text', ${J}, NULL, 't0')`,
};
/** Insert order: label_validation before text_label (its insert guard). */
const ORDER = Object.keys(INSERTS).sort(
  (a, b) => Number(a === "text_label") - Number(b === "text_label"),
);

/** The tables whose primary key is the whole identity and that are append-only with no exception. */
const FULLY_APPEND_ONLY = ORDER.filter((t) => t !== "cortex_ledger_cell" && t !== "opinion_track");

const fails = async (db: Client, sql: string): Promise<string> => {
  try {
    await db.execute(sql);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`expected to fail: ${sql}`);
};

async function seeded(): Promise<Client> {
  const db = await freshDb("main");
  for (const t of ORDER) await db.execute(INSERTS[t]!);
  return db;
}

describe("migration 0019_cortex: apply, roll back, apply again", () => {
  it("creates exactly the Cortex tables, rolls back to the 0018 schema and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    for (const t of ORDER) expect(after.some((s) => s.startsWith(`table:${t}:`))).toBe(true);

    expect(await migrateDown(db, ms, 6)).toEqual({ rolledBack: 6, version: 18 });
    const mid = await schemaOf(db);
    for (const t of ORDER) expect(mid.some((s) => s.startsWith(`table:${t}:`))).toBe(false);
    expect(mid.join("\n")).not.toContain("limit_micro");

    expect(await migrateUp(db, ms)).toEqual({ applied: 6, version: 24 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("every new table is STRICT and WITHOUT ROWID with no unguarded UPDATE or DELETE", async () => {
    const db = await freshDb("main");
    for (const t of ORDER) {
      const r = await db.execute({
        sql: "SELECT sql FROM sqlite_master WHERE name = ?",
        args: [t],
      });
      const sql = String(r.rows[0]!.sql);
      expect(sql, t).toMatch(/STRICT, WITHOUT ROWID/);
      const trig = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
        args: [t],
      });
      const names = trig.rows.map((x) => String(x.name));
      expect(
        names.some((n) => n.endsWith("_no_delete")),
        `${t} delete guard`,
      ).toBe(true);
    }
  });
});

describe("append-only guards", () => {
  it.each(FULLY_APPEND_ONLY)("%s: one valid row, then UPDATE and DELETE abort", async (t) => {
    const db = await seeded();
    expect(Number((await db.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n)).toBe(1);
    const col = (
      await db.execute(`SELECT name FROM pragma_table_info('${t}') WHERE pk = 0 LIMIT 1`)
    ).rows[0]?.name;
    const pkcol = (
      await db.execute(`SELECT name FROM pragma_table_info('${t}') WHERE pk = 1 LIMIT 1`)
    ).rows[0]!.name;
    const target = String(col ?? pkcol);
    expect(await fails(db, `UPDATE ${t} SET ${target} = ${target}`)).toMatch(/append-only/);
    expect(await fails(db, `DELETE FROM ${t}`)).toMatch(/append-only/);
  });

  it("cortex_ledger_cell: DELETE aborts, and the result may be set once, from NULL", async () => {
    const db = await seeded();
    expect(await fails(db, "DELETE FROM cortex_ledger_cell")).toMatch(/append-only/);
    // nothing but the result may change
    expect(await fails(db, "UPDATE cortex_ledger_cell SET kind = 'x'")).toMatch(/set once/);
    expect(
      await fails(
        db,
        `UPDATE cortex_ledger_cell SET result_at = '2030-03-06T00:00:00Z', result_json = ${J}, kind = 'x'`,
      ),
    ).toMatch(/set once/);
    await db.execute(
      `UPDATE cortex_ledger_cell SET result_at = '2030-03-06T00:00:00Z', result_json = ${J}`,
    );
    // the result never changes again
    expect(
      await fails(db, "UPDATE cortex_ledger_cell SET result_at = '2030-03-07T00:00:00Z'"),
    ).toMatch(/set once/);
    expect(
      await fails(db, "UPDATE cortex_ledger_cell SET result_at = NULL, result_json = NULL"),
    ).toMatch(/set once/);
  });

  it("cortex_ledger_cell: the result must come after the log, and result_at and result_json go together", async () => {
    const db = await seeded();
    // same instant and earlier instant are refused (CHECK logged_at < result_at)
    expect(
      await fails(
        db,
        `UPDATE cortex_ledger_cell SET result_at = '2030-03-05T00:00:00Z', result_json = ${J}`,
      ),
    ).toMatch(/CHECK/);
    expect(
      await fails(
        db,
        `UPDATE cortex_ledger_cell SET result_at = '2030-03-04T00:00:00Z', result_json = ${J}`,
      ),
    ).toMatch(/CHECK/);
    expect(
      await fails(db, "UPDATE cortex_ledger_cell SET result_at = '2030-03-06T00:00:00Z'"),
    ).toMatch(/CHECK/);
    // a cell inserted with a result before its log is refused too
    expect(
      await fails(
        db,
        `INSERT INTO cortex_ledger_cell (cell_id, market, family, kind, spec_json, logged_at, result_at,
           result_json, split) VALUES ('c2', 'AU', 'F1', 'grid', ${J}, '2030-03-05T00:00:00Z',
           '2030-03-04T00:00:00Z', ${J}, 'validation')`,
      ),
    ).toMatch(/CHECK/);
  });

  it("opinion_track: DELETE aborts; settlement goes in once, from NULL, and nothing else changes", async () => {
    const db = await seeded();
    expect(await fails(db, "DELETE FROM opinion_track")).toMatch(/append-only/);
    expect(await fails(db, "UPDATE opinion_track SET code = 'ZZB'")).toMatch(/set once/);
    expect(await fails(db, `UPDATE opinion_track SET settled_d = ${D}`)).toMatch(/CHECK/);
    await db.execute(`UPDATE opinion_track SET settled_d = ${D}, outcome_json = ${J}`);
    expect(await fails(db, "UPDATE opinion_track SET settled_d = '2030-03-06'")).toMatch(
      /set once/,
    );
  });
});

describe("rules carried by the schema", () => {
  it("angle_passport: the primary key includes the version, status uses watch (D-304)", async () => {
    const db = await seeded();
    await db.execute(
      INSERTS.angle_passport!.replace("1, 1, 'momentum'", "2, 1, 'momentum'").replace(
        "'candidate'",
        "'watch'",
      ),
    );
    expect(await fails(db, INSERTS.angle_passport!)).toMatch(/UNIQUE|PRIMARY/);
    expect(
      await fails(
        db,
        INSERTS.angle_passport!.replace("'candidate'", "'watching'").replace("1, 1,", "3, 1,"),
      ),
    ).toMatch(/CHECK/);
    expect(
      await fails(
        db,
        INSERTS.angle_passport!.replace("'momentum'", "'value'").replace("1, 1,", "4, 1,"),
      ),
    ).toMatch(/CHECK/);
  });

  it("cortex_feature_daily: one row per code per night (a second row for the same code conflicts)", async () => {
    const db = await seeded();
    expect(await fails(db, INSERTS.cortex_feature_daily!)).toMatch(/UNIQUE|PRIMARY/);
    await db.execute(INSERTS.cortex_feature_daily!.replace("'ZZA'", "'ZZB'"));
    expect(
      await fails(db, INSERTS.cortex_feature_daily!.replace("'ZZA'", "'ZZC'").replace(J, "'x'")),
    ).toMatch(/CHECK/);
  });

  it("cortex_night: abstain_all needs a reason, ran has none; only the four reasons", async () => {
    const db = await seeded();
    const ins = (d: string, status: string, reason: string) =>
      `INSERT INTO cortex_night (market, d, status, reason, manifest_id, universe_n, bars_n, feature_rows,
         runtime_ms, active_set_hash) VALUES ('AU', '${d}', '${status}', ${reason}, 'm', 1, 1, 1, 1, 'h')`;
    await db.execute(ins("2030-03-06", "abstain_all", "'late_bar'"));
    await db.execute(ins("2030-03-07", "abstain_all", "'map_missing'"));
    expect(await fails(db, ins("2030-03-08", "abstain_all", "NULL"))).toMatch(/CHECK/);
    expect(await fails(db, ins("2030-03-08", "ran", "'quota'"))).toMatch(/CHECK/);
    expect(await fails(db, ins("2030-03-08", "abstain_all", "'tired'"))).toMatch(/CHECK/);
  });

  it("cortex_decision: F7 is shadow only; a live-arm F7 row is refused", async () => {
    const db = await seeded();
    expect(await fails(db, INSERTS.cortex_decision!.replace("'shadow'", "'live'"))).toMatch(
      /CHECK/,
    );
    await db.execute(
      INSERTS.cortex_decision!.replace("'shadow', 'F7'", "'live', 'F1'").replace("'ZZA'", "'ZZB'"),
    );
  });

  it("cortex_outcome: a filled outcome has its fill price and date", async () => {
    const db = await seeded();
    const ins = (cols: string) =>
      `INSERT INTO cortex_outcome (market, d, book_id, code, arm, fill_status, ${cols})`;
    expect(
      await fails(
        db,
        `${ins("scored_at")} VALUES ('AU', ${D}, 'E01', 'ZZB', 'live', 'filled', 't')`,
      ),
    ).toMatch(/CHECK/);
    await db.execute(
      `${ins("fill_micro, fill_d, scored_at")} VALUES ('AU', ${D}, 'E01', 'ZZB', 'live', 'filled', 5000000, ${D}, 't')`,
    );
  });

  it("family_status: an Owner kill can only suspend; F7 can never be allowed", async () => {
    const db = await seeded();
    const ins = (f: string, s: string, by: string, d = "2030-04-01") =>
      `INSERT INTO family_status (market, family, since_d, status, evidence_json, set_by)
       VALUES ('AU', '${f}', '${d}', '${s}', ${J}, '${by}')`;
    expect(await fails(db, ins("F1", "allowed", "owner_kill"))).toMatch(/CHECK/);
    expect(await fails(db, ins("F1", "shadow", "owner_kill"))).toMatch(/CHECK/);
    await db.execute(ins("F1", "suspended", "owner_kill"));
    expect(await fails(db, ins("F7", "allowed", "evaluator"))).toMatch(/CHECK/);
    await db.execute(ins("F7", "shadow", "evaluator"));
    await db.execute(ins("F2", "allowed", "evaluator"));
  });

  it("text_label: needs its validation row and a manifest id; the validation row is mandatory", async () => {
    const db = await freshDb("main");
    const label = (v: string, m: string) =>
      `INSERT INTO text_label (market, announcement_id, label_kind, model_id, produced_at, value,
         manifest_id, validation_id) VALUES ('AU', 'a1', 'tone', 'mdl', 't0', 'up', ${m}, ${v})`;
    // no validation row yet
    expect(await fails(db, label("'v1'", "'m1'"))).toMatch(/needs its label_validation/);
    // a NULL validation id is refused (by the guard or NOT NULL); a NULL manifest id is NOT NULL
    expect(await fails(db, label("NULL", "'m1'"))).toMatch(/NOT NULL|needs its label_validation/);
    await db.execute(INSERTS.label_validation!);
    expect(await fails(db, label("'v1'", "NULL"))).toMatch(/NOT NULL/);
    await db.execute(label("'v1'", "'m1'"));
    expect(await fails(db, label("'v1'", "''").replace("'t0'", "'t1'"))).toMatch(/CHECK/);
  });

  it("dates are real shapes and JSON columns hold valid JSON", async () => {
    const db = await freshDb("main");
    expect(await fails(db, INSERTS.cortex_abstain!.replace(D, "'30-03-05'"))).toMatch(/CHECK/);
    expect(await fails(db, INSERTS.cortex_abstain!.replace(J, "'{not json'"))).toMatch(/CHECK/);
    expect(await fails(db, INSERTS.cortex_statement!.replace(J, "'[1,'"))).toMatch(/CHECK/);
  });
});

describe("arena_order.limit_micro (CTX-028, D-288)", () => {
  const order = (id: string, extra = "") =>
    `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty${extra ? ", limit_micro" : ""})
     VALUES ('${id}', 'E01', ${D}, 'ZZ${id}', 'buy', 'entry', 10${extra ? `, ${extra}` : ""})`;

  it("is nullable (a v1 order), positive when set, and immutable once the order exists", async () => {
    const db = await freshDb("main");
    await db.execute(order("O1"));
    await db.execute(order("O2", "1250000"));
    expect(await fails(db, order("O3", "0"))).toMatch(/CHECK/);
    expect(await fails(db, order("O3", "-5"))).toMatch(/CHECK/);
    expect(
      Number(
        (await db.execute("SELECT COUNT(*) AS n FROM arena_order WHERE limit_micro IS NULL"))
          .rows[0]!.n,
      ),
    ).toBe(1);

    // the status step does not touch the limit; changing it in the same step is refused
    expect(
      await fails(
        db,
        "UPDATE arena_order SET status = 'cancelled', limit_micro = 9 WHERE id = 'O2'",
      ),
    ).toMatch(/immutable/);
    expect(
      await fails(
        db,
        "UPDATE arena_order SET status = 'cancelled', limit_micro = 9 WHERE id = 'O1'",
      ),
    ).toMatch(/immutable/);
    await db.execute("UPDATE arena_order SET status = 'cancelled' WHERE id = 'O2'");
    expect(
      (await db.execute("SELECT status, limit_micro FROM arena_order WHERE id = 'O2'")).rows[0],
    ).toMatchObject({ status: "cancelled", limit_micro: 1250000 });
  });

  it("down removes the column and restores the 0007 guard; up adds it back", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    await migrateDown(db, ms, 6);
    const cols = (await db.execute("PRAGMA table_info(arena_order)")).rows.map((c) =>
      String(c.name),
    );
    expect(cols).not.toContain("limit_micro");
    await db.execute(order("O1"));
    expect(
      await fails(db, "UPDATE arena_order SET status = 'cancelled', qty = 11 WHERE id = 'O1'"),
    ).toMatch(/immutable/);
    await migrateUp(db, ms);
    expect(
      (await db.execute("PRAGMA table_info(arena_order)")).rows.map((c) => String(c.name)),
    ).toContain("limit_micro");
  });
});

describe("source_register: FRED (DAT-101, D-291)", () => {
  it("is registered pending with its history row, no status row; down removes both; up restores", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const row = (await db.execute("SELECT * FROM source_register WHERE source = 'fred'")).rows[0]!;
    expect(row).toMatchObject({ status: "pending", risk: "low", owner_ref: null });
    expect(
      Number(
        (
          await db.execute(
            "SELECT COUNT(*) AS n FROM source_register_history WHERE source = 'fred'",
          )
        ).rows[0]!.n,
      ),
    ).toBe(1);
    expect(
      Number(
        (await db.execute("SELECT COUNT(*) AS n FROM source_status WHERE source = 'fred'")).rows[0]!
          .n,
      ),
    ).toBe(0);
    // the Yahoo row is unchanged: GSPC and VIX ride it (D-290), no new source
    expect(
      (await db.execute("SELECT status, owner_ref FROM source_register WHERE source = 'yahoo_eod'"))
        .rows[0],
    ).toMatchObject({ status: "pending", owner_ref: "O-26" });

    await migrateDown(db, ms, 6);
    expect(
      Number(
        (await db.execute("SELECT COUNT(*) AS n FROM source_register WHERE source = 'fred'"))
          .rows[0]!.n,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await db.execute(
            "SELECT COUNT(*) AS n FROM source_register_history WHERE source = 'fred'",
          )
        ).rows[0]!.n,
      ),
    ).toBe(0);
    // the register guards are back
    expect(await fails(db, "DELETE FROM source_register WHERE source = 'rba'")).toMatch(/forever/);
    expect(await fails(db, "DELETE FROM source_register_history")).toMatch(/append-only/);
    await migrateUp(db, ms);
    expect(
      Number(
        (
          await db.execute(
            "SELECT COUNT(*) AS n FROM source_register_history WHERE source = 'fred'",
          )
        ).rows[0]!.n,
      ),
    ).toBe(1);
  });
});
