// @vitest-environment node
// AT-32 complement proof for the M22 opinion tables (M22 A1, D-1426, D-1444; PRD-033, AT-68 b): the steelman's proof
// (tests/acceptance/v2/at32Steelman.test.ts) hashes the COMPLEMENT of a named own-set, so a table is covered the day a
// migration creates it. M22 extends that own-set by exactly eight tables (the Committee's, the promotion request, the
// MiniLM shadow, the alt-input regime reading and its points) and nothing else; every other table, the five other 0039
// tables included, stays in the hash. Three things are proved on the golden ZZ world of AT-32 (steelman stage off):
//   1. the own-set is exactly the steelman's own tables plus the eight, and every one of the eight exists and is excluded;
//   2. rows in the eight tables (what the M22 stages write) leave the dump of every other table, byte for byte, as it was,
//      and the combined hash equals the AT-32 baseline (read only; the baseline file is never rewritten);
//   3. the complement is not vacuous: a row in a hashed table (a control) changes exactly that table's hash.
// The stages themselves (Committee, MiniLM, regime reading) arrive with their tasks and write only into the eight
// tables; this file is the place where their on-versus-off worlds are added to `M22_STAGE_WRITERS`.
// Synthetic ZZ data only (SEC-110).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { committeeNight } from "@/lib/committee/night";
import { defaultAgentParams } from "@/lib/agents/params";
import { cleanupTempDbs } from "../../db/helpers";
import { committeeLlm, committeeProvider, KEYS as COMMITTEE_KEYS } from "../../committee/harness";
import { shadowNight } from "@/lib/llm/minilm/shadow";
import { fakeEmbedder, headOf, lockOf, withAnnouncements } from "../../llm/minilm/helpers";
import { STEELMAN_OWN, MIGRATION_OWNED, at32World, combineTables } from "./at32World";

vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

/** D-1426: the eight tables M22 adds to the own-set, exactly. */
const M22_OWN = [
  "committee_prereg",
  "committee_rating",
  "committee_call",
  "committee_trial_result",
  "opinion_promotion_request",
  "minilm_shadow",
  "regime_alt_reading",
  "alt_input_point",
] as const;

/** The five 0039 tables that are NOT in the own-set: they stay in the hash. */
const M22_HASHED = [
  "cluster_expression",
  "expert_call_confirm",
  "expert_call_proposal",
  "expert_poll_run",
  "expert_source_licence",
] as const;

const OWN = new Set<string>([...STEELMAN_OWN, ...M22_OWN]);

const WALLCLOCK: Record<string, readonly string[]> = {
  source_register_history: ["changed_at"],
  cortex_night: ["runtime_ms"],
};

type Dump = { perTable: Record<string, string>; rows: Record<string, number> };

/** The complement dump: every table except the own-set and the migration-owned ones. */
async function complementDump(db: Client): Promise<Dump> {
  const r = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const perTable: Record<string, string> = {};
  const rows: Record<string, number> = {};
  for (const name of r.rows.map((x) => String(x.name))) {
    if (OWN.has(name) || MIGRATION_OWNED.has(name)) continue;
    const skip = new Set(WALLCLOCK[name] ?? []);
    const cols = (await db.execute(`PRAGMA table_info(${name})`)).rows
      .map((c) => String(c.name))
      .filter((c) => !skip.has(c));
    const rs = await db.execute(
      `SELECT ${cols.join(", ")} FROM ${name} ORDER BY ${cols.map((_, i) => i + 1).join(", ")}`,
    );
    rows[name] = rs.rows.length;
    perTable[name] = sha(
      `${name}:${JSON.stringify(rs.rows.map((x) => cols.map((c) => String(x[c]))))}\n`,
    );
  }
  return { perTable, rows };
}

const TS = "2030-01-02T00:00:00Z";
const SHA = "a".repeat(64);
/**
 * What an M22 stage may write, one valid row per own table (AU, the only enabled market). Later tasks add their
 * stage's real run here (as a writer that is called on the "on" world); the proof then covers it.
 */
