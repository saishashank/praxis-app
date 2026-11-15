// @vitest-environment node
// Migration 0038_m21_owner_tools (M21 A1; D-1236, D-1221, D-1227, D-1228; AT-68 b, AT-77): six append-only tables
// (owner_trade, owner_trade_void, owner_holding, golden_label, short_shadow_decision, short_shadow_outcome), the
// five market-keyed ones with the two guard triggers each. No data row, no table rebuild, no change to an existing table.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { marketTables } from "@/lib/maintenance/rowsByMarket";
import { LABEL_ENUMS } from "@/lib/llm/textLabels";
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

const { M21_MIGRATION_PATH, M21_REGION, M21_TABLES, m21Tables, renderM21Region } =
  guardGen as unknown as {
    M21_MIGRATION_PATH: string;
    M21_REGION: string;
    M21_TABLES: string[];
    m21Tables: () => Promise<string[]>;
    renderM21Region: () => string;
  };
const GUARDED = [...M21_TABLES].sort();
const ALL_NEW = [...GUARDED, "owner_trade_void"].sort();
const rows = async (sql: string) => (await db.execute(sql)).rows;
const count = async (sql: string) => Number((await rows(sql))[0]!.n);

const T = "'2030-01-02T00:00:00Z'";
const SHORT_OUT = (m: string, status = "closed") =>
  `INSERT INTO short_shadow_outcome (market, d, code, origin, status, scored_at) VALUES ('${m}', '2030-01-02', 'ZZ1', 'lowest_rank', '${status}', ${T})`;
/** A valid row of each guarded table for a market. */
const ROW: Record<string, (m: string) => string> = {
  owner_trade: (m) =>
    `INSERT INTO owner_trade (market, code, side, d, qty, price_micro, fees_micro, source, entered_at, entered_by) VALUES ('${m}', 'ZZ1', 'buy', '2030-01-02', 10, 1000000, 0, 'typed', ${T}, 'owner')`,
  owner_holding: (m) =>
    `INSERT INTO owner_holding (upload_id, market, code, qty, avg_cost_micro, uploaded_at) VALUES ('u1', '${m}', 'ZZ1', 5, 2000000, ${T})`,
  golden_label: (m) =>
    `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone) VALUES ('${m}', 't', 'a1', ${T}, 'owner', 'labelled', 'up', 'confirmed', 'positive')`,
  short_shadow_decision: (m) =>
    `INSERT INTO short_shadow_decision (market, d, code, origin, book_id, shortable, rule_id, created_at) VALUES ('${m}', '2030-01-02', 'ZZ1', 'lowest_rank', 'b1', 1, 'r1', ${T})`,
  short_shadow_outcome: (m) => SHORT_OUT(m),
};

