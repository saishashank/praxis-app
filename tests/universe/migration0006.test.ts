// @vitest-environment node
// Main DB migration 0006_universe_import (M2 T11, D-067): up/down, the new instrument columns,
// the seeded `asx_listed_companies` register row (pending, O-23), guards restored after down.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { AU_COLUMNS, UNIVERSE_SOURCE } from "@/lib/data/schema";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf } from "../db/helpers";

afterEach(cleanupTempDbs);

const one = async (db: Client, sql: string) => (await db.execute(sql)).rows[0];
const cols = async (db: Client) =>
  (await db.execute("PRAGMA table_info(instrument)")).rows.map((r) => String(r.name));

describe("main migration 0006_universe_import", () => {
  it("is the sixth main migration", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[5]).toMatchObject({ version: 6, name: "universe_import" });
  });

  it("adds industry and missing_count to instrument (schema.ts lists them in table order)", async () => {
    const db = await freshDb("main");
    expect(await cols(db)).toEqual([...AU_COLUMNS.instrument]);
    expect(AU_COLUMNS.instrument.slice(-3)).toEqual(["industry", "missing_count", "sector"]); // sector: main 0011
    await db.execute(
      "INSERT INTO instrument (market, code, name) VALUES ('AU', 'ZZAA', 'Synthetic')",
    );
    expect(await one(db, "SELECT industry, missing_count FROM instrument")).toMatchObject({
      industry: null,
      missing_count: 0,
    });
  });

  it("seeds the listed-companies register row as pending under O-23, with a history row", async () => {
    const db = await freshDb("main");
    expect(UNIVERSE_SOURCE).toBe("asx_listed_companies");
    expect(
      await one(db, `SELECT * FROM source_register WHERE source = '${UNIVERSE_SOURCE}'`),
    ).toMatchObject({
      status: "pending",
      risk: "high",
      owner_ref: "O-23b", // 0018 (DAT-236) re-cites the file under its own terms
      summarisation_permitted: 0,
    });
    expect(
      await one(
        db,
        `SELECT COUNT(*) AS n FROM source_register_history WHERE source = '${UNIVERSE_SOURCE}'`,
      ),
    ).toMatchObject({ n: 2 }); // the insert (0006) and the 0018 update
    // No kill-switch row: the rate token uses asx_announcements.
    expect(
      await one(db, `SELECT COUNT(*) AS n FROM source_status WHERE source = '${UNIVERSE_SOURCE}'`),
    ).toMatchObject({ n: 0 });
  });

  it("the identity guard still protects id, market and code; status columns may change", async () => {
    const db = await freshDb("main");
    await db.execute(
      "INSERT INTO instrument (market, code, name) VALUES ('AU', 'ZZAA', 'Synthetic')",
    );
    await expect(db.execute("UPDATE instrument SET code = 'ZZBB'")).rejects.toThrow(/immutable/);
    await db.execute("UPDATE instrument SET industry = 'Banks', missing_count = 1");
    await expect(db.execute("DELETE FROM instrument")).rejects.toThrow(/forever table/);
  });

  it("down removes the columns and the register row (and its history); the guards are back; up restores everything", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    const before = await schemaOf(db);
    const regBefore = (await db.execute("SELECT * FROM source_register ORDER BY source")).rows.map(
      (r) => ({ ...r }),
    );
    expect(await migrateDown(db, ms, 17)).toEqual({ rolledBack: 17, version: 5 });
    expect(await cols(db)).not.toContain("industry");
    expect(await cols(db)).not.toContain("missing_count");
    expect(
      await one(
        db,
        `SELECT COUNT(*) AS n FROM source_register WHERE source = '${UNIVERSE_SOURCE}'`,
      ),
    ).toMatchObject({ n: 0 });
    expect(
      await one(
        db,
        `SELECT COUNT(*) AS n FROM source_register_history WHERE source = '${UNIVERSE_SOURCE}'`,
      ),
    ).toMatchObject({ n: 0 });
    // The forever / append-only guards are back with their 0004 definitions.
    await expect(db.execute("DELETE FROM source_register")).rejects.toThrow(/forever table/);
    await expect(db.execute("DELETE FROM source_register_history")).rejects.toThrow(/append-only/);

    expect(await migrateUp(db, ms)).toEqual({ applied: 17, version: 22 });
    expect(await schemaOf(db)).toEqual(before);
    expect(
      (await db.execute("SELECT * FROM source_register ORDER BY source")).rows.map((r) => ({
        ...r,
      })),
    ).toEqual(regBefore);
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 22 });
  });

  it("down keeps instruments that were already imported (only the two columns go)", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    await db.execute(
      "INSERT INTO instrument (market, code, name, industry) VALUES ('AU', 'ZZAA', 'Synthetic', 'Banks')",
    );
    await migrateDown(db, ms, 16); // 0017, 0016, 0015, 0014, 0013, 0012, 0011, 0010, 0009, 0008, 0007 then 0006
    expect(await one(db, "SELECT code, name FROM instrument")).toMatchObject({
      code: "ZZAA",
      name: "Synthetic",
    });
  });
});
