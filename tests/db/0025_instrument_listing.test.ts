// @vitest-environment node
// Migration 0025_instrument_listing (should-fix batch A, V1-S7, D-690..D-694): applies, rolls back and
// comes back identical; the listing table is append-only and shape-checked; a delisted instrument can come
// back (delisted_on -> NULL) only when the universe import delisted it itself or the Owner decided.
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const fails = async (db: { execute: (s: string) => Promise<unknown> }, sql: string) => {
  try {
    await db.execute(sql);
    return "";
  } catch (e) {
    return String(e);
  }
};

describe("0025_instrument_listing", () => {
  it("rolls back (table and both triggers go) and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    const top = ms[ms.length - 1]!.version;
    expect(ms[top - 1]!.name).toBe("instrument_listing");
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: top - 1 });
    const names = (await db.execute("SELECT name FROM sqlite_master")).rows.map((r) =>
      String(r.name),
    );
    expect(names).not.toContain("instrument_listing");
    expect(names).not.toContain("instrument_no_revive");
    expect(names).toContain("instrument_guard_update");
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: top });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("the listing table is append-only, date-shaped and capped", async () => {
    const db = await freshDb("main");
    const ins = (listed: string, name = "N") =>
      `INSERT INTO instrument_listing (market, code, listed_on, name, decided_by, created_at)
       VALUES ('AU', 'ZZ01', '${listed}', '${name}', 'audit:1', 'x')`;
    await db.execute(ins("2027-01-06"));
    expect(await fails(db, ins("2027-01-06"))).toMatch(/UNIQUE/);
    expect(await fails(db, ins("06/01/2027"))).toMatch(/CHECK/);
    expect(await fails(db, ins("2027-02-01", "x".repeat(201)))).toMatch(/CHECK/);
    expect(await fails(db, "UPDATE instrument_listing SET name = 'Y'")).toMatch(/append-only/);
    expect(await fails(db, "DELETE FROM instrument_listing")).toMatch(/append-only/);
  });

  it("a delisted code returns only when auto-delisted or Owner-decided", async () => {
    const db = await freshDb("main");
    const seed = async (code: string, reason: string | null) => {
      await db.execute(
        `INSERT INTO instrument (market, code, name, listed_on, delisted_on, delist_reason)
         VALUES ('AU', '${code}', 'N', '2020-01-01', '2025-01-01', ${reason === null ? "NULL" : `'${reason}'`})`,
      );
    };
    const revive = (code: string) =>
      fails(db, `UPDATE instrument SET delisted_on = NULL WHERE code = '${code}'`);
    await seed("ZZ01", "absent_from_listed_companies");
    await seed("ZZ02", "relist_confirmed:audit:3:absent_from_listed_companies");
    await seed("ZZ03", "reuse_confirmed:audit:4:absent_from_listed_companies");
    await seed("ZZ04", "code_reuse_suspected:absent_from_listed_companies");
    await seed("ZZ05", null);
    await seed("ZZ06", "administration");
    expect(await revive("ZZ01")).toBe("");
    expect(await revive("ZZ02")).toBe("");
    expect(await revive("ZZ03")).toBe("");
    for (const c of ["ZZ04", "ZZ05", "ZZ06"])
      expect(await revive(c)).toMatch(/only an auto-delisted/);
    // delisting an active code and editing other columns is not touched
    await db.execute("UPDATE instrument SET name = 'M' WHERE code = 'ZZ04'");
    await db.execute("UPDATE instrument SET delisted_on = '2026-01-01' WHERE code = 'ZZ01'");
  });
});
