// @vitest-environment node
// Migration 0031_cortex_learning (D-923…, O-81): the learning loop's six tables; rolls back and comes back
// identical, the CHECK constraints hold and every table is append-only.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const TABLES = [
  "cortex_angle_day",
  "cortex_learn_compare",
  "cortex_learn_event",
  "cortex_leader",
  "cortex_feature_probe",
  "cortex_base_version",
];

async function fresh(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl() }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  return db;
}

const angleDay = (over: Record<string, string> = {}) => {
  const v = {
    d: "'2026-11-10'",
    horizon: "1",
    feature_d: "'2026-11-09'",
    ic: "0.05",
    results_season: "0",
    psi: "1200",
    ...over,
  };
  return `INSERT INTO cortex_angle_day (market, d, angle_id, angle_version, horizon, feature_d, n, ic,
    top_excess_ppm, bottom_excess_ppm, base_ppm, regime, results_season, psi_ppm, excluded_news,
    active_set_hash, manifest_id) VALUES ('AU', ${v.d}, 'A-D1-01', 1, ${v.horizon}, ${v.feature_d}, 450,
    ${v.ic}, 1500, -900, 200, 'RISK-ON', ${v.results_season}, ${v.psi}, 2, 'h1', 'm1')`;
};

const compare = (over: Record<string, string> = {}) => {
  const v = {
    decision_d: "'2026-10-10'",
    family: "'F1'",
    agree: "1",
    matured_d: "'2026-11-10'",
    ...over,
  };
  return `INSERT INTO cortex_learn_compare (market, decision_d, family, book_id, fixed_rule_version,
    learner_rule_version, learner_generation, fixed_code, learner_code, agree, fixed_ret1_ppm,
    learner_ret1_ppm, fixed_ret20_ppm, learner_ret20_ppm, matured_d, regime) VALUES ('AU', ${v.decision_d},
    ${v.family}, 'B1', 'F1.v2-mom', 'F1.learn', 0, 'ZZA', 'ZZA', ${v.agree}, 10, 10, 200, 200,
    ${v.matured_d}, 'RISK-ON')`;
};

const event = (over: Record<string, string> = {}) => {
  const v = {
    seq: "0",
    kind: "'scorecard'",
    evidence: "'{}'",
    reverses: "NULL",
    expires: "NULL",
    family: "NULL",
    ...over,
  };
  return `INSERT INTO cortex_learn_event (market, d, seq, kind, family, angle_id, generation, evidence_json,
    words, reverses_seq, expires_d, created_at) VALUES ('AU', '2026-11-10', ${v.seq}, ${v.kind}, ${v.family},
    NULL, NULL, ${v.evidence}, 'words', ${v.reverses}, ${v.expires}, '2026-11-10T09:00:00.000Z')`;
};

const leader = (over: Record<string, string> = {}) => {
  const v = {
    since: "'2026-11-10'",
    leader: "'fixed'",
    rv: "NULL",
    gen: "NULL",
    set_by: "'evaluator'",
    ...over,
  };
  return `INSERT INTO cortex_leader (market, family, since_d, leader, learner_rule_version,
    learner_generation, evidence_json, set_by) VALUES ('AU', 'F1', ${v.since}, ${v.leader}, ${v.rv},
    ${v.gen}, '{}', ${v.set_by})`;
};

async function fails(db: Client, sql: string): Promise<string> {
  try {
    await db.execute(sql);
  } catch (e) {
    return String((e as Error).message);
  }
  return "";
}

