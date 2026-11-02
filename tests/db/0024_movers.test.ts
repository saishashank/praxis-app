// @vitest-environment node
// Migration 0024_movers (movers gap additions, D-740…D-759): applies, rolls back and comes back
// identical; every table is append-only; the CHECKs hold. Synthetic ZZ data only (SEC-110).
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const NEW_TABLES = [
  "announcement_archive",
  "halt_watch",
  "intraday_arm",
  "sector_composite_daily",
  "angle_forward_flag",
];

const INSERTS: Record<string, string> = {
  announcement_archive: `INSERT INTO announcement_archive (market, code, source, ann_id, published_at,
    known_at, session_d, timing, type, price_sensitive, halt_kind, title)
    VALUES ('AU', 'ZZA', 'asx', 'a1', 't0', 't1', '2030-03-05', 'pre_open', NULL, 1, 'halt', 'Trading Halt')`,
  halt_watch: `INSERT INTO halt_watch (market, code, since_d, seq, status, reason_class, expected_sign,
    known_at) VALUES ('AU', 'ZZA', '2030-03-05', 1, 'open', 'unknown', 0, 't1')`,
  intraday_arm: `INSERT INTO intraday_arm (market, session_d, code, reason, expected_sign, armed_from, ref,
    created_at) VALUES ('AU', '2030-03-06', 'ZZA', 'halt_resume', -1, '10:00', 'halt:2030-03-05', 't1')`,
  sector_composite_daily: `INSERT INTO sector_composite_daily (market, d, industry, ret_ppm, n_members,
    map_as_of, created_at) VALUES ('AU', '2030-03-05', 'ZZIND', 12000, 6, '2030-03-01', 't1')`,
  angle_forward_flag: `INSERT INTO angle_forward_flag (market, d, code, angle_id, grid_key,
    angle_version, known_at) VALUES ('AU', '2030-03-05', 'ZZA', 'A-D2-07', 'vr_min=3', 2, 't1')`,
};

const fails = async (db: Client, sql: string): Promise<string> => {
  try {
    await db.execute(sql);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`expected to fail: ${sql}`);
};

describe("migration 0024_movers: apply, roll back, apply again", () => {
  it("creates the five tables, rolls back to 0023 and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = (await loadMigrations(MIGRATIONS("main"))).filter((m) => m.version <= 24); // pinned: later migrations must not change this test
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    for (const t of NEW_TABLES) expect(after.some((s) => s.startsWith(`table:${t}:`))).toBe(true);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: 23 });
    const mid = await schemaOf(db);
    for (const t of NEW_TABLES) expect(mid.some((s) => s.startsWith(`table:${t}:`))).toBe(false);
    expect(await migrateUp(db, ms)).toEqual({ applied: 1, version: 24 });
    expect(await schemaOf(db)).toEqual(after);
  });
});

describe("append-only guards and CHECKs", () => {
  it.each(NEW_TABLES)("%s: one row in, no update, no delete", async (t) => {
    const db = await freshDb("main");
    await db.execute(INSERTS[t]!);
    expect(await fails(db, `UPDATE ${t} SET market = 'AU'`)).toContain("append-only");
    expect(await fails(db, `DELETE FROM ${t}`)).toContain("append-only");
  });

  it("announcement_archive: the same item twice is refused, a bad timing or halt kind is refused", async () => {
    const db = await freshDb("main");
    await db.execute(INSERTS.announcement_archive!);
    await fails(db, INSERTS.announcement_archive!);
    await fails(
      db,
      INSERTS.announcement_archive!.replace("'a1'", "'a2'").replace("pre_open", "late"),
    );
    await fails(
      db,
      INSERTS.announcement_archive!.replace("'a1'", "'a3'").replace("'halt'", "'pause'"),
    );
  });

  it("halt_watch: resumed needs resume_d and open must not have one; the sign is -1, 0 or 1", async () => {
    const db = await freshDb("main");
    const row = (status: string, resume: string, sign: number, seq: number) =>
      `INSERT INTO halt_watch (market, code, since_d, seq, status, reason_class, expected_sign,
        resume_d, known_at) VALUES ('AU', 'ZZB', '2030-03-05', ${seq}, '${status}', 'takeover', ${sign},
        ${resume}, 't1')`;
    await fails(db, row("resumed", "NULL", 1, 1));
    await fails(db, row("open", "'2030-03-07'", 1, 1));
    await fails(db, row("open", "NULL", 2, 1));
    await db.execute(row("open", "NULL", 1, 1));
    await db.execute(row("resumed", "'2030-03-07'", 1, 2));
    await fails(db, row("resumed", "'2030-03-07'", 1, 2)); // (code, since_d, seq) is unique
  });

  it("intraday_arm: one arm per code and session; the reason and the time format are checked", async () => {
    const db = await freshDb("main");
    await db.execute(INSERTS.intraday_arm!);
    await fails(db, INSERTS.intraday_arm!.replace("halt_resume", "volume_creep"));
    await fails(
      db,
      INSERTS.intraday_arm!.replace("'ZZA'", "'ZZB'").replace("halt_resume", "hunch"),
    );
    await fails(db, INSERTS.intraday_arm!.replace("'ZZA'", "'ZZB'").replace("'10:00'", "'ten'"));
  });
});
