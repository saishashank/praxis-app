// @vitest-environment node
// Migration 0043_m23_research (M23 A1; D-1602, D-1603, D-1611, D-1650; AT-68 b, AT-32): eight append-only market-keyed
// tables with the two guard triggers each, and two insert triggers on `holdout_look`. No data row, no change to an
// existing table.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { marketTables } from "@/lib/maintenance/rowsByMarket";
// @ts-expect-error the generators are scripts (not typed)
import * as guardGen from "../../scripts/db/gen-market-guard.mjs";
// @ts-expect-error the helper is a script (not typed)
import { regionOf } from "../../scripts/db/regions.mjs";
import { readFileSync } from "node:fs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const { M23_MIGRATION_PATH, M23_REGION, M23_TABLES, m23Tables, renderM23Region } =
  guardGen as unknown as {
    M23_MIGRATION_PATH: string;
    M23_REGION: string;
    M23_TABLES: string[];
    m23Tables: () => Promise<string[]>;
    renderM23Region: () => string;
  };
const TABLES = [...M23_TABLES].sort();
const rows = async (sql: string) => (await db.execute(sql)).rows;
const count = async (sql: string) => Number((await rows(sql))[0]!.n);

const T = "'2030-01-02T00:00:00Z'";
const SHA = `'${"a".repeat(64)}'`;
const SHA2 = `'${"b".repeat(64)}'`;
/** A valid row of each table for a market. */
const ROW: Record<string, (m: string) => string> = {
  research_prereg: (m) =>
    `INSERT INTO research_prereg (lineage, market, item, frozen_json, sha, created_at) VALUES ('L1', '${m}', 'CXA-003', '{"h":1}', ${SHA}, ${T})`,
  holdout_look_refusal: (m) =>
    `INSERT INTO holdout_look_refusal (lineage, market, at, prereg_sha, caller) VALUES ('L1', '${m}', ${T}, ${SHA}, 'test')`,
  research_result: (m) =>
    `INSERT INTO research_result (lineage, market, looked_at, prereg_sha, n_setups, n_blocks, stats_json) VALUES ('L1', '${m}', ${T}, ${SHA}, 120, 30, '{"mean":1}')`,
  research_meter: (m) =>
    `INSERT INTO research_meter (market, lineage, d, n, target, projected_d, status, created_at) VALUES ('${m}', 'L1', '2030-01-02', 10, 30, NULL, 'collecting', ${T})`,
  residual_monitor: (m) =>
    `INSERT INTO residual_monitor (market, monitor, period, value_json, alarm, created_at) VALUES ('${m}', 3, '2030-Q1', '{"v":1}', 0, ${T})`,
  sector_index: (m) =>
    `INSERT INTO sector_index (market, d, group_code, weighting, ret_ppm, level_ppm, n_members, map_as_of, created_at) VALUES ('${m}', '2030-01-02', 'G1', 'equal', 1000, 1001000, 5, '2030-01-01', ${T})`,
  angle_proposal: (m) =>
    `INSERT INTO angle_proposal (proposal_id, market, month, kind, state, rule_json, orientation, created_at) VALUES (${SHA}, '${m}', '2030-01', 'angle', 'stored', '{"r":1}', 'long', ${T})`,
  shock_stop_outcome: (m) =>
    `INSERT INTO shock_stop_outcome (market, family, origin, d_entry, d_shock, base_net_ppm, tight_net_ppm, created_at) VALUES ('${m}', 'F1', 'o1', '2030-01-02', '2030-01-03', -5000, -2000, ${T})`,
};
const SET: Record<string, string> = {
  research_prereg: "item = 'CXA-004'",
  holdout_look_refusal: "caller = 'x'",
  research_result: "n_setups = 1",
  research_meter: "n = 11",
  residual_monitor: "alarm = 1",
  sector_index: "ret_ppm = 1",
  angle_proposal: "month = '2030-02'",
  shock_stop_outcome: "tight_net_ppm = 1",
};
const PREREG = (lineage: string, sha = SHA) =>
  `INSERT INTO research_prereg (lineage, market, item, frozen_json, sha, created_at) VALUES ('${lineage}', 'AU', 'CXA-003', '{"h":1}', ${sha}, ${T})`;
