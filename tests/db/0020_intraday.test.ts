// @vitest-environment node
// Migration 0020_intraday (M17 WP2; docs/M17_design.md "Schema"): applies, rolls back and comes back
// identical; every append-only guard fires; the candidate follow-up columns are the only ones that may
// change; the email_message rebuild keeps rows and accepts the pick kinds; the pending register row.
// Synthetic ZZ data only (SEC-110).
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "./helpers";

afterEach(cleanupTempDbs);

const D = "'2030-03-05'";
const NEW_TABLES = ["pick_alert", "pick_alert_mail", "intraday_candidate", "quote_run"];

const alertRow = (id: string, seq: number, state: string, hit: string, reason: string, d = D) =>
  `INSERT INTO pick_alert (alert_id, seq, user_id, market, pick_d, profile, rank, code, session_d,
    state, limit_micro, stop_micro, at, hit_micro, clear_reason)
    VALUES ('${id}', ${seq}, 'u1', 'AU', '2030-03-04', 'balanced', 1, 'ZZA', ${d}, '${state}',
    1000000, 900000, 't0', ${hit}, ${reason})`;

const INSERTS: Record<string, string> = {
  pick_alert: alertRow("a1", 1, "armed", "NULL", "NULL"),
  pick_alert_mail: `INSERT INTO pick_alert_mail (alert_id, kind, email_key, status, at)
    VALUES ('a1', 'pick_hit', 'pickhit:aaaaaaaa:2030-03-05', 'sent', 't0')`,
  intraday_candidate: `INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at,
    item_source, item_ann_id, materiality, move_ppm, gates_json)
    VALUES ('AU', ${D}, 'ZZA', '10:30', 't0', 'asx', 'ann1', 2, 50000, '{}')`,
  quote_run: `INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests)
    VALUES ('AU', ${D}, '10:30', 'scan', 't0', 40)`,
};

const fails = async (db: Client, sql: string): Promise<string> => {
  try {
    await db.execute(sql);
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error(`expected to fail: ${sql}`);
};

async function seeded(): Promise<Client> {
  const db = await freshDb("main");
  for (const t of NEW_TABLES) await db.execute(INSERTS[t]!);
  return db;
}

const mail = (k: string, kind: string, slot = "pool") =>
  `INSERT INTO email_message (email_key, env, kind, d, slot, status, created_at)
   VALUES ('${k}', 'test', '${kind}', ${D}, '${slot}', 'claimed', 't')`;
const attempt = (k: string) =>
  `INSERT INTO email_attempt (email_key, n, at, outcome) VALUES ('${k}', 1, 't', 'accepted')`;

describe("migration 0020_intraday: apply, roll back, apply again", () => {
  it("creates the four tables, rolls back to 0019 and comes back identical", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    const after = await schemaOf(db);
    for (const t of NEW_TABLES) expect(after.some((s) => s.startsWith(`table:${t}:`))).toBe(true);

    expect(await migrateDown(db, ms, 5)).toEqual({ rolledBack: 5, version: 19 });
    const mid = await schemaOf(db);
    for (const t of NEW_TABLES) expect(mid.some((s) => s.startsWith(`table:${t}:`))).toBe(false);
    expect(mid.join("\n")).not.toContain("pick_hit");
    const reg = await db.execute("SELECT 1 FROM source_register WHERE source = 'yahoo_delayed'");
    expect(reg.rows).toHaveLength(0);

    expect(await migrateUp(db, ms)).toEqual({ applied: 5, version: 24 });
    expect(await schemaOf(db)).toEqual(after);
  });

  it("the register row is pending with its O-26 note, status row on, history row written", async () => {
    const db = await freshDb("main");
    const r = (await db.execute("SELECT * FROM source_register WHERE source = 'yahoo_delayed'"))
      .rows[0]!;
    expect(r.status).toBe("pending");
    expect(r.risk).toBe("high");
    expect(r.owner_ref).toBe("O-26");
    expect(String(r.permitted_use)).toContain("personal use only");
    expect(String(r.rate_limits)).toContain("2000/day");
    const s = (await db.execute("SELECT mode FROM source_status WHERE source = 'yahoo_delayed'"))
      .rows[0]!;
    expect(s.mode).toBe("on");
    const h = await db.execute(
      "SELECT op FROM source_register_history WHERE source = 'yahoo_delayed'",
    );
    expect(h.rows.map((x) => x.op)).toEqual(["insert"]);
  });
});

