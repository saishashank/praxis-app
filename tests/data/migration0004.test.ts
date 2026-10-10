// @vitest-environment node
// Main DB migration 0004_au_data (M2 T1, docs/M2_design.md section 2, D-057): up/down, seeds,
// immutability triggers, re-run idempotency (DAT-003), first-seen bars (DAT-002), retention
// floors (DAT-142) and the backup round trip with the new tables.
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { dumpDatabase, FOREVER_TABLES } from "@/lib/backup/dump";
import { restoreDatabase } from "@/lib/backup/restore";
import { AU_COLUMNS, AU_SOURCES, AU_TABLES, RETENTION_FLOOR } from "@/lib/data/schema";
import { cleanupTempDbs, freshDb, MIGRATIONS, schemaOf, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const T = "2026-10-12T07:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const dateAgo = (n: number) => daysAgo(n).toISOString().slice(0, 10);
const tsAgo = (n: number) => daysAgo(n).toISOString();

async function count(db: Client, table: string): Promise<number> {
  return Number((await db.execute(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c);
}

function bar(d: string, c = 10, code = "AAA") {
  return {
    sql: "INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at) VALUES ('AU', ?, ?, 10, 11, 9, ?, 1000, 'yahoo_eod', ?, ?)",
    args: [code, d, c, T, T],
  };
}

describe("main migration 0004_au_data", () => {
  it("is the fourth main migration", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[3]).toMatchObject({ version: 4, name: "au_data" });
  });

  it("creates every design table with the documented columns", async () => {
    const db = await freshDb("main");
    for (const t of Object.values(AU_TABLES)) {
      const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
      expect(cols, t).toEqual([...AU_COLUMNS[t]]);
    }
  });

  it("down removes everything; up again gives an identical schema", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    const before = await schemaOf(db);
    expect(await migrateDown(db, ms, 2)).toEqual({ rolledBack: 2, version: 3 });
    const mid = await schemaOf(db);
    for (const t of Object.values(AU_TABLES)) {
      expect(mid.some((s) => s.startsWith(`table:${t}:`))).toBe(false);
    }
    expect(mid.some((s) => s.startsWith("trigger:price_bar"))).toBe(false);
    expect(mid.some((s) => s.startsWith("index:idx_price_bar"))).toBe(false);
    expect(await migrateUp(db, ms)).toEqual({ applied: 2, version: 5 });
    expect(await schemaOf(db)).toEqual(before);
  });

  it("migrate is idempotent: seeds are present exactly once after re-running", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(await migrateUp(db, ms)).toEqual({ applied: 0, version: 5 });
    const market = (await db.execute("SELECT * FROM market")).rows;
    expect(market).toHaveLength(1);
    expect(market[0]).toMatchObject({
      code: "AU",
      tz: "Australia/Sydney",
      cutoff_time: "18:10",
      currency: "AUD",
      mode: "data_only",
    });
    const reg = (await db.execute("SELECT source FROM source_register ORDER BY source")).rows;
    expect(reg.map((r) => r.source)).toEqual([...AU_SOURCES].sort());
    const st = (await db.execute("SELECT source, mode FROM source_status ORDER BY source")).rows;
    expect(st.map((r) => r.source)).toEqual([...AU_SOURCES].sort());
    expect(st.every((r) => r.mode === "on")).toBe(true);
    expect(await count(db, "source_register_history")).toBe(AU_SOURCES.length);
    expect(await count(db, "trading_calendar")).toBe(522); // seeded by 0005 (all unconfirmed)
    expect(await count(db, "asx_rate_token")).toBe(1);
  });

  it("round trip down then up re-seeds exactly once", async () => {
    const db = await freshDb("main");
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateDown(db, ms, 2); // 0005 then 0004
    await migrateUp(db, ms);
    expect(await count(db, "market")).toBe(1);
    expect(await count(db, "source_register")).toBe(AU_SOURCES.length);
    expect(await count(db, "source_status")).toBe(AU_SOURCES.length);
  });
});