describe("0031_cortex_learning", () => {
  it("creates the six tables, rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[30]).toMatchObject({ version: 31, name: "cortex_learning" });
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    for (const t of TABLES) expect(after.some((s) => s.startsWith(`table:${t}:`))).toBe(true);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 30 });
    const left = await schemaOf(db);
    for (const t of TABLES) expect(left.some((s) => s.includes(t))).toBe(false);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 31 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("cortex_angle_day: one row per angle, horizon and night; shapes checked", async () => {
    const db = await fresh();
    await db.execute(angleDay());
    expect(await fails(db, angleDay())).toMatch(/UNIQUE|PRIMARY/i);
    await db.execute(angleDay({ horizon: "20", feature_d: "'2026-10-13'" }));
    await db.execute(
      angleDay({ d: "'2026-11-11'", feature_d: "'2026-11-10'", ic: "NULL", psi: "NULL" }),
    );
    expect(await fails(db, angleDay({ d: "'2026-11-12'", horizon: "5" }))).toMatch(/CHECK/);
    expect(await fails(db, angleDay({ d: "'12 Nov'" }))).toMatch(/CHECK/);
    expect(await fails(db, angleDay({ d: "'2026-11-12'", feature_d: "'2026-11-12'" }))).toMatch(
      /CHECK/,
    );
    expect(await fails(db, angleDay({ d: "'2026-11-12'", ic: "1.5" }))).toMatch(/CHECK/);
    expect(await fails(db, angleDay({ d: "'2026-11-12'", results_season: "2" }))).toMatch(/CHECK/);
    expect(await fails(db, angleDay({ d: "'2026-11-12'", psi: "-1" }))).toMatch(/CHECK/);
  });

  it("cortex_learn_compare: matured after the decision night, known families only", async () => {
    const db = await fresh();
    await db.execute(compare());
    expect(await fails(db, compare())).toMatch(/UNIQUE|PRIMARY/i);
    expect(await fails(db, compare({ decision_d: "'2026-10-11'", family: "'F9'" }))).toMatch(
      /CHECK/,
    );
    expect(await fails(db, compare({ decision_d: "'2026-10-11'", agree: "3" }))).toMatch(/CHECK/);
    expect(await fails(db, compare({ decision_d: "'2026-11-10'" }))).toMatch(/CHECK/);
  });

  it("cortex_learn_event: closed kinds, valid JSON, a rollback names what it undoes, a cap expires", async () => {
    const db = await fresh();
    await db.execute(event());
    expect(await fails(db, event())).toMatch(/UNIQUE|PRIMARY/i);
    expect(await fails(db, event({ seq: "1", kind: "'promote'" }))).toMatch(/CHECK/);
    expect(await fails(db, event({ seq: "1", evidence: "'not json'" }))).toMatch(/CHECK/);
    expect(await fails(db, event({ seq: "1", kind: "'rollback'" }))).toMatch(/CHECK/);
    expect(await fails(db, event({ seq: "1", kind: "'cap'" }))).toMatch(/CHECK/);
    expect(await fails(db, event({ seq: "1", family: "'F0'" }))).toMatch(/CHECK/);
    await db.execute(event({ seq: "1", kind: "'rollback'", reverses: "0" }));
    await db.execute(event({ seq: "2", kind: "'cap'", expires: "'2026-11-24'" }));
  });

  it("cortex_leader: the learner needs its version; fallback and the Owner kill only hand back", async () => {
    const db = await fresh();
    await db.execute(leader());
    expect(await fails(db, leader({ since: "'2026-11-11'", leader: "'learner'" }))).toMatch(
      /CHECK/,
    );
    expect(
      await fails(
        db,
        leader({
          since: "'2026-11-11'",
          leader: "'learner'",
          rv: "'F1.learn'",
          gen: "3",
          set_by: "'owner_kill'",
        }),
      ),
    ).toMatch(/CHECK/);
    await db.execute(
      leader({ since: "'2026-11-12'", leader: "'learner'", rv: "'F1.learn'", gen: "3" }),
    );
    await db.execute(leader({ since: "'2026-11-13'", set_by: "'fallback'" }));
    expect(await fails(db, leader({ since: "'2026-11-14'", set_by: "'import'" }))).toMatch(/CHECK/);
  });

  it("cortex_learn_event: the base_change kind, and the (market, kind, d) index of the probe reader", async () => {
    const db = await fresh();
    await db.execute(event({ seq: "150", kind: "'base_change'", family: "'F1'" }));
    const idx = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cortex_learn_event'",
    );
    expect(idx.rows.map((r) => r.name)).toContain("cortex_learn_event_kind");
    const plan = await db.execute(
      `EXPLAIN QUERY PLAN SELECT * FROM cortex_learn_event INDEXED BY cortex_learn_event_kind
       WHERE market = 'AU' AND kind IN ('probe_open', 'probe_close') AND d <= '2026-11-10'`,
    );
    expect(JSON.stringify(plan.rows)).toMatch(/cortex_learn_event_kind/);
  });

  it("cortex_feature_probe: one value per code, angle and night; a value or a flag; prunable beyond retention", async () => {
    const db = await fresh();
    const today = new Date().toISOString().slice(0, 10);
    const probe = (d: string, code: string, value: string, flag: string) =>
      `INSERT INTO cortex_feature_probe (market, d, code, angle_id, value, flag, angle_version, manifest_id)
       VALUES ('AU', '${d}', '${code}', 'A-D2-07', ${value}, ${flag}, 2, 'm1')`;
    await db.execute(probe(today, "ZZA", "0.5", "NULL"));
    await db.execute(probe(today, "ZZB", "NULL", "'hot'"));
    await db.execute(probe(today, "ZZC", "NULL", "NULL"));
    expect(await fails(db, probe(today, "ZZA", "0.1", "NULL"))).toMatch(/UNIQUE|PRIMARY/i);
    expect(await fails(db, probe(today, "ZZD", "1.5", "NULL"))).toMatch(/CHECK/);
    expect(await fails(db, probe(today, "ZZE", "0.2", "'hot'"))).toMatch(/CHECK/);
    expect(await fails(db, probe("11 Nov", "ZZF", "0.2", "NULL"))).toMatch(/CHECK/);
    await db.execute(probe("2020-01-06", "ZZOLD", "0.1", "NULL"));
    expect(await fails(db, "DELETE FROM cortex_feature_probe WHERE code = 'ZZA'")).toMatch(
      /append-only/,
    );
    await db.execute("DELETE FROM cortex_feature_probe WHERE code = 'ZZOLD'");
    const left = await db.execute("SELECT code FROM cortex_feature_probe ORDER BY code");
    expect(left.rows.map((r) => r.code)).toEqual(["ZZA", "ZZB", "ZZC"]);
  });

  it("cortex_base_version: numbered versions, version 1 is the initial one, one measure per change", async () => {
    const db = await fresh();
    const base = (over: Record<string, string> = {}) => {
      const v = {
        version: "1",
        reason: "'initial'",
        added: "'[]'",
        removed: "'[]'",
        angles: "'[\"A-D1-11\"]'",
        family: "'F1'",
        ...over,
      };
      return `INSERT INTO cortex_base_version (market, family, version, since_d, reason, rule_version,
        angles_json, added_json, removed_json, evidence_json, created_at) VALUES ('AU', ${v.family}, ${v.version},
        '2026-11-10', ${v.reason}, 'F1.v2-mom', ${v.angles}, ${v.added}, ${v.removed}, '{}', 'now')`;
    };
    await db.execute(base());
    expect(await fails(db, base())).toMatch(/UNIQUE|PRIMARY/i);
    await db.execute(
      base({
        version: "2",
        reason: "'promote'",
        added: "'[\"A-D2-07\"]'",
        angles: '\'["A-D1-11","A-D2-07"]\'',
      }),
    );
    await db.execute(base({ version: "3", reason: "'retire'", removed: "'[\"A-D2-07\"]'" }));
    await db.execute(base({ version: "4", reason: "'owner_import'" }));
    expect(await fails(db, base({ version: "5", reason: "'initial'" }))).toMatch(/CHECK/);
    expect(await fails(db, base({ version: "5", reason: "'promote'" }))).toMatch(/CHECK/);
    expect(await fails(db, base({ version: "5", reason: "'retire'" }))).toMatch(/CHECK/);
    expect(await fails(db, base({ version: "5", reason: "'grow'" }))).toMatch(/CHECK/);
    expect(
      await fails(db, base({ version: "5", reason: "'owner_import'", angles: "'{}'" })),
    ).toMatch(/CHECK/);
    expect(await fails(db, base({ version: "0" }))).toMatch(/CHECK/);
    expect(await fails(db, base({ family: "'F9'" }))).toMatch(/CHECK/);
  });

  it("every table is append-only", async () => {
    const db = await fresh();
    await db.execute(angleDay());
    await db.execute(compare());
    await db.execute(event());
    await db.execute(leader());
    await db.execute(`INSERT INTO cortex_feature_probe (market, d, code, angle_id, value, flag, angle_version,
      manifest_id) VALUES ('AU', '${new Date().toISOString().slice(0, 10)}', 'ZZA', 'A-D2-07', 0.5, NULL, 2, 'm1')`);
    await db.execute(`INSERT INTO cortex_base_version (market, family, version, since_d, reason, rule_version,
      angles_json, added_json, removed_json, evidence_json, created_at) VALUES ('AU', 'F1', 1, '2026-11-10',
      'initial', 'F1.v2-mom', '[]', '[]', '[]', '{}', 'now')`);
    for (const t of TABLES) {
      expect(await fails(db, `UPDATE ${t} SET market = 'AU'`)).toMatch(/append-only/);
      expect(await fails(db, `DELETE FROM ${t}`)).toMatch(/append-only/);
    }
  });
});