describe("append-only guards", () => {
  it.each([
    ["pick_alert", "at"],
    ["pick_alert_mail", "status"],
    ["quote_run", "requests"],
  ])("%s: UPDATE and DELETE abort", async (t, col) => {
    const db = await seeded();
    expect(await fails(db, `UPDATE ${t} SET ${col} = ${col}`)).toMatch(/append-only/);
    expect(await fails(db, `DELETE FROM ${t}`)).toMatch(/append-only/);
  });

  it("intraday_candidate: DELETE aborts", async () => {
    const db = await seeded();
    expect(await fails(db, "DELETE FROM intraday_candidate")).toMatch(/append-only/);
  });

  it("intraday_candidate: the follow-up columns may change, nothing else", async () => {
    const db = await seeded();
    await db.execute(`UPDATE intraday_candidate SET latest_quote_at = 't1', latest_move_ppm = 1,
      email_key = 'pickcand:AU:2030-03-05:ZZA', decision_outcome = 'night_pick',
      excess_open_1_ppm = 1, excess_open_3_ppm = 2, excess_open_5_ppm = 3,
      excess_found_1_ppm = 4, excess_found_3_ppm = 5, excess_found_5_ppm = 6, measured_at = 't2'`);
    for (const col of [
      "found_slot = 'x'",
      "found_at = 'x'",
      "item_source = 'x'",
      "item_ann_id = 'x'",
      "item_category = 'x'",
      "materiality = 3",
      "polarity = 'up'",
      "move_ppm = 1",
      "sector_adj_ppm = 1",
      "rel_volume_ppm = 1",
      "gates_json = '[]'",
      "indicative_limit_micro = 5",
      "indicative_stop_micro = 5",
      "code = 'ZZB'",
    ]) {
      expect(await fails(db, `UPDATE intraday_candidate SET ${col}`), col).toMatch(
        /only the follow-up columns/,
      );
    }
  });

  it("insert-once keys collide: alert (alert_id, seq), quote run, candidate", async () => {
    const db = await seeded();
    expect(await fails(db, INSERTS.pick_alert!)).toMatch(/UNIQUE/);
    expect(await fails(db, INSERTS.quote_run!)).toMatch(/UNIQUE|PRIMARY/);
    expect(await fails(db, INSERTS.intraday_candidate!)).toMatch(/UNIQUE|PRIMARY/);
    await db.execute(alertRow("a1", 2, "cleared", "NULL", "'expired'"));
  });
});

describe("CHECKs", () => {
  it("pick_alert: state and reason agree, the reason list includes filled, dates are GLOB", async () => {
    const db = await freshDb("main");
    await db.execute(alertRow("a", 1, "cleared", "NULL", "'filled'"));
    await db.execute(alertRow("h", 1, "hit", "1100000", "NULL"));
    await fails(db, alertRow("b", 1, "cleared", "NULL", "NULL"));
    await fails(db, alertRow("c", 1, "armed", "NULL", "'expired'"));
    await fails(db, alertRow("d", 1, "hit", "NULL", "NULL"));
    await fails(db, alertRow("e", 1, "cleared", "NULL", "'bogus'"));
    await fails(db, alertRow("f", 1, "armed", "NULL", "NULL", "'2030-3-5'"));
  });

  it("intraday_candidate: materiality below 2 fails; unavailable volume stays NULL", async () => {
    const db = await freshDb("main");
    await fails(db, INSERTS.intraday_candidate!.replace(", 2, 50000", ", 1, 50000"));
    await db.execute(INSERTS.intraday_candidate!);
    const r = await db.execute("SELECT rel_volume_ppm FROM intraday_candidate");
    expect(r.rows[0]!.rel_volume_ppm).toBeNull();
  });

  it("quote_run.paused holds a cause or NULL", async () => {
    const db = await freshDb("main");
    const ins = (p: string, m: string) =>
      `INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, paused)
       VALUES ('AU', ${D}, '${m}', 'poll', 't', 0, ${p})`;
    await db.execute(ins("NULL", "10:00"));
    await db.execute(ins("'rate_limited'", "10:05"));
    await db.execute(ins("'server_error'", "10:10"));
    await db.execute(ins("'network'", "10:15"));
    await fails(db, ins("1", "10:20"));
    await fails(db, ins("'other'", "10:25"));
  });
});