describe("constraints and triggers", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
  });

  it("price_bar: first-seen immutable (no update, duplicate and REPLACE keep the first row)", async () => {
    await db.execute(bar("2026-10-09", 10));
    await expect(db.execute("UPDATE price_bar SET c = 99")).rejects.toThrow(/immutable/);
    // DAT-003: ON CONFLICT DO NOTHING, plain INSERT and INSERT OR REPLACE all leave the bar alone.
    await db.execute({
      sql: bar("2026-10-09", 50).sql.replace("INSERT INTO", "INSERT OR REPLACE INTO"),
      args: bar("2026-10-09", 50).args,
    });
    await db.execute({
      sql: bar("2026-10-09", 60).sql + " ON CONFLICT DO NOTHING",
      args: bar("2026-10-09", 60).args,
    });
    await db.execute(bar("2026-10-09", 70)); // duplicate key: silently ignored (RAISE(IGNORE))
    const r = await db.execute("SELECT c FROM price_bar");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].c).toBe(10);
  });

  it("price_bar: DELETE is refused inside retention and allowed beyond the 730-day floor", async () => {
    expect(RETENTION_FLOOR.priceBarDays).toBe(730);
    await db.execute(bar(dateAgo(10), 10, "NEW"));
    await db.execute(bar(dateAgo(729), 10, "EDGE"));
    await db.execute(bar(dateAgo(740), 10, "OLD"));
    await expect(db.execute("DELETE FROM price_bar WHERE code = 'NEW'")).rejects.toThrow(
      /immutable/,
    );
    await expect(db.execute("DELETE FROM price_bar WHERE code = 'EDGE'")).rejects.toThrow(
      /immutable/,
    );
    await db.execute("DELETE FROM price_bar WHERE code = 'OLD'");
    expect(await count(db, "price_bar")).toBe(2);
  });

  it("price_bar: every market-data row needs source, published_at and ingested_at (DAT-001)", async () => {
    const cols = "market, code, d, o, h, l, c, volume, source, published_at, ingested_at";
    const vals = ["'AU'", "'X'", "'2026-10-09'", "1", "1", "1", "1", "1", "'s'", "'p'", "'i'"];
    for (const i of [8, 9, 10]) {
      const v = vals.map((x, j) => (j === i ? "NULL" : x)).join(", ");
      await expect(db.execute(`INSERT INTO price_bar (${cols}) VALUES (${v})`)).rejects.toThrow(
        /NOT NULL/,
      );
    }
  });

  it("bar_refetch: append-only; delete only beyond the floor", async () => {
    const ins = (d: string, at: string) =>
      db.execute({
        sql: "INSERT INTO bar_refetch (market, code, d, fetched_at, ohlcv_json, max_diff_pct) VALUES ('AU','AAA',?,?,'[]',0.5)",
        args: [d, at],
      });
    await ins(dateAgo(5), T);
    await ins(dateAgo(800), T);
    await expect(db.execute("UPDATE bar_refetch SET max_diff_pct = 1")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM bar_refetch WHERE d > '2000-01-01'")).rejects.toThrow();
    await expect(
      db.execute(
        "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES ('AU','d','A','s','U9')",
      ),
    ).rejects.toThrow();
  });

  it("completion_marker is insert-once", async () => {
    const ins =
      "INSERT INTO completion_marker (market, d, kind, at, outcome) VALUES ('AU','2026-10-09','data','t','ok')";
    await db.execute(ins);
    await expect(db.execute(ins)).rejects.toThrow(/UNIQUE|PRIMARY/);
    await db.execute(ins.replace("INSERT INTO", "INSERT OR IGNORE INTO"));
    await expect(db.execute("UPDATE completion_marker SET outcome = 'x'")).rejects.toThrow(
      /insert once/,
    );
    await expect(db.execute("DELETE FROM completion_marker")).rejects.toThrow(/insert once/);
    await expect(
      db.execute(ins.replace("'data'", "'weird'").replace("'2026-10-09'", "'2026-10-10'")),
    ).rejects.toThrow();
    expect(await count(db, "completion_marker")).toBe(1);
  });

  it("trading_calendar: confirmed may go 0 to 1 once, nothing else changes, never deleted", async () => {
    await db.execute(
      "INSERT INTO trading_calendar (market, d, kind, close_time, source) VALUES ('AU','2030-12-24','early_close','14:10','draft')",
    );
    await expect(db.execute("UPDATE trading_calendar SET kind = 'holiday'")).rejects.toThrow(
      /only confirmed/,
    );
    await expect(
      db.execute("UPDATE trading_calendar SET confirmed = 1, close_time = '15:00'"),
    ).rejects.toThrow(/only confirmed/);
    await db.execute("UPDATE trading_calendar SET confirmed = 1");
    await expect(db.execute("UPDATE trading_calendar SET confirmed = 0")).rejects.toThrow(
      /only confirmed/,
    );
    await expect(db.execute("UPDATE trading_calendar SET confirmed = 1")).rejects.toThrow(
      /only confirmed/,
    );
    await expect(db.execute("DELETE FROM trading_calendar")).rejects.toThrow(/forever/);
    await expect(
      db.execute(
        "INSERT INTO trading_calendar (market, d, kind, source) VALUES ('AU','2030-12-25','nope','x')",
      ),
    ).rejects.toThrow();
  });

  it("instrument: identity immutable, status fields updatable, unique (market, code), never deleted", async () => {
    await db.execute("INSERT INTO instrument (market, code, name) VALUES ('AU','AAA','Alpha')");
    await expect(
      db.execute("INSERT INTO instrument (market, code, name) VALUES ('AU','AAA','Dup')"),
    ).rejects.toThrow(/UNIQUE/);
    await expect(db.execute("UPDATE instrument SET code = 'BBB'")).rejects.toThrow(/immutable/);
    await expect(db.execute("UPDATE instrument SET id = 99")).rejects.toThrow(/immutable/);
    await db.execute(
      "UPDATE instrument SET delisted_on = '2026-10-01', delist_reason = 'takeover', last_price = 1.5, last_price_d = '2026-09-30'",
    );
    await expect(db.execute("DELETE FROM instrument")).rejects.toThrow(/forever/);
    const idx = await db.execute("PRAGMA index_list(instrument)");
    expect(idx.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("announcement: unique (source, ann_id) makes re-runs idempotent; append-only; 400-day prune", async () => {
    const ins = (annId: string, published: string) => ({
      sql: "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, title, source) VALUES ('AU','AAA',?,?,?,'t','asx_announcements') ON CONFLICT DO NOTHING",
      args: [annId, published, T],
    });
    await db.execute(ins("a1", T));
    await db.execute(ins("a1", T));
    await db.execute(ins("a2", tsAgo(450)));
    expect(await count(db, "announcement")).toBe(2);
    await expect(
      db.execute({
        sql: ins("a1", T).sql.replace(" ON CONFLICT DO NOTHING", ""),
        args: ins("a1", T).args,
      }),
    ).rejects.toThrow(/UNIQUE/);
    await expect(db.execute("UPDATE announcement SET title = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM announcement WHERE ann_id = 'a1'")).rejects.toThrow(
      /append-only/,
    );
    await db.execute("DELETE FROM announcement WHERE ann_id = 'a2'");
    expect(await count(db, "announcement")).toBe(1);
    await expect(
      db.execute({
        sql: "INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, price_sensitive, title, source) VALUES ('AU','A','z',?,?,2,'t','s')",
        args: [T, T],
      }),
    ).rejects.toThrow();
  });

  it("data_quality_flag: only one NULL to value cleared_at update; prune rules", async () => {
    const ins = (raised: string, blocks: number) =>
      db.execute({
        sql: "INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at, blocks_entries) VALUES ('AU','AAA','2026-10-09','DAT-204','error',?,?)",
        args: [raised, blocks],
      });
    await ins(T, 1);
    await expect(db.execute("UPDATE data_quality_flag SET severity = 'info'")).rejects.toThrow(
      /only cleared_at/,
    );
    await expect(
      db.execute("UPDATE data_quality_flag SET cleared_at = 'x', blocks_entries = 0"),
    ).rejects.toThrow(/only cleared_at/);
    await expect(db.execute("UPDATE data_quality_flag SET cleared_at = NULL")).rejects.toThrow(
      /only cleared_at/,
    );
    await db.execute({ sql: "UPDATE data_quality_flag SET cleared_at = ?", args: [T] });
    await expect(
      db.execute({ sql: "UPDATE data_quality_flag SET cleared_at = ?", args: [T] }),
    ).rejects.toThrow(/only cleared_at/);
    // Retention: unblocking flags older than 180 days may go; blockers and recent flags never.
    await ins(tsAgo(200), 1); // old but blocked a decision: kept forever
    await ins(tsAgo(200), 0); // old, harmless: prunable
    await ins(tsAgo(10), 0); // recent: not prunable
    await expect(
      db.execute("DELETE FROM data_quality_flag WHERE blocks_entries = 1"),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.execute({
        sql: "DELETE FROM data_quality_flag WHERE raised_at >= ?",
        args: [tsAgo(100)],
      }),
    ).rejects.toThrow(/append-only/);
    await db.execute({
      sql: "DELETE FROM data_quality_flag WHERE blocks_entries = 0 AND raised_at < ?",
      args: [tsAgo(180)],
    });
    expect(await count(db, "data_quality_flag")).toBe(3);
  });

  it("data_quality_flag has the open-flag partial index and a usable plan", async () => {
    const idx = await db.execute(
      "SELECT sql FROM sqlite_master WHERE name = 'idx_dqf_open' AND type = 'index'",
    );
    expect(String(idx.rows[0].sql)).toMatch(/WHERE cleared_at IS NULL/);
    const plan = await db.execute(
      "EXPLAIN QUERY PLAN SELECT * FROM data_quality_flag WHERE market = 'AU' AND d = '2026-10-09' AND cleared_at IS NULL",
    );
    expect(plan.rows.map((r) => String(r.detail)).join(" ")).toMatch(/idx_dqf_/);
    const plan2 = await db.execute(
      "EXPLAIN QUERY PLAN SELECT * FROM price_bar WHERE market = 'AU' AND d = '2026-10-09'",
    );
    expect(plan2.rows.map((r) => String(r.detail)).join(" ")).toMatch(/price_bar USING/);
    const idx2 = await db.execute("PRAGMA index_list(price_bar)");
    expect(idx2.rows.map((r) => String(r.name))).toContain("idx_price_bar_market_d");
    const plan3 = await db.execute(
      "EXPLAIN QUERY PLAN SELECT * FROM announcement WHERE published_at > 'x'",
    );
    expect(plan3.rows.map((r) => String(r.detail)).join(" ")).toMatch(/idx_announcement_published/);
  });

  it("source_register changes are logged in the history, which is append-only; never deleted", async () => {
    const before = await count(db, "source_register_history");
    await db.execute("UPDATE source_register SET status = 'enabled' WHERE source = 'yahoo_eod'");
    expect(await count(db, "source_register_history")).toBe(before + 1);
    const h = (
      await db.execute(
        "SELECT op, status, changed_at FROM source_register_history WHERE source = 'yahoo_eod' ORDER BY id",
      )
    ).rows;
    expect(h.map((r) => [r.op, r.status])).toEqual([
      ["insert", "pending"],
      ["update", "enabled"],
    ]);
    expect(String(h[1].changed_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    await expect(db.execute("UPDATE source_register_history SET status = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM source_register_history")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM source_register")).rejects.toThrow(/forever/);
    await expect(
      db.execute("INSERT INTO source_register (source, risk, status) VALUES ('x','huge','on')"),
    ).rejects.toThrow();
  });

  it("source_status is updatable but not deletable; mode CHECK", async () => {
    await db.execute(
      "UPDATE source_status SET mode = 'tripped', reason = 'asx_block_trip', tripped_by = 'worker' WHERE source = 'asx_announcements'",
    );
    await expect(
      db.execute("UPDATE source_status SET mode = 'broken' WHERE source = 'rba'"),
    ).rejects.toThrow();
    await expect(db.execute("DELETE FROM source_status")).rejects.toThrow(/never deleted/);
  });

  it("market rows are never deleted; mode CHECK", async () => {
    await expect(db.execute("DELETE FROM market")).rejects.toThrow(/never deleted/);
    await expect(db.execute("UPDATE market SET mode = 'sideways'")).rejects.toThrow();
  });

  it("asx_rate_token is a single row (id = 1) with compare-and-set updates", async () => {
    await expect(
      db.execute("INSERT INTO asx_rate_token (id, day_count) VALUES (2, 0)"),
    ).rejects.toThrow();
    await expect(db.execute("DELETE FROM asx_rate_token")).rejects.toThrow(/single row/);
    const cas = (prev: string | null, next: string) =>
      db.execute({
        sql: "UPDATE asx_rate_token SET last_request_at = ?, day_count = day_count + 1 WHERE id = 1 AND last_request_at IS ?",
        args: [next, prev],
      });
    expect((await cas(null, T)).rowsAffected).toBe(1);
    expect((await cas(null, T)).rowsAffected).toBe(0); // lost the race
  });

  it("state tables upsert on their key; booleans are CHECKed", async () => {
    const up = (n: string) =>
      db.execute({
        sql: "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('k', ?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        args: [n, T],
      });
    await up("1");
    await up("2");
    expect(await count(db, "worker_state")).toBe(1);
    await db.execute(
      "INSERT INTO ingest_cursor (job, market, source, cursor_json, updated_at) VALUES ('j','AU','s','{}','t')",
    );
    await expect(
      db.execute(
        "INSERT INTO ingest_cursor (job, market, source, cursor_json, updated_at) VALUES ('j','AU','s','{}','t')",
      ),
    ).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(
      db.execute("INSERT INTO backfill_job (name, source, done) VALUES ('b','s',2)"),
    ).rejects.toThrow();
    await expect(
      db.execute(
        "INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('AU','d','A','s','U1',2)",
      ),
    ).rejects.toThrow();
  });
});

describe("backup with the AU tables", () => {
  it("labels the forever tables and round-trips rows, triggers and seeds", async () => {
    const db = await freshDb("main");
    await db.batch([
      bar("2026-10-09", 10),
      "INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES ('AU','2026-10-09','AAA','active','U1')",
      "INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at) VALUES ('AU','AAA','2026-10-09','c','e','" +
        T +
        "')",
    ]);
    const d = await dumpDatabase(db, { name: "main", createdAt: T });
    for (const t of [
      "market",
      "instrument",
      "corporate_action_event",
      "source_register_history",
      "quality_score",
      "completion_marker",
      "universe_snapshot",
      "trading_calendar",
      "source_register",
    ]) {
      expect(FOREVER_TABLES, t).toContain(t);
      expect(d.meta.forever, t).toContain(t);
    }
    expect(d.meta.ephemeral).toEqual(["request_nonce"]); // no new table is schema-only
    expect(d.meta.tables).toContain("asx_rate_token");
    expect(d.counts.price_bar).toBe(1);
    expect(d.counts.source_status).toBe(AU_SOURCES.length);

    const target = track(createClient({ url: tempDbUrl() }));
    const r = await restoreDatabase(target, d.text);
    expect(r.sha256).toEqual(d.sha256);
    // Triggers came back (price_bar update still refused, first-seen guard still active).
    await expect(target.execute("UPDATE price_bar SET c = 1")).rejects.toThrow(/immutable/);
    await target.execute(bar("2026-10-09", 99));
    expect((await target.execute("SELECT c FROM price_bar")).rows[0].c).toBe(10);
    // And the restored DB is at version 5 (0005 seeds the calendar), so later migrations continue from it.
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(await migrateUp(target, ms)).toEqual({ applied: 0, version: 5 });
  });
});
