// @vitest-environment node
// Migration 0039_m22_llm_experts (M22 A1; D-1444, D-1426, D-1419, D-1435, D-1437; AT-68 b, AT-32): thirteen append-only
// tables, the eight market-keyed ones with the two guard triggers each. No data row, no change to an existing table.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { marketTables } from "@/lib/maintenance/rowsByMarket";
// @ts-expect-error the generators are scripts (not typed)
import * as guardGen from "../../scripts/db/gen-market-guard.mjs";
// @ts-expect-error the helper is a script (not typed)
import { regionOf } from "../../scripts/db/regions.mjs";
import { readFileSync } from "node:fs";
import {
  cleanupTempDbs,
  freshDb,
  MIGRATIONS,
  plantOffMarketRow,
  schemaOf,
  tempDbUrl,
  track,
} from "./helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const { M22_MIGRATION_PATH, M22_REGION, M22_TABLES, m22Tables, renderM22Region } =
  guardGen as unknown as {
    M22_MIGRATION_PATH: string;
    M22_REGION: string;
    M22_TABLES: string[];
    m22Tables: () => Promise<string[]>;
    renderM22Region: () => string;
  };
const GUARDED = [...M22_TABLES].sort();
const UNGUARDED = [
  "alt_input_point",
  "cluster_expression",
  "expert_call_confirm",
  "expert_poll_run",
  "expert_source_licence",
];
const ALL_NEW = [...GUARDED, ...UNGUARDED].sort();
const rows = async (sql: string) => (await db.execute(sql)).rows;
const count = async (sql: string) => Number((await rows(sql))[0]!.n);

const T = "'2030-01-02T00:00:00Z'";
const SHA = `'${"a".repeat(64)}'`;
const SHA2 = `'${"b".repeat(64)}'`;
/** A valid row of each guarded table for a market. */
const ROW: Record<string, (m: string) => string> = {
  committee_prereg: (m) =>
    `INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at) VALUES ('t1', 1, '${m}', '{"h":5}', ${SHA}, ${T})`,
  committee_rating: (m) =>
    `INSERT INTO committee_rating (market, d, signal_id, trial_id, pack_id, rating, reasons_json, same_family, timings_json, created_at) VALUES ('${m}', '2030-01-02', 's1', 't1', 'p1', 'approve', '["a"]', 0, '{}', ${T})`,
  committee_call: (m) =>
    `INSERT INTO committee_call (id, market, d, signal_id, stage, prompt_sha, pack_id, provider, model_id, model_version, params_json, raw_response, created_at, expires_d) VALUES ('c1', '${m}', '2030-01-02', 's1', 'bull', 'h', 'p1', 'prov', 'mod', 'v1', '{}', 'raw', ${T}, '2999-01-01')`,
  committee_trial_result: (m) =>
    `INSERT INTO committee_trial_result (trial_id, market, d, kind, verdict, stats_json, created_at) VALUES ('t1', '${m}', '2030-01-02', 'interim', 'running', '{}', ${T})`,
  opinion_promotion_request: (m) =>
    `INSERT INTO opinion_promotion_request (market, kind, requested_d, evidence_json, created_at) VALUES ('${m}', 'steelman', '2030-01-02', '{}', ${T})`,
  expert_call_proposal: (m) =>
    `INSERT INTO expert_call_proposal (proposal_id, claim_id, market, code, direction, call_d, horizon_sessions, price_basis, state, reason, source, created_at) VALUES (${SHA}, 'cl1', '${m}', 'ZZ1', 'long', '2030-01-02', 10, 'close', 'complete', 'ok', 'rules', ${T})`,
  minilm_shadow: (m) =>
    `INSERT INTO minilm_shadow (market, d, source, ann_id, rule_category, model_category, rule_material, model_material, model_sha, created_at) VALUES ('${m}', '2030-01-02', 's', 'a1', 'x', 'y', 0, 1, ${SHA}, ${T})`,
  regime_alt_reading: (m) =>
    `INSERT INTO regime_alt_reading (market, d, base_state, alt_state, inputs_status, inputs_json, created_at) VALUES ('${m}', '2030-01-02', 'calm', 'cautious', 'ok', '{}', ${T})`,
};
const CLAIM = (id = "cl1", type = "call") =>
  `INSERT INTO claim (id, type, testability, created_at) VALUES ('${id}', '${type}', 'testable_eod', ${T})`;
