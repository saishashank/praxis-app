// @vitest-environment node
// Migration 0031_cortex_learning (D-923…): the learning loop's four tables; rolls back and comes back
// identical, the CHECK constraints hold and every table is append-only.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const TABLES = ["cortex_angle_day", "cortex_learn_compare", "cortex_learn_event", "cortex_leader"];

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
  it("creates the four tables, rolls back and comes back identical", async () => {
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

  it("every table is append-only", async () => {
    const db = await fresh();
    await db.execute(angleDay());
    await db.execute(compare());
    await db.execute(event());
    await db.execute(leader());
    for (const t of TABLES) {
      expect(await fails(db, `UPDATE ${t} SET market = 'AU'`)).toMatch(/append-only/);
      expect(await fails(db, `DELETE FROM ${t}`)).toMatch(/append-only/);
    }
  });
});
