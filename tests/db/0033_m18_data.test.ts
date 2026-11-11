// @vitest-environment node
// Migration 0033_m18_data (M18 stream E1; D-972, D-973, D-974, D-975, D-978): code_history,
// source_fetch_status, macro_series, expert_call_outcome.early and the two DAT-253 register rows.
// Rolls back and comes back identical; the CHECKs hold; the register history is logged and removed.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const CODE = (event: string, d = "2030-01-02") =>
  `INSERT INTO code_history (market, code, event, first_d, last_d, runs) VALUES ('AU','ZZA','${event}','${d}','${d}',1)`;

describe("0033_m18_data", () => {
  it("rolls back and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[32]).toMatchObject({ version: 33, name: "m18_data" });
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    expect(await migrateDown(db, ms, 3)).toEqual({ rolledBack: 3, version: 32 });
    const left = await db.execute(
      "SELECT name FROM sqlite_master WHERE name IN ('code_history','source_fetch_status','macro_series')",
    );
    expect(left.rows).toHaveLength(0);
    const cols = await db.execute("SELECT name FROM pragma_table_info('expert_call_outcome')");
    expect(cols.rows.map((r) => String(r.name))).not.toContain("early");
    const reg = await db.execute(
      "SELECT source FROM source_register WHERE source IN ('asic_documents','ssrn_papers')",
    );
    expect(reg.rows).toHaveLength(0);
    expect(
      (
        await db.execute(
          "SELECT 1 FROM source_register_history WHERE source IN ('asic_documents','ssrn_papers')",
        )
      ).rows,
    ).toHaveLength(0);
    expect(await migrateUp(db, ms)).toEqual({ applied: 3, version: 35 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("code_history takes the three events, one open row per code and event start", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(CODE("not_found"));
    await db.execute(CODE("delisted"));
    await expect(db.execute(CODE("not_found"))).rejects.toThrow(); // primary key
    await expect(db.execute(CODE("gone"))).rejects.toThrow(); // event list
    await expect(db.execute(CODE("renamed", "2030-1-2"))).rejects.toThrow(); // date shape
    await expect(
      db.execute(
        "INSERT INTO code_history (market, code, event, first_d, last_d, runs) VALUES ('AU','ZZB','not_found','2030-01-02','2030-01-02',0)",
      ),
    ).rejects.toThrow(); // runs >= 1
    // mutable: the counters move and the row closes when the code reappears
    await db.execute(
      "UPDATE code_history SET runs = 3, last_d = '2030-01-04', closed_d = '2030-01-09' WHERE event = 'not_found'",
    );
    const r = await db.execute("SELECT runs FROM code_history WHERE event='not_found'");
    expect(Number(r.rows[0]!.runs)).toBe(3);
  });

  it("source_fetch_status counts failures and names a known cause", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    await db.execute(
      "INSERT INTO source_fetch_status (source, consecutive_failures, last_cause) VALUES ('asx_listed_companies', 2, 'server_error')",
    );
    await expect(
      db.execute("UPDATE source_fetch_status SET last_cause = 'boom'"),
    ).rejects.toThrow();
    await expect(
      db.execute("UPDATE source_fetch_status SET consecutive_failures = -1"),
    ).rejects.toThrow();
  });

  it("macro_series is keyed by source, series and day and only knows rba and abs", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    const ins = (source: string) =>
      `INSERT INTO macro_series (source, series_id, d, value_micro, fetched_at)
       VALUES ('${source}','FIRMMCRTD','2030-01-02', 4350000, '2030-01-03T00:00:00.000Z')`;
    await db.execute(ins("rba"));
    await expect(db.execute(ins("rba"))).rejects.toThrow();
    await expect(db.execute(ins("fred"))).rejects.toThrow();
  });

  it("expert_call_outcome.early defaults to 0 and is NOT NULL", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    const info = await db.execute(
      "SELECT dflt_value AS d, \"notnull\" AS nn FROM pragma_table_info('expert_call_outcome') WHERE name = 'early'",
    );
    expect(String(info.rows[0]!.d)).toBe("0");
    expect(Number(info.rows[0]!.nn)).toBe(1);
  });

  it("steelman_night.not_written_error defaults to 0, is NOT NULL, and goes with the roll-back", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const q =
      "SELECT dflt_value AS d, \"notnull\" AS nn FROM pragma_table_info('steelman_night') WHERE name = 'not_written_error'";
    const info = await db.execute(q);
    expect([String(info.rows[0]!.d), Number(info.rows[0]!.nn)]).toEqual(["0", 1]);
    await migrateDown(db, ms, 3);
    expect((await db.execute(q)).rows).toHaveLength(0);
  });

  it("the DAT-253 register rows are pending, logged,", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
    const r = await db.execute(
      "SELECT source, status FROM source_register WHERE source IN ('asic_documents','ssrn_papers') ORDER BY source",
    );
    expect(r.rows.map((x) => [String(x.source), String(x.status)])).toEqual([
      ["asic_documents", "pending"],
      ["ssrn_papers", "pending"],
    ]);
    const h = await db.execute(
      "SELECT op FROM source_register_history WHERE source IN ('asic_documents','ssrn_papers')",
    );
    expect(h.rows).toHaveLength(2);
  });
});