const M22_STAGE_WRITERS: Array<(db: Client) => Promise<void>> = [
  async (db) => {
    const sql = [
      `INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at) VALUES ('t1', 1, 'AU', '{}', '${SHA}', '${TS}')`,
      `INSERT INTO committee_rating (market, d, signal_id, trial_id, pack_id, rating, reasons_json, same_family, timings_json, created_at) VALUES ('AU', '2030-01-02', 's1', 't1', 'p1', 'approve', '[]', 0, '{}', '${TS}')`,
      `INSERT INTO committee_call (id, market, d, signal_id, stage, prompt_sha, pack_id, provider, model_id, model_version, params_json, raw_response, created_at, expires_d) VALUES ('c1', 'AU', '2030-01-02', 's1', 'judge', 'h', 'p1', 'prov', 'mod', 'v1', '{}', 'raw', '${TS}', '2999-01-01')`,
      `INSERT INTO committee_trial_result (trial_id, market, d, kind, verdict, stats_json, created_at) VALUES ('t1', 'AU', '2030-01-02', 'interim', 'running', '{}', '${TS}')`,
      `INSERT INTO opinion_promotion_request (market, kind, requested_d, evidence_json, created_at) VALUES ('AU', 'committee', '2030-01-02', '{}', '${TS}')`,
      `INSERT INTO minilm_shadow (market, d, source, ann_id, rule_category, model_category, rule_material, model_material, model_sha, created_at) VALUES ('AU', '2030-01-02', 's', 'a1', 'x', 'y', 0, 1, '${SHA}', '${TS}')`,
      `INSERT INTO regime_alt_reading (market, d, base_state, alt_state, inputs_status, inputs_json, created_at) VALUES ('AU', '2030-01-02', 'calm', 'cautious', 'unavailable', '{}', '${TS}')`,
      `INSERT INTO alt_input_point (source, event_key, d, prob_ppm, fetched_at) VALUES ('polymarket', 'ev1', '2030-01-02', 500000, '${TS}')`,
    ];
    for (const s of sql) await db.execute(s);
  },
  // C1: the real Committee night (mock providers) on the golden world: the newest session's top signal is rated; it writes
  // only committee_rating and committee_call (and an opinion_track row, which the steelman's own-set already excludes).
  async (db) => {
    const d = String(
      (await db.execute("SELECT MAX(d) AS d FROM signal WHERE market = 'AU'")).rows[0]!.d,
    );
    const res = await committeeNight(db, {
      market: "AU",
      d,
      today: d,
      llmParams: defaultAgentParams().llm,
      keys: { ...COMMITTEE_KEYS, shortlist: 1 },
      llm: committeeLlm([committeeProvider("alpha"), committeeProvider("beta")]),
      live: { R6: true, R7: true },
      now: TS,
      nowMs: () => 0,
      deadlineMs: Number.MAX_SAFE_INTEGER,
    });
    if (res.rated !== 1)
      throw new Error(`the Committee stage did not rate: ${JSON.stringify(res)}`);
  },
  // L5: the real MiniLM shadow stage (fake embedder) reads one ZZ announcement (the golden world has none, and its
  // announcement table is hashed, so the read is answered by a view) and writes only minilm_shadow.
  async (db) => {
    const r = await shadowNight(
      withAnnouncements(db, [
        { source: "zz", ann_id: "a9", type: null, title: "Quarterly update" },
      ]),
      {
        market: "AU",
        d: "2030-01-03",
        enabled: true,
        cap: 5,
        head: headOf(),
        lock: lockOf(),
        embedder: fakeEmbedder(),
        now: TS,
      },
    );
    if (r.written !== 1) throw new Error(`the MiniLM stage did not write: ${JSON.stringify(r)}`);
  },
];

describe("AT-32 (opinions): the M22 own-set and the complement proof (D-1426)", () => {
  it("the own-set is the steelman's own tables plus exactly the eight M22 tables", () => {
    expect([...M22_OWN].sort()).toEqual([
      "alt_input_point",
      "committee_call",
      "committee_prereg",
      "committee_rating",
      "committee_trial_result",
      "minilm_shadow",
      "opinion_promotion_request",
      "regime_alt_reading",
    ]);
    expect(OWN.size).toBe(STEELMAN_OWN.size + 8);
    for (const t of M22_OWN) expect(STEELMAN_OWN.has(t), t).toBe(false);
    for (const t of M22_HASHED) expect(OWN.has(t), `${t} stays hashed`).toBe(false);
  });

  it("rows in the eight own tables move no other table, and the combined hash equals the AT-32 baseline", async () => {
    const db = await at32World();
    const tables = (
      await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).rows.map((r) => String(r.name));
    for (const t of [...M22_OWN, ...M22_HASHED]) expect(tables, `${t} exists`).toContain(t);

    const before = await complementDump(db);
    // the five other 0039 tables are in the complement
    for (const t of M22_HASHED) expect(Object.keys(before.perTable), t).toContain(t);
    for (const t of M22_OWN) expect(Object.keys(before.perTable), t).not.toContain(t);
    // the world is not empty
    expect(before.rows.signal).toBeGreaterThan(0);
    expect(before.rows.decision_card).toBeGreaterThan(0);
    expect(before.rows.arena_order).toBeGreaterThan(0);
    for (const t of [...M22_OWN, ...M22_HASHED]) {
      expect(Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n), t).toBe(0);
    }

    // the AU world is byte-identical to the committed baseline (read only; the file is never rewritten)
    const base = JSON.parse(readFileSync(join(__dirname, "replay-hash.baseline.json"), "utf8")) as {
      at32: { hash: string; tables: Record<string, string> };
    };
    const baseNames = Object.keys(base.at32.tables).sort();
    expect(baseNames.filter((n) => before.perTable[n] !== base.at32.tables[n])).toEqual([]);
    expect(combineTables(before.perTable, baseNames)).toBe(base.at32.hash);

    // an M22 stage writes: the eight tables fill, the complement does not move
    for (const w of M22_STAGE_WRITERS) await w(db);
    for (const t of M22_OWN) {
      expect(
        Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n),
        t,
      ).toBeGreaterThanOrEqual(1);
    }
    // the real Committee run rated one signal and stored its four calls, beside the static rows
    const rated = await db.execute(
      "SELECT COUNT(*) n FROM committee_rating WHERE rating = 'approve' AND signal_id <> 's1'",
    );
    expect(Number(rated.rows[0]!.n)).toBe(1);
    expect(Number((await db.execute("SELECT COUNT(*) n FROM committee_call")).rows[0]!.n)).toBe(5);
    const after = await complementDump(db);
    expect(
      Object.keys(before.perTable).filter((t) => before.perTable[t] !== after.perTable[t]),
    ).toEqual([]);
    expect(after.rows).toEqual(before.rows);
    expect(combineTables(after.perTable, baseNames)).toBe(base.at32.hash);
  });

  it("is not vacuous: a row in a hashed 0039 table changes exactly that table's hash", async () => {
    const db = await at32World();
    const before = await complementDump(db);
    await db.execute(
      `INSERT INTO expert_poll_run (kind, d, counts_json, created_at) VALUES ('poll', '2030-01-02', '{"n":1}', '${TS}')`,
    );
    const after = await complementDump(db);
    expect(
      Object.keys(before.perTable).filter((t) => before.perTable[t] !== after.perTable[t]),
    ).toEqual(["expert_poll_run"]);
  });
});