describe("0038_m21_owner_tools", () => {
  it("is migration 38 and its generated guard region is current", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms).toHaveLength(38);
    expect(ms[37]).toMatchObject({ version: 38, name: "m21_owner_tools" });
    const text = readFileSync(M21_MIGRATION_PATH, "utf8");
    expect(regionOf(text, M21_REGION)).toBe(renderM21Region());
    // the list the generator holds equals the tables with a market column that 0038 added
    expect(await m21Tables()).toEqual(GUARDED);
    expect(GUARDED).toHaveLength(5);
    expect(GUARDED).not.toContain("owner_trade_void");
  });

  it("creates exactly the six tables, no data row, and no table of an earlier migration is rebuilt", async () => {
    const names = (await schemaOf(db)).join("\n");
    for (const t of ALL_NEW) expect(names, t).toContain(`table:${t}:`);
    for (const t of ALL_NEW) expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(0);
    const text = readFileSync(M21_MIGRATION_PATH, "utf8");
    expect(text).not.toMatch(/INSERT INTO/i);
    expect(text).not.toMatch(/ALTER TABLE|DROP TABLE\s+(?!owner_|golden_|short_)/i);
  });

  it("every new table is STRICT; the five market-keyed ones have both guard triggers and refuse IN and US", async () => {
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
    // owner_trade_void has no market column: it carries no guard, its trade id points at a guarded row
    expect(trg.has("owner_trade_void_market_guard_ins")).toBe(false);
    // the derivation of 0035's completeness test: every table with a market column is guarded
    const all = (await marketTables(db))
      .map((x) => x.table)
      .filter((x) => x !== "market_row_count");
    for (const t of all) expect(trg.has(`${t}_market_guard_ins`), t).toBe(true);
  });

  it("AU inserts pass; an IN row can be planted only through the enabled-market helper", async () => {
    for (const t of GUARDED) {
      await db.execute(ROW[t]!("AU"));
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(1);
    }
    await plantOffMarketRow(db, "owner_trade", {
      market: "IN",
      code: "ZZ2",
      side: "sell",
      d: "2030-01-02",
      qty: 1,
      price_micro: 1,
      fees_micro: 0,
      source: "csv",
      entered_at: "2030-01-02T00:00:00Z",
      entered_by: "owner",
    });
    expect(await count("SELECT COUNT(*) n FROM owner_trade WHERE market = 'IN'")).toBe(1);
  });

  it("all six tables are append-only: UPDATE and DELETE are refused", async () => {
    for (const t of GUARDED) await db.execute(ROW[t]!("AU"));
    await db.execute(
      `INSERT INTO owner_trade_void (trade_id, voided_at, reason) VALUES (1, ${T}, 'typo')`,
    );
    const SET: Record<string, string> = {
      owner_trade: "qty = 11",
      owner_trade_void: "reason = 'x'",
      owner_holding: "qty = 6",
      golden_label: "tone = 'negative'",
      short_shadow_decision: "shortable = 0",
      short_shadow_outcome: "status = 'unfilled'",
    };
    for (const [t, set] of Object.entries(SET)) {
      await expect(db.execute(`UPDATE ${t} SET ${set}`), t).rejects.toThrow(/append-only/);
      await expect(db.execute(`DELETE FROM ${t}`), t).rejects.toThrow(/append-only/);
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(1);
    }
  });

  it("owner_trade: side, date, quantity, price, fees, note length and source are checked; a trade is voided once, never edited", async () => {
    const ok = ROW.owner_trade!("AU");
    for (const bad of [
      ok.replace("'buy'", "'short'"),
      ok.replace("'2030-01-02'", "'2 Jan 2030'"),
      ok.replace("10, 1000000, 0", "0, 1000000, 0"),
      ok.replace("10, 1000000, 0", "10, 0, 0"),
      ok.replace("10, 1000000, 0", "10, 1000000, -1"),
      ok.replace("'typed'", "'photo'"),
    ]) {
      await expect(db.execute(bad), bad).rejects.toThrow();
    }
    await expect(
      db.execute({
        sql: ok.replace("fees_micro,", "fees_micro, note,").replace("0, 'typed'", "0, ?, 'typed'"),
        args: ["x".repeat(201)],
      }),
    ).rejects.toThrow();
    await db.execute(ok);
    await db.execute(
      `INSERT INTO owner_trade_void (trade_id, voided_at, reason) VALUES (1, ${T}, 'typo')`,
    );
    await expect(
      db.execute(
        `INSERT INTO owner_trade_void (trade_id, voided_at, reason) VALUES (1, ${T}, 'again')`,
      ),
    ).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(
      db.execute(
        `INSERT INTO owner_trade_void (trade_id, voided_at, reason) VALUES (2, ${T}, 'x')`,
      ),
    ).rejects.toThrow(/FOREIGN/);
    await expect(
      db.execute(`INSERT INTO owner_trade_void (trade_id, voided_at, reason) VALUES (1, ${T}, '')`),
    ).rejects.toThrow();
  });

  it("owner_holding is one row per upload, market and code; quantity and cost are positive", async () => {
    await db.execute(ROW.owner_holding!("AU"));
    await expect(db.execute(ROW.owner_holding!("AU"))).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(
      db.execute(
        ROW.owner_holding!("AU").replace("'u1'", "'u2'").replace("5, 2000000", "0, 2000000"),
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(ROW.owner_holding!("AU").replace("'u1'", "'u2'").replace("5, 2000000", "5, 0")),
    ).rejects.toThrow();
    await db.execute(ROW.owner_holding!("AU").replace("'u1'", "'u2'")); // a newer upload is a new set
    expect(await count("SELECT COUNT(*) n FROM owner_holding")).toBe(2);
  });

  it("golden_label: the value lists equal LABEL_ENUMS, and the labelled/skip CHECK holds", async () => {
    const sql = String(
      (await rows("SELECT sql FROM sqlite_master WHERE name = 'golden_label'"))[0]!.sql,
    );
    for (const [col, values] of Object.entries(LABEL_ENUMS)) {
      const m = new RegExp(`${col} TEXT[^,]*?IN \\(([^)]*)\\)`).exec(sql);
      expect(m, col).not.toBeNull();
      const listed = m![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
      expect(listed.sort(), col).toEqual([...values].sort());
    }
    const base = (m = "AU") => ROW.golden_label!(m);
    await db.execute(base());
    // a skip or unclear answer carries no label; a labelled answer carries all three
    await db.execute(
      `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer) VALUES ('AU', 't', 'a2', ${T}, 'owner', 'skip')`,
    );
    await db.execute(
      `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer) VALUES ('AU', 't', 'a3', ${T}, 'owner', 'unclear')`,
    );
    await expect(
      db.execute(
        `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer) VALUES ('AU', 't', 'a4', ${T}, 'owner', 'labelled')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone) VALUES ('AU', 't', 'a5', ${T}, 'owner', 'skip', 'up', 'confirmed', 'positive')`,
      ),
    ).rejects.toThrow();
    await expect(db.execute(base().replace("'up'", "'sideways'"))).rejects.toThrow();
    await expect(
      db.execute(base().replace("'a1'", "'a6'").replace("'owner', 'labelled'", "'owner', 'maybe'")),
    ).rejects.toThrow();
    // a relabel at another time is a new row; the same instant is not
    await expect(db.execute(base())).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(
      db.execute({
        sql: `INSERT INTO golden_label (market, source, ann_id, labelled_at, actor, answer, guidance, event_confirm, tone, span) VALUES ('AU', 't', 'a7', ${T}, 'owner', 'labelled', 'up', 'confirmed', 'positive', ?)`,
        args: ["x".repeat(301)],
      }),
    ).rejects.toThrow();
  });

  it("short_shadow tables: origin, status and exit reason lists, one row per market, day, code and origin", async () => {
    await db.execute(ROW.short_shadow_decision!("AU"));
    await expect(db.execute(ROW.short_shadow_decision!("AU"))).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(
      db.execute(ROW.short_shadow_decision!("AU").replace("'lowest_rank'", "'random'")),
    ).rejects.toThrow();
    await expect(
      db.execute(ROW.short_shadow_decision!("AU").replace("1, 'r1'", "2, 'r1'")),
    ).rejects.toThrow();
    await db.execute(ROW.short_shadow_decision!("AU").replace("'lowest_rank'", "'event_polarity'"));
    await db.execute(SHORT_OUT("AU", "not_shortable"));
    await expect(db.execute(SHORT_OUT("AU", "closed"))).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(db.execute(SHORT_OUT("AU", "open"))).rejects.toThrow();
    await expect(
      db.execute(
        `INSERT INTO short_shadow_outcome (market, d, code, origin, status, exit_reason, scored_at) VALUES ('AU', '2030-01-03', 'ZZ1', 'lowest_rank', 'closed', 'target', ${T})`,
      ),
    ).rejects.toThrow();
    await db.execute(
      `INSERT INTO short_shadow_outcome (market, d, code, origin, status, exit_reason, scored_at) VALUES ('AU', '2030-01-03', 'ZZ1', 'lowest_rank', 'closed', 'gap', ${T})`,
    );
  });

  it("owner_trade has the (market, code, d, id) index and the golden-label probe is a key search", async () => {
    const idx = (await rows("SELECT name FROM pragma_index_list('owner_trade')")).map((r) =>
      String(r.name),
    );
    expect(idx.some((n) => n.startsWith("idx_owner_trade"))).toBe(true);
    const cols = (await rows("SELECT name FROM pragma_index_info('idx_owner_trade_code')")).map(
      (r) => String(r.name),
    );
    expect(cols).toEqual(["market", "code", "d", "id"]);
    const plan = (
      await rows(
        "EXPLAIN QUERY PLAN SELECT 1 FROM golden_label WHERE market = 'AU' AND source = 't' AND ann_id = 'a1' LIMIT 1",
      )
    )
      .map((r) => String(r.detail))
      .join(" | ");
    expect(plan).toMatch(/SEARCH golden_label USING/);
  });

  it("rolls back and comes back identical", async () => {
    const d2 = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(d2, ms);
    const after = await schemaOf(d2);
    expect(await migrateDown(d2, ms, 1)).toEqual({ rolledBack: 1, version: 37 });
    const names = (await schemaOf(d2)).join("\n");
    for (const t of ALL_NEW) expect(names).not.toContain(`table:${t}:`);
    expect(names).not.toContain("owner_trade");
    expect(await migrateUp(d2, ms)).toEqual({ applied: 1, version: 38 });
    expect(await schemaOf(d2)).toEqual(after);
  });
});