const LOOK = (lineage: string, verdict: string, sha = SHA, market = "AU") =>
  `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('${lineage}', '${market}', ${T}, ${sha}, '${verdict}')`;

describe("0043_m23_research", () => {
  it("is migration 43 and its generated guard region is current", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms).toHaveLength(43);
    expect(ms[42]).toMatchObject({ version: 43, name: "m23_research" });
    const text = readFileSync(M23_MIGRATION_PATH, "utf8");
    expect(regionOf(text, M23_REGION)).toBe(renderM23Region());
    expect(await m23Tables()).toEqual(TABLES);
    expect(TABLES).toHaveLength(8);
  });

  it("creates exactly the eight tables, no data row, and no table of an earlier migration is touched", async () => {
    const names = (await schemaOf(db)).join("\n");
    for (const t of TABLES) expect(names, t).toContain(`table:${t}:`);
    for (const t of TABLES) expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(0);
    const text = readFileSync(M23_MIGRATION_PATH, "utf8");
    expect(text).not.toMatch(/INSERT INTO/i);
    expect(text).not.toMatch(/ALTER TABLE/i);
    expect(text).not.toMatch(/OFFSET/i);
    const dropped = [...text.matchAll(/^DROP TABLE\s+(\w+);/gm)].map((m) => m[1]).sort();
    expect(dropped).toEqual(TABLES);
    const created = [...text.matchAll(/^CREATE TABLE\s+(\w+)/gm)].map((m) => m[1]).sort();
    expect(created).toEqual(TABLES);
    expect(await count("SELECT COUNT(*) n FROM holdout_look")).toBe(0);
  });

  it("every table is STRICT with both guard triggers and refuses IN and US", async () => {
    const trg = new Set(
      (
        await rows(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_market\\_guard\\_%' ESCAPE '\\'",
        )
      ).map((r) => String(r.name)),
    );
    for (const t of TABLES) {
      expect(
        String((await rows(`SELECT sql FROM sqlite_master WHERE name = '${t}'`))[0]!.sql),
        t,
      ).toMatch(/\) STRICT/);
      expect(trg.has(`${t}_market_guard_ins`), t).toBe(true);
      expect(trg.has(`${t}_market_guard_upd`), t).toBe(true);
      for (const m of ["IN", "US"]) {
        await expect(db.execute(ROW[t]!(m)), `${t} ${m}`).rejects.toThrow(
          new RegExp(`MarketNotEnabled ${t}\\b`),
        );
      }
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(0);
    }
    const all = (await marketTables(db))
      .map((x) => x.table)
      .filter((x) => x !== "market_row_count");
    for (const t of all) expect(trg.has(`${t}_market_guard_ins`), t).toBe(true);
  });

  it("AU inserts pass", async () => {
    for (const t of TABLES) {
      await db.execute(ROW[t]!("AU"));
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(1);
    }
  });

  it("all eight tables are append-only: UPDATE is refused, DELETE too", async () => {
    for (const t of TABLES) await db.execute(ROW[t]!("AU"));
    for (const t of TABLES) {
      await expect(db.execute(`UPDATE ${t} SET ${SET[t]}`), t).rejects.toThrow(/append-only/);
      await expect(db.execute(`DELETE FROM ${t}`), t).rejects.toThrow(/append-only/);
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(1);
    }
  });

  it("the primary keys refuse a repeat", async () => {
    for (const t of TABLES) {
      await db.execute(ROW[t]!("AU"));
      await expect(db.execute(ROW[t]!("AU")), t).rejects.toThrow(/UNIQUE|PRIMARY/);
    }
  });

  it("research_prereg: the item list, the 64-hex sha and the JSON limit are checked", async () => {
    await expect(
      db.execute(ROW.research_prereg!("AU").replace("CXA-003", "CXA-001")),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(ROW.research_prereg!("AU").replace(SHA, `'${"a".repeat(63)}'`)),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(ROW.research_prereg!("AU").replace(SHA, `'${"A".repeat(64)}'`)),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(ROW.research_prereg!("AU").replace('{"h":1}', "not json")),
    ).rejects.toThrow(/CHECK/);
    await db
      .execute({
        sql: ROW.research_prereg!("AU").replace("'{\"h\":1}'", "?"),
        args: [JSON.stringify({ x: "y".repeat(8000) })],
      })
      .then(
        () => {
          throw new Error("a 8000+ character text must be refused");
        },
        (e: Error) => expect(String(e)).toMatch(/CHECK/),
      );
    for (const item of [
      "CXA-003",
      "CXA-004",
      "CXA-008",
      "CXA-009",
      "CXA-011",
      "CXA-014",
      "VAL-118",
      "DAT-248",
      "VAL-121",
      "VAL-111",
      "M15",
    ]) {
      await db.execute(
        ROW.research_prereg!("AU").replace("'L1'", `'L-${item}'`).replace("CXA-003", item),
      );
    }
  });

  it("research_meter, residual_monitor, sector_index, angle_proposal: vocabularies and the stored/rule pairing", async () => {
    await expect(
      db.execute(ROW.research_meter!("AU").replace("'collecting'", "'x'")),
    ).rejects.toThrow(/CHECK/);
    for (const st of ["collecting", "met", "looked", "blocked"]) {
      await db.execute(
        ROW.research_meter!("AU")
          .replace("'collecting'", `'${st}'`)
          .replace(
            "'2030-01-02'",
            `'2030-02-0${["collecting", "met", "looked", "blocked"].indexOf(st) + 1}'`,
          ),
      );
    }
    await expect(db.execute(ROW.residual_monitor!("AU").replace(", 3,", ", 9,"))).rejects.toThrow(
      /CHECK/,
    );
    await expect(db.execute(ROW.residual_monitor!("AU").replace(", 3,", ", 0,"))).rejects.toThrow(
      /CHECK/,
    );
    await expect(
      db.execute(ROW.residual_monitor!("AU").replace("'2030-Q1'", "'2030-Q5'")),
    ).rejects.toThrow(/CHECK/);
    await db.execute(ROW.residual_monitor!("AU").replace("'2030-Q1'", "'cal-2030-01'"));
    await expect(
      db.execute(
        ROW.residual_monitor!("AU").replace(", 0,", ", 2,").replace("'2030-Q1'", "'2030-Q2'"),
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(db.execute(ROW.sector_index!("AU").replace("'equal'", "'cap'"))).rejects.toThrow(
      /CHECK/,
    );
    await db.execute(ROW.sector_index!("AU").replace("'equal'", "'value'"));
    // a stored proposal carries its rule; a refused one never does
    await expect(
      db.execute(ROW.angle_proposal!("AU").replace("'stored'", "'refused_schema'")),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(
        `INSERT INTO angle_proposal (proposal_id, market, month, kind, state, created_at) VALUES (${SHA2}, 'AU', '2030-01', 'angle', 'stored', ${T})`,
      ),
    ).rejects.toThrow(/CHECK/);
    for (const [i, st] of [
      "refused_schema",
      "refused_duplicate",
      "refused_weight",
      "refused_hostile",
    ].entries()) {
      await db.execute(
        `INSERT INTO angle_proposal (proposal_id, market, month, kind, state, created_at) VALUES ('${String(i).repeat(64)}', 'AU', '2030-01', 'challenger', '${st}', ${T})`,
      );
    }
    await expect(
      db.execute(ROW.angle_proposal!("AU").replace("'angle'", "'x'").replace(SHA, SHA2)),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute(ROW.angle_proposal!("AU").replace("'long'", "'short'").replace(SHA, SHA2)),
    ).rejects.toThrow(/CHECK/);
    await expect(db.execute(ROW.angle_proposal!("AU").replace(SHA, "'abc'"))).rejects.toThrow(
      /CHECK/,
    );
  });

  it("a look needs a research_prereg row with the same lineage, market and sha (hash first)", async () => {
    await expect(db.execute(LOOK("L9", "PASS"))).rejects.toThrow(/PreregistrationMissing/);
    await db.execute(PREREG("L9"));
    await expect(db.execute(LOOK("L9", "PASS", SHA2))).rejects.toThrow(/PreregistrationMissing/);
    await expect(db.execute(LOOK("L9", "PASS", SHA, "IN"))).rejects.toThrow(
      /MarketNotEnabled|PreregistrationMissing/,
    );
    await db.execute(LOOK("L9", "PASS"));
    expect(await count("SELECT COUNT(*) n FROM holdout_look WHERE lineage = 'L9'")).toBe(1);
    await expect(db.execute(LOOK("L9", "PASS"))).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it("the verdict must be PASS, NULL or INCONCLUSIVE", async () => {
    for (const [i, v] of ["PASS", "NULL", "INCONCLUSIVE"].entries()) {
      await db.execute(PREREG(`V${i}`));
      await db.execute(LOOK(`V${i}`, v));
    }
    await db.execute(PREREG("V9"));
    for (const bad of ["pass", "fail", "FAIL", "shadow", "null", "Inconclusive", ""]) {
      await expect(db.execute(LOOK("V9", bad)), bad).rejects.toThrow(/VerdictVocabulary/);
    }
    expect(await count("SELECT COUNT(*) n FROM holdout_look WHERE lineage = 'V9'")).toBe(0);
  });

  it("the three current writers keep working until the registry takes them over (D-1650)", async () => {
    // legacy words and no pre-registration row: the short shadow, the alternative regime, the Committee trial
    await db.execute(LOOK("short_shadow", "pass", "'abcdef0'"));
    await db.execute(LOOK("regime_altinputs", "fail", "'abcdef0'"));
    await db.execute(LOOK("committee_trial", "FAIL", "'abcdef0'"));
    expect(await count("SELECT COUNT(*) n FROM holdout_look")).toBe(3);
    // the exemption is the three lineages only
    await expect(db.execute(LOOK("short_shadow2", "PASS", "'abcdef0'"))).rejects.toThrow(
      /PreregistrationMissing/,
    );
  });

  it("holdout_look itself is unchanged: append-only, and its columns are the M20 ones", async () => {
    const cols = (await rows("SELECT name FROM pragma_table_info('holdout_look')")).map((r) =>
      String(r.name),
    );
    expect(cols).toEqual(["lineage", "market", "looked_at", "prereg_sha", "verdict"]);
    await db.execute(PREREG("L9"));
    await db.execute(LOOK("L9", "NULL"));
    await expect(db.execute("UPDATE holdout_look SET verdict = 'PASS'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM holdout_look")).rejects.toThrow(/append-only/);
  });

  it("every *_at column of a table is an ISO timestamp (CHECK)", async () => {
    for (const t of TABLES) {
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
    expect(await migrateDown(d2, ms, 1)).toEqual({ rolledBack: 1, version: 42 });
    const names = (await schemaOf(d2)).join("\n");
    for (const t of TABLES) expect(names).not.toContain(`table:${t}:`);
    expect(names).not.toContain("holdout_look_prereg_ins");
    expect(names).not.toContain("holdout_look_verdict_ins");
    expect(await migrateUp(d2, ms)).toEqual({ applied: 1, version: 43 });
    expect(await schemaOf(d2)).toEqual(after);
  });
});
