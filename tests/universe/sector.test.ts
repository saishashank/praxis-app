// @vitest-environment node
// M7 T4 (decision 53 / D-132 draft): the universe import fills the nullable `instrument.sector` from the
// CSV industry group. The column arrives with main migration 0011; the import must work before it
// (no column: nothing written, nothing fails) and after it. The test adds the column itself when
// the migrations in this branch do not have it yet. Synthetic ZZ* codes only (SEC-110).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importUniverse } from "@/lib/data/universe/import";
import { cleanupTempDbs } from "../db/helpers";
import { cos, csvOf, newDb } from "./helpers";

afterEach(cleanupTempDbs);

let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 13, 20, 30, 0) + clock++).toISOString();
const run = (db: Client, csv: string, today: string) => importUniverse({ db, csv, today, now });

async function hasColumn(db: Client): Promise<boolean> {
  const rs = await db.execute("PRAGMA table_info(instrument)");
  return rs.rows.some((r) => String(r.name) === "sector");
}
const sectors = async (db: Client) =>
  (await db.execute("SELECT code, industry, sector FROM instrument ORDER BY code")).rows.map(
    (r) => ({ ...r }) as Record<string, unknown>,
  );

let db: Client;
beforeEach(async () => {
  clock = 0;
  db = await newDb();
});

describe("instrument.sector", () => {
  it("is filled from the industry group on first import, and follows a changed group", async () => {
    if (!(await hasColumn(db))) await db.execute("ALTER TABLE instrument ADD COLUMN sector TEXT");
    const first = await run(db, csvOf(cos(3, 0)), "2026-10-13");
    expect(first).toMatchObject({ ok: true, status: "applied" });
    for (const r of await sectors(db)) expect(r.sector).toBe(r.industry);
    expect((await sectors(db))[0]!.sector).toBe("Materials");

    const changed = cos(3, 0).map((c, i) => (i === 1 ? { ...c, industry: "Banks" } : c));
    expect(await run(db, csvOf(changed), "2026-10-14")).toMatchObject({ ok: true });
    expect((await sectors(db)).map((r) => r.sector)).toEqual(["Materials", "Banks", "Materials"]);
  });

  it("fills rows imported before the column existed, and keeps a missing group as NULL", async () => {
    expect(await run(db, csvOf(cos(2, 0)), "2026-10-13")).toMatchObject({ ok: true });
    if (!(await hasColumn(db))) await db.execute("ALTER TABLE instrument ADD COLUMN sector TEXT");
    await db.execute("UPDATE instrument SET sector = NULL");
    const noGroup = cos(2, 0).map((c, i) => (i === 1 ? { ...c, industry: "" } : c));
    expect(await run(db, csvOf(noGroup), "2026-10-14")).toMatchObject({ ok: true });
    expect((await sectors(db)).map((r) => r.sector)).toEqual(["Materials", null]);
  });

  it("does not fail while the column is absent", async () => {
    if (await hasColumn(db)) return; // after main 0011 the column is always there
    expect(await run(db, csvOf(cos(2, 0)), "2026-10-13")).toMatchObject({ ok: true });
  });
});