const CLUSTER = `INSERT INTO cluster (id, name, category, statement, testability, external_grade, created_at) VALUES ('k1', 'K', 'trend_momentum', 's', 'testable_eod', 'none', ${T})`;
const LICENCE = (at = T) =>
  `INSERT INTO expert_source_licence (expert_id, source_key, checked_at, robots, summarisation, status, actor) VALUES ('e1', 'site', ${at}, 'allows', 'yes', 'enabled', 'job')`;
const POLL = `INSERT INTO expert_poll_run (kind, d, counts_json, created_at) VALUES ('poll', '2030-01-02', '{"n":1}', ${T})`;
const CONFIRM = `INSERT INTO expert_call_confirm (claim_id, proposal_id, price_basis, confirmed_by, confirmed_at) VALUES ('cl1', ${SHA}, 'close', 'owner', ${T})`;
const EXPR_PARKED = `INSERT INTO cluster_expression (cluster_id, version, outcome, park_reason, reason_text, created_at) VALUES ('k1', 1, 'parked', 'blocked_data', 'no data', ${T})`;
const EXPR_OK = `INSERT INTO cluster_expression (cluster_id, version, outcome, rule_json, exit_json, reason_text, prereg_sha, created_at) VALUES ('k1', 2, 'expressed', '{"r":1}', '{"e":1}', 'ok', ${SHA}, ${T})`;
const ALT = `INSERT INTO alt_input_point (source, event_key, d, prob_ppm, fetched_at) VALUES ('polymarket', 'ev1', '2030-01-02', 500000, ${T})`;

/** One tracked expert (the licence rows point at it). */
async function insertExpert(): Promise<void> {
  await db.execute(
    `INSERT INTO expert (id, name, status, tier, created_at, updated_at) VALUES ('e1', 'Ex', 'tracked', 'core', ${T}, ${T})`,
  );
}