describe("email_message rebuild", () => {
  it("accepts the five pick kinds in the pool slot and keeps the guards and the attempt link", async () => {
    const db = await freshDb("main");
    for (const k of ["pick_hit", "pick_cleared", "pick_candidate", "pick_batch", "pick_digest"]) {
      await db.execute(mail(`${k}:x`, k));
    }
    await fails(db, mail("bad:x", "pick_other"));
    await fails(db, mail("p0x", "pick_hit", "p0"));
    await db.execute(attempt("pick_hit:x"));
    await fails(db, attempt("nope"));
    expect(
      await fails(db, "UPDATE email_message SET kind = 'review' WHERE email_key = 'pick_hit:x'"),
    ).toMatch(/claimed row moves once|claimed/);
    const idx = await db.execute(
      "SELECT name FROM sqlite_master WHERE tbl_name = 'email_message' AND type = 'index' AND name LIKE 'idx_%'",
    );
    expect(idx.rows.map((x) => x.name).sort()).toEqual([
      "idx_email_message_created",
      "idx_email_message_d",
    ]);
  });

  it("D-443 parity: the rebuilt table differs from 0019 only in the kind list; indexes, triggers and every row value are kept", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(
      db,
      ms.filter((m) => m.version <= 19),
    );
    // A fully populated row at 0019, plus a terminal one with an attempt, and a FK-style check on.
    await db.execute("PRAGMA foreign_keys = ON");
    await db.execute(
      `INSERT INTO email_message (email_key, env, kind, d, slot, status, subject, size_html, size_text,
         provider_id, attempts, recipient_sha, created_at, sent_at, ref_json)
       VALUES ('rv:1', 'production', 'review', '2030-03-04', 'reserved_review', 'sent', 'Evening Review',
         1234, 567, 'prov-1', 2, '${"ab".repeat(32)}', '2030-03-04T08:00:00.000Z',
         '2030-03-04T08:00:03.000Z', '{"claim_at":"2030-03-04T08:00:00.000Z","claim_n":0}')`,
    );
    await db.execute(mail("p0:x", "p0", "p0"));
    await db.execute(attempt("rv:1"));
    const objects = (name: string) =>
      db
        .execute({
          sql: "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type, name",
          args: [name],
        })
        .then((r) => r.rows.map((x) => `${x.type}:${x.name}:${String(x.sql ?? "")}`));
    const rowsOf = () =>
      db
        .execute("SELECT * FROM email_message ORDER BY email_key")
        .then((r) => r.rows.map((x) => JSON.stringify({ ...x })));
    const before = await objects("email_message");
    const beforeAttempt = await objects("email_attempt");
    const beforeRows = await rowsOf();
    expect(beforeRows).toHaveLength(2);

    expect(
      await migrateUp(
        db,
        ms.filter((m) => m.version <= 20),
      ),
    ).toEqual({ applied: 1, version: 20 });
    const after = await objects("email_message");
    const afterAttempt = await objects("email_attempt");
    // Same object names, in the same shape; the only textual change is the widened kind CHECK.
    const PICK_KINDS = ", 'pick_hit','pick_cleared','pick_candidate','pick_batch','pick_digest'";
    const norm = (s: string) =>
      s
        .replace(/\s+/g, " ")
        .replace(/CREATE TABLE "?email_message(?:_new)?"? \(/, "CREATE TABLE email_message (")
        .replace(PICK_KINDS, "");
    expect(after.map(norm)).toEqual(before.map(norm));
    expect(after.filter((s) => s.startsWith("table:"))[0]).toContain("'pick_digest'");
    expect(afterAttempt).toEqual(beforeAttempt);
    expect(await rowsOf()).toEqual(beforeRows);
    expect((await db.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
    const cols = await db.execute("PRAGMA table_info(email_message)");
    expect(
      cols.rows.map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? ""}:${c.pk}`),
    ).toEqual([
      "email_key:TEXT:1::1",
      "env:TEXT:1::0",
      "kind:TEXT:1::0",
      "d:TEXT:1::0",
      "slot:TEXT:1::0",
      "status:TEXT:1::0",
      "subject:TEXT:1:'':0",
      "size_html:INTEGER:1:0:0",
      "size_text:INTEGER:1:0:0",
      "provider_id:TEXT:0::0",
      "attempts:INTEGER:1:0:0",
      "recipient_sha:TEXT:0::0",
      "created_at:TEXT:1::0",
      "sent_at:TEXT:0::0",
      "ref_json:TEXT:1:'{}':0",
    ]);
    // The guards still fire on the copied rows, and the attempt link still holds.
    await fails(db, "UPDATE email_message SET subject = 'x' WHERE email_key = 'rv:1'");
    await fails(db, "DELETE FROM email_message WHERE email_key = 'rv:1'");
    await fails(db, attempt("nope"));
    await db.execute("UPDATE email_message SET status = 'failed' WHERE email_key = 'p0:x'");
  });

  it("rolls back: old rows survive, pick rows go, the old CHECK is back", async () => {
    const db = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(db, ms);
    await db.execute(mail("brief:2030-03-05", "brief"));
    await db.execute(mail("pick_hit:x", "pick_hit"));
    await db.execute(attempt("pick_hit:x"));
    await db.execute(attempt("brief:2030-03-05"));
    await migrateDown(db, ms, 5);
    const k = await db.execute("SELECT email_key FROM email_message");
    expect(k.rows.map((x) => x.email_key)).toEqual(["brief:2030-03-05"]);
    const a = await db.execute("SELECT email_key FROM email_attempt");
    expect(a.rows.map((x) => x.email_key)).toEqual(["brief:2030-03-05"]);
    await fails(db, mail("pick_hit:y", "pick_hit"));
    await fails(db, attempt("nope"));
  });
});