describe("0039_m22_llm_experts", () => {
  it("is migration 39 and its generated guard region is current", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms).toHaveLength(40);
    expect(ms[38]).toMatchObject({ version: 39, name: "m22_llm_experts" });
    const text = readFileSync(M22_MIGRATION_PATH, "utf8");
    expect(regionOf(text, M22_REGION)).toBe(renderM22Region());
    expect(await m22Tables()).toEqual(GUARDED);
    expect(GUARDED).toHaveLength(8);
    expect(ALL_NEW).toHaveLength(13);
    for (const t of UNGUARDED) expect(GUARDED).not.toContain(t);
  });

  it("creates exactly the thirteen tables, no data row, and no table of an earlier migration is touched", async () => {
    const names = (await schemaOf(db)).join("\n");
    for (const t of ALL_NEW) expect(names, t).toContain(`table:${t}:`);
    for (const t of ALL_NEW) expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(0);
    const text = readFileSync(M22_MIGRATION_PATH, "utf8");
    expect(text).not.toMatch(/INSERT INTO/i);
    expect(text).not.toMatch(/ALTER TABLE/i);
    const dropped = [...text.matchAll(/^DROP TABLE\s+(\w+);/gm)].map((m) => m[1]).sort();
    expect(dropped).toEqual(ALL_NEW);
    const created = [...text.matchAll(/^CREATE TABLE\s+(\w+)/gm)].map((m) => m[1]).sort();
    expect(created).toEqual(ALL_NEW);
  });

  it("every new table is STRICT; the eight market-keyed ones have both guard triggers and refuse IN and US", async () => {
    for (const t of ALL_NEW) {
      expect(
        String((await rows(`SELECT sql FROM sqlite_master WHERE name = '${t}'`))[0]!.sql),
        t,
      ).toMatch(/\) STRICT/);
    }
    const trg = new Set(
      (
        await rows(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_market\\_guard\\_%' ESCAPE '\\'",
        )
      ).map((r) => String(r.name)),
    );
    await db.execute(CLAIM());
    for (const t of GUARDED) {
      expect(trg.has(`${t}_market_guard_ins`), t).toBe(true);
      expect(trg.has(`${t}_market_guard_upd`), t).toBe(true);
      for (const m of ["IN", "US"]) {
        await expect(db.execute(ROW[t]!(m)), `${t} ${m}`).rejects.toThrow(
          new RegExp(`MarketNotEnabled ${t}\\b`),
        );
      }
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(0);
    }
    for (const t of UNGUARDED) expect(trg.has(`${t}_market_guard_ins`), t).toBe(false);
    const all = (await marketTables(db))
      .map((x) => x.table)
      .filter((x) => x !== "market_row_count");
    for (const t of all) expect(trg.has(`${t}_market_guard_ins`), t).toBe(true);
  });

  it("AU inserts pass; an IN row can be planted only through the enabled-market helper", async () => {
    await db.execute(CLAIM());
    for (const t of GUARDED) {
      await db.execute(ROW[t]!("AU"));
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(1);
    }
    await plantOffMarketRow(db, "minilm_shadow", {
      market: "IN",
      d: "2030-01-02",
      source: "s",
      ann_id: "a9",
      rule_category: "x",
      model_category: "y",
      rule_material: 0,
      model_material: 0,
      model_sha: "a".repeat(64),
      created_at: "2030-01-02T00:00:00Z",
    });
    expect(await count("SELECT COUNT(*) n FROM minilm_shadow WHERE market = 'IN'")).toBe(1);
  });

  it("all thirteen tables are append-only: UPDATE is refused, DELETE too (committee_call only before its expiry)", async () => {
    await db.execute(CLAIM());
    await insertExpert();
    await db.execute(CLUSTER);
    for (const t of GUARDED) await db.execute(ROW[t]!("AU"));
    for (const sql of [LICENCE(), POLL, CONFIRM, EXPR_PARKED, ALT]) await db.execute(sql);
    const SET: Record<string, string> = {
      committee_prereg: "version = 2",
      committee_rating: "rating = 'reject'",
      committee_call: "raw_response = 'x'",
      committee_trial_result: "verdict = 'PASS'",
      opinion_promotion_request: "kind = 'committee'",
      expert_source_licence: "status = 'no'",
      expert_poll_run: "counts_json = '{}'",
      expert_call_proposal: "state = 'incomplete'",
      expert_call_confirm: "price_basis = 'open'",
      cluster_expression: "reason_text = 'x'",
      minilm_shadow: "model_material = 0",
      regime_alt_reading: "alt_state = 'calm'",
      alt_input_point: "prob_ppm = 1",
    };
    expect(Object.keys(SET).sort()).toEqual(ALL_NEW);
    for (const [t, set] of Object.entries(SET)) {
      await expect(db.execute(`UPDATE ${t} SET ${set}`), t).rejects.toThrow(/append-only/);
      await expect(db.execute(`DELETE FROM ${t}`), t).rejects.toThrow(/append-only/);
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(1);
    }
  });

  it("committee_call is deletable only once expires_d is in the past (the prune rule)", async () => {
    await db.execute(ROW.committee_call!("AU")); // expires 2999
    await expect(db.execute("DELETE FROM committee_call")).rejects.toThrow(
      /delete only after expiry/,
    );
    await db.execute(
      ROW.committee_call!("AU").replace("'c1'", "'c2'").replace("'2999-01-01'", "'2000-01-01'"),
    );
    await expect(db.execute("DELETE FROM committee_call WHERE id = 'c1'")).rejects.toThrow();
    await db.execute("DELETE FROM committee_call WHERE id = 'c2'");
    expect(await count("SELECT COUNT(*) n FROM committee_call")).toBe(1);
    await expect(db.execute("UPDATE committee_call SET expires_d = '2000-01-01'")).rejects.toThrow(
      /append-only/,
    );
    // the raw response is capped at 8000 characters and the stage list is closed
    await expect(
      db.execute({
        sql: ROW.committee_call!("AU").replace("'c1'", "'c3'").replace("'raw'", "?"),
        args: ["x".repeat(8001)],
      }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(ROW.committee_call!("AU").replace("'c1'", "'c4'").replace("'bull'", "'coach'")),
    ).rejects.toThrow(/CHECK/);
    for (const s of ["bear", "risk", "judge"]) {
      await db.execute(
        ROW.committee_call!("AU").replace("'c1'", `'s${s}'`).replace("'bull'", `'${s}'`),
      );
    }
  });

  it("committee_rating: rating list, at most five reasons, same_family, one row per market, day and signal", async () => {
    await db.execute(ROW.committee_rating!("AU"));
    await expect(db.execute(ROW.committee_rating!("AU"))).rejects.toThrow(/UNIQUE|PRIMARY/);
    const next = (n: number) => ROW.committee_rating!("AU").replace("'s1'", `'s${n}'`);
    const reasons = (sql: string, list: string) => sql.replace(`'["a"]'`, `'${list}'`);
    const ratings = [
      "neutral",
      "reject",
      "skipped_budget",
      "skipped_time",
      "skipped_models",
      "failed",
    ];
    for (const [i, r] of ratings.entries()) {
      await db.execute(next(10 + i).replace("'approve'", `'${r}'`));
    }
    await expect(db.execute(next(30).replace("'approve'", "'maybe'"))).rejects.toThrow(/CHECK/);
    await expect(db.execute(reasons(next(31), '["a","b","c","d","e","f"]'))).rejects.toThrow(
      /CHECK/,
    );
    await db.execute(reasons(next(32), '["a","b","c","d","e"]'));
    await expect(db.execute(reasons(next(33), "{}"))).rejects.toThrow(/CHECK/);
    await expect(db.execute(next(34).replace("0, '{}'", "2, '{}'"))).rejects.toThrow(/CHECK/);
    await expect(db.execute(next(35).replace(T, "'yesterday'"))).rejects.toThrow(/CHECK/);
  });

  it("committee_prereg is one row per trial and version, with a 64-hex sha; trial result kinds and verdicts are closed", async () => {
    await db.execute(ROW.committee_prereg!("AU"));
    await expect(db.execute(ROW.committee_prereg!("AU"))).rejects.toThrow(/UNIQUE|PRIMARY/);
    await db.execute(ROW.committee_prereg!("AU").replace("'t1', 1,", "'t1', 2,"));
    await expect(db.execute(ROW.committee_prereg!("AU").replace(SHA, "'abc'"))).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      db.execute(
        ROW.committee_prereg!("AU").replace("'t1', 1,", "'t1', 3,").replace("'{\"h\":5}'", "'[]'"),
      ),
    ).rejects.toThrow(/CHECK/);
    await db.execute(ROW.committee_trial_result!("AU"));
    for (const v of ["PASS", "FAIL", "INCONCLUSIVE", "INVALID"]) {
      await db.execute(
        ROW.committee_trial_result!("AU")
          .replace("'interim', 'running'", `'final', '${v}'`)
          .replace("'t1'", `'t${v}'`),
      );
    }
    await expect(
      db.execute(
        ROW.committee_trial_result!("AU").replace("'running'", "'done'").replace("'t1'", "'t9'"),
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(
        ROW.committee_trial_result!("AU").replace("'interim'", "'weekly'").replace("'t1'", "'t9'"),
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it("opinion_promotion_request: one per market and kind, ever; the kind list is closed", async () => {
    await db.execute(ROW.opinion_promotion_request!("AU"));
    await expect(db.execute(ROW.opinion_promotion_request!("AU"))).rejects.toThrow(
      /UNIQUE|PRIMARY/,
    );
    await db.execute(ROW.opinion_promotion_request!("AU").replace("'steelman'", "'committee'"));
    await expect(
      db.execute(ROW.opinion_promotion_request!("AU").replace("'steelman'", "'reflection'")),
    ).rejects.toThrow(/CHECK/);
  });

  it("expert_source_licence: the expert must exist; the value lists and the note are checked; a re-check is a new row", async () => {
    await expect(db.execute(LICENCE())).rejects.toThrow(/expert must exist/);
    await insertExpert();
    await db.execute(LICENCE());
    await expect(db.execute(LICENCE())).rejects.toThrow(/UNIQUE|PRIMARY/);
    await db.execute(LICENCE("'2030-02-01T00:00:00Z'"));
    const ok = (day: string) => LICENCE(`'2031-${day}T00:00:00Z'`);
    for (const bad of [
      ok("01-01").replace("'allows'", "'maybe'"),
      ok("01-02").replace("'yes'", "'sometimes'"),
      ok("01-03").replace("'enabled'", "'on'"),
      ok("01-04").replace("'job')", "'bot')"),
    ]) {
      await expect(db.execute(bad), bad).rejects.toThrow(/CHECK/);
    }
    for (const [i, s] of ["unchecked", "owner-accepted-risk", "no"].entries()) {
      await db.execute(ok(`02-0${i + 1}`).replace("'enabled'", `'${s}'`));
    }
    for (const [i, r] of ["disallows", "absent", "unreachable"].entries()) {
      await db.execute(ok(`03-0${i + 1}`).replace("'allows'", `'${r}'`));
    }
    await expect(
      db.execute({
        sql: ok("04-01").replace("actor)", "actor, note)").replace("'job')", "'job', ?)"),
        args: ["x".repeat(201)],
      }),
    ).rejects.toThrow(/CHECK/);
    const idx = (
      await rows("SELECT name FROM pragma_index_info('idx_expert_source_licence_source')")
    ).map((r) => String(r.name));
    expect(idx).toEqual(["source_key", "checked_at"]);
  });

  it("expert_poll_run is one row per kind and day; the kind list is closed", async () => {
    await db.execute(POLL);
    await expect(db.execute(POLL)).rejects.toThrow(/UNIQUE|PRIMARY/);
    for (const k of ["discovery", "licence"]) await db.execute(POLL.replace("'poll'", `'${k}'`));
    await expect(db.execute(POLL.replace("'poll'", "'sweep'"))).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(POLL.replace("'{\"n\":1}'", "'[]'").replace("'2030-01-02'", "'2030-01-03'")),
    ).rejects.toThrow(/CHECK/);
  });

  it("expert_call_proposal: needs a claim of type call; a complete proposal needs code, direction, date and horizon", async () => {
    await expect(db.execute(ROW.expert_call_proposal!("AU"))).rejects.toThrow(/claim of type call/);
    await db.execute(CLAIM("cm1", "method"));
    await expect(
      db.execute(ROW.expert_call_proposal!("AU").replace("'cl1'", "'cm1'")),
    ).rejects.toThrow(/claim of type call/);
    await db.execute(CLAIM());
    await db.execute(ROW.expert_call_proposal!("AU"));
    const base = (n: string) => ROW.expert_call_proposal!("AU").replace(SHA, `'${n.repeat(64)}'`);
    // complete without one of the four is refused
    await expect(db.execute(base("1").replace("'ZZ1'", "NULL"))).rejects.toThrow(/CHECK/);
    await expect(db.execute(base("2").replace("'long'", "NULL"))).rejects.toThrow(/CHECK/);
    await expect(db.execute(base("3").replace("'2030-01-02', 10", "NULL, 10"))).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      db.execute(base("4").replace("'2030-01-02', 10", "'2030-01-02', NULL")),
    ).rejects.toThrow(/CHECK/);
    // incomplete and not_trackable carry none of them
    for (const [n, s] of [
      ["5", "incomplete"],
      ["6", "not_trackable"],
    ] as const) {
      await db.execute(
        base(n)
          .replace("'ZZ1', 'long', '2030-01-02', 10", "NULL, NULL, NULL, NULL")
          .replace("'complete'", `'${s}'`),
      );
    }
    for (const bad of [
      base("7").replace("'long'", "'flat'"),
      base("8").replace("'close'", "'vwap'"),
      base("9").replace("'rules'", "'guess'"),
      base("c").replace("'complete'", "'maybe'"),
      base("d").replace(", 10,", ", 0,"),
      ROW.expert_call_proposal!("AU").replace(SHA, "'XYZ'"),
      ROW.expert_call_proposal!("AU").replace(SHA, `'${"G".repeat(64)}'`),
    ]) {
      await expect(db.execute(bad), bad).rejects.toThrow(/CHECK/);
    }
  });

  it("expert_call_confirm: the proposal exists, is complete and names the claim; one per claim", async () => {
    await db.execute(CLAIM());
    await expect(db.execute(CONFIRM)).rejects.toThrow(/complete proposal/);
    await db.execute(
      ROW.expert_call_proposal!("AU")
        .replace(SHA, SHA2)
        .replace("'ZZ1', 'long', '2030-01-02', 10", "NULL, NULL, NULL, NULL")
        .replace("'complete'", "'incomplete'"),
    );
    await expect(db.execute(CONFIRM.replace(SHA, SHA2))).rejects.toThrow(/complete proposal/);
    await db.execute(ROW.expert_call_proposal!("AU"));
    await db.execute(CLAIM("cl2"));
    await expect(db.execute(CONFIRM.replace("'cl1'", "'cl2'"))).rejects.toThrow(
      /complete proposal/,
    );
    await expect(db.execute(CONFIRM.replace("'close'", "'unspecified'"))).rejects.toThrow(/CHECK/);
    await db.execute(CONFIRM);
    await expect(db.execute(CONFIRM)).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it("cluster_expression: the cluster must exist; expressed needs rule, exit and sha, parked needs a reason (CHECK)", async () => {
    await expect(db.execute(EXPR_PARKED)).rejects.toThrow(/cluster must exist/);
    await db.execute(CLUSTER);
    await db.execute(EXPR_PARKED);
    await db.execute(EXPR_OK);
    await expect(db.execute(EXPR_OK)).rejects.toThrow(/UNIQUE|PRIMARY/);
    const e = (v: number) => EXPR_OK.replace(", 2, 'expressed'", `, ${v}, 'expressed'`);
    await expect(db.execute(e(3).replace("'{\"r\":1}'", "NULL"))).rejects.toThrow(/CHECK/);
    await expect(db.execute(e(4).replace("'{\"e\":1}'", "NULL"))).rejects.toThrow(/CHECK/);
    await expect(db.execute(e(5).replace(`, ${SHA},`, ", NULL,"))).rejects.toThrow(/CHECK/);
    await expect(db.execute(e(6).replace("'expressed'", "'parked'"))).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(EXPR_PARKED.replace(", 1,", ", 7,").replace("'blocked_data'", "NULL")),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(EXPR_PARKED.replace(", 1,", ", 8,").replace("'blocked_data'", "'lazy'")),
    ).rejects.toThrow(/CHECK/);
    const reasons = [
      "needs_intraday",
      "discretionary",
      "overlay_only",
      "duplicate",
      "not_testable",
    ];
    for (const [i, r] of reasons.entries()) {
      await db.execute(
        EXPR_PARKED.replace(", 1,", `, ${10 + i},`).replace("'blocked_data'", `'${r}'`),
      );
    }
    await expect(
      db.execute({
        sql: EXPR_PARKED.replace(", 1,", ", 20,").replace("'no data'", "?"),
        args: ["x".repeat(201)],
      }),
    ).rejects.toThrow(/CHECK/);
  });

  it("minilm_shadow, regime_alt_reading and alt_input_point: keys, value lists and ranges", async () => {
    await db.execute(ROW.minilm_shadow!("AU"));
    await expect(db.execute(ROW.minilm_shadow!("AU"))).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(
      db.execute(ROW.minilm_shadow!("AU").replace("'a1'", "'a2'").replace("0, 1,", "2, 1,")),
    ).rejects.toThrow(/CHECK/);
    await db.execute(ROW.regime_alt_reading!("AU"));
    await expect(db.execute(ROW.regime_alt_reading!("AU"))).rejects.toThrow(/UNIQUE|PRIMARY/);
    for (const [i, s] of ["partial", "unavailable"].entries()) {
      await db.execute(
        ROW.regime_alt_reading!("AU")
          .replace("'2030-01-02'", `'2030-01-0${i + 3}'`)
          .replace("'ok'", `'${s}'`),
      );
    }
    await expect(
      db.execute(
        ROW.regime_alt_reading!("AU")
          .replace("'2030-01-02'", "'2030-01-20'")
          .replace("'ok'", "'bad'"),
      ),
    ).rejects.toThrow(/CHECK/);
    await db.execute(ALT);
    await expect(db.execute(ALT)).rejects.toThrow(/UNIQUE|PRIMARY/);
    await db.execute(ALT.replace("'polymarket'", "'kalshi'").replace("500000", "1000000"));
    await db.execute(ALT.replace("'ev1'", "'ev2'").replace("500000", "0"));
    await expect(
      db.execute(ALT.replace("'ev1'", "'ev3'").replace("500000", "1000001")),
    ).rejects.toThrow(/CHECK/);
    await expect(db.execute(ALT.replace("'ev1'", "'ev4'").replace("500000", "-1"))).rejects.toThrow(
      /CHECK/,
    );
    await expect(db.execute(ALT.replace("'polymarket'", "'manifold'"))).rejects.toThrow(/CHECK/);
    expect(
      String((await rows("SELECT sql FROM sqlite_master WHERE name = 'alt_input_point'"))[0]!.sql),
    ).not.toMatch(/\bmarket\b/);
  });

  it("every *_at column of a guarded table is an ISO timestamp (CHECK)", async () => {
    await db.execute(CLAIM());
    for (const t of GUARDED) {
      const sql = ROW[t]!("AU").replace(T, "'yesterday'");
      expect(sql, t).toContain("'yesterday'");
      await expect(db.execute(sql), t).rejects.toThrow(/CHECK/);
    }
  });

  it("rolls back and comes back identical", async () => {
    const d2 = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(d2, ms);
    const after = await schemaOf(d2);
    expect(await migrateDown(d2, ms, 2)).toEqual({ rolledBack: 2, version: 38 });
    const names = (await schemaOf(d2)).join("\n");
    for (const t of ALL_NEW) expect(names).not.toContain(`table:${t}:`);
    expect(await migrateUp(d2, ms)).toEqual({ applied: 2, version: 40 });
    expect(await schemaOf(d2)).toEqual(after);
  });
});
