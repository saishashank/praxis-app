// @vitest-environment node
// M19 A2 (D-995; AT-68 b): migration 0035 installs the write guard, two triggers on every table with a `market`
// column. The trigger set is derived from the schema and asserted complete; a planted table with a market column
// and no trigger fails the completeness check; a row of a market that is not enabled is refused (also INSERT OR
// IGNORE / OR REPLACE); AU is unaffected; a market is writable only while enabled. Down removes exactly the triggers.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { marketTables } from "@/lib/maintenance/rowsByMarket";
import { cleanupTempDbs, freshDb, MIGRATIONS, plantOffMarketRow, schemaOf } from "./helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const UNGUARDED = ["market_row_count"];
const GUARD_TRIGGERS =
  "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_market\\_guard\\_%' ESCAPE '\\'";

/** The tables with a market column that lack either guard trigger, and triggers with no such table. */
async function guardGaps(c: Client) {
  const tables = (await marketTables(c)).map((t) => t.table).filter((t) => !UNGUARDED.includes(t));
  const trg = new Set((await c.execute(GUARD_TRIGGERS)).rows.map((r) => String(r.name)));
  const want = new Set(tables.flatMap((t) => [`${t}_market_guard_ins`, `${t}_market_guard_upd`]));
  return {
    tables,
    missing: [...want].filter((n) => !trg.has(n)).sort(),
    extra: [...trg].filter((n) => !want.has(n)).sort(),
  };
}

const bar = (market: string, code = "AAA") =>
  `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
   VALUES ('${market}', '${code}', '2026-11-11', 1, 1, 1, 1, 1, 't', 't', 't')`;
const run = (market: string | null, key = "k") =>
  `INSERT INTO run_record (job, market, concurrency_key, started_at, status)
   VALUES ('x', ${market === null ? "NULL" : `'${market}'`}, '${key}', 't', 'success')`;
const count = async (sql: string) => Number((await db.execute(sql)).rows[0]!.n);

describe("the trigger set", () => {
  it("is complete: two triggers on every table with a market column except market_row_count", async () => {
    const g = await guardGaps(db);
    // 92 tables with a market column in 0001..0034, minus the invariant's own, plus the nine of 0036
    expect(g.tables).toHaveLength(100);
    expect(g.tables).toContain("price_bar");
    expect(g.tables).toContain("trading_calendar");
    expect(g.tables).not.toContain("market_row_count");
    expect(g.missing).toEqual([]);
    expect(g.extra).toEqual([]);
  });

  it("a planted table with a market column and no trigger is reported", async () => {
    await db.execute("CREATE TABLE zz_planted (id INTEGER PRIMARY KEY, market TEXT NOT NULL)");
    const g = await guardGaps(db);
    expect(g.missing).toEqual(["zz_planted_market_guard_ins", "zz_planted_market_guard_upd"]);
  });

  it("the configuration tables keyed by code are not guarded (they have no market column)", async () => {
    const g = await guardGaps(db);
    for (const t of ["market", "market_profile", "market_profile_field", "market_profile_change"])
      expect(g.tables).not.toContain(t);
  });

  it("every guarded table refuses a market that is not enabled, before any other constraint", async () => {
    // BEFORE triggers run first, so a bare `INSERT (market)` fails with the guard's text, not NOT NULL
    const g = await guardGaps(db);
    for (const t of g.tables) {
      await expect(db.execute(`INSERT INTO ${t} (market) VALUES ('IN')`), t).rejects.toThrow(
        new RegExp(`MarketNotEnabled ${t}\\b`),
      );
    }
  });

  it("the SQL of every guard trigger names its table", async () => {
    const r = await db.execute(GUARD_TRIGGERS);
    expect(r.rows).toHaveLength(200); // 91 tables of 0035 and the 9 of 0036, two each
    for (const x of r.rows) {
      const t = String(x.name).replace(/_market_guard_(ins|upd)$/, "");
      expect(String(x.sql)).toContain(`'MarketNotEnabled ${t}'`);
      expect(String(x.sql)).toContain(
        "NOT EXISTS (SELECT 1 FROM market WHERE code = NEW.market AND enabled = 1)",
      );
    }
  });
});

describe("what is refused and what passes", () => {
  it("a planted IN price_bar insert throws the MarketNotEnabled text under the seed", async () => {
    await expect(db.execute(bar("IN"))).rejects.toThrow(/MarketNotEnabled price_bar/);
    await expect(db.execute(bar("US"))).rejects.toThrow(/MarketNotEnabled price_bar/);
    expect(await count("SELECT COUNT(*) n FROM price_bar")).toBe(0);
  });

  it("INSERT OR IGNORE, INSERT OR REPLACE and ON CONFLICT DO NOTHING are refused too", async () => {
    await expect(db.execute(bar("IN").replace("INSERT", "INSERT OR IGNORE"))).rejects.toThrow(
      /MarketNotEnabled price_bar/,
    );
    await expect(db.execute(bar("IN").replace("INSERT", "INSERT OR REPLACE"))).rejects.toThrow(
      /MarketNotEnabled price_bar/,
    );
    await expect(
      db.execute(
        "INSERT INTO quote_latest (market, code, last_micro, quote_at, fetched_at) VALUES ('IN','A',1,'t','t') ON CONFLICT (market, code) DO NOTHING",
      ),
    ).rejects.toThrow(/MarketNotEnabled quote_latest/);
  });

  it("a market with no market row is refused as well", async () => {
    await expect(db.execute(bar("ZZ"))).rejects.toThrow(/MarketNotEnabled price_bar/);
  });

  it("a batch is refused as a whole: nothing of it is stored", async () => {
    await expect(db.batch([bar("AU", "OK"), bar("IN", "BAD")], "write")).rejects.toThrow(
      /MarketNotEnabled price_bar/,
    );
    expect(await count("SELECT COUNT(*) n FROM price_bar")).toBe(0);
  });

  it("AU inserts are unaffected, a duplicate stays ignored (price_bar_first_seen)", async () => {
    await db.execute(bar("AU"));
    await db.execute(bar("AU")); // the first-seen trigger ignores the duplicate
    await db.execute(run("AU"));
    expect(await count("SELECT COUNT(*) n FROM price_bar")).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM run_record")).toBe(1);
  });

  it("a run without a market (NULL) passes: it belongs to none", async () => {
    await db.execute(run(null));
    expect(await count("SELECT COUNT(*) n FROM run_record")).toBe(1);
  });

  it("document.market = 'common' (the source register, the expert mirror) passes; a market that is off does not (D-1024)", async () => {
    const doc = (market: string) =>
      `INSERT INTO document (path, version, market, doc_type, front_json, body, body_sha, d, created_at)
       VALUES ('knowledge/${market}/x.md', 1, '${market}', 'family', '{}', 'b', '${"a".repeat(64)}', '2026-11-12', 't')`;
    await db.execute(doc("common"));
    await db.execute(doc("AU"));
    await expect(db.execute(doc("IN"))).rejects.toThrow(/MarketNotEnabled document/);
    expect(await count("SELECT COUNT(*) n FROM document")).toBe(2);
  });

  it("market_row_count accepts rows of any market (the invariant records a planted row)", async () => {
    await db.execute(
      "INSERT INTO market_row_count (d, tbl, market, n) VALUES ('2026-11-12','price_bar','IN',3)",
    );
    expect(await count("SELECT COUNT(*) n FROM market_row_count")).toBe(1);
  });

  it("UPDATE OF market to a market that is not enabled is refused; a same-value rewrite passes", async () => {
    await db.execute(run("AU"));
    await expect(db.execute("UPDATE run_record SET market = 'IN'")).rejects.toThrow(
      /MarketNotEnabled run_record/,
    );
    await db.execute("UPDATE run_record SET market = 'AU'"); // rewriting the same value creates nothing
    await db.execute("UPDATE run_record SET market = NULL"); // to none
    expect((await db.execute("SELECT market FROM run_record")).rows[0]!.market).toBeNull();
  });

  it("a market is writable only while enabled: enable, write, disable again", async () => {
    await expect(db.execute(bar("IN"))).rejects.toThrow(/MarketNotEnabled/);
    await db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    await db.execute(bar("IN"));
    await db.execute("UPDATE market SET enabled = 0 WHERE code = 'IN'");
    await expect(db.execute(bar("IN", "BBB"))).rejects.toThrow(/MarketNotEnabled/);
    expect(await count("SELECT COUNT(*) n FROM price_bar WHERE market = 'IN'")).toBe(1);
  });

  it("plantOffMarketRow plants a row of an off market and restores the market (D-995)", async () => {
    const row = { market: "IN", code: "A", last_micro: 1, quote_at: "t", fetched_at: "t" };
    await plantOffMarketRow(db, "quote_latest", row);
    const m = (await db.execute("SELECT enabled, mode FROM market WHERE code = 'IN'")).rows[0]!;
    expect([m.enabled, m.mode]).toEqual([0, "off"]);
    await expect(db.execute(bar("IN"))).rejects.toThrow(/MarketNotEnabled/);
    // a code with no market row gets one (off, disabled); an enabled market is left enabled
    await plantOffMarketRow(db, "quote_latest", { ...row, market: "ZQ" });
    expect(
      (await db.execute("SELECT enabled, mode FROM market WHERE code = 'ZQ'")).rows[0],
    ).toMatchObject({ enabled: 0, mode: "off" });
    await plantOffMarketRow(db, "quote_latest", { ...row, market: "AU" });
    expect(await count("SELECT enabled n FROM market WHERE code = 'AU'")).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM quote_latest")).toBe(3);
  });
});

describe("cost (PRD-045): one primary-key probe of the 3-row market table per inserted row", () => {
  it("the probe is a key search, never a scan", async () => {
    const plan = await db.execute(
      "EXPLAIN QUERY PLAN SELECT 1 FROM market WHERE code = 'AU' AND enabled = 1",
    );
    const text = plan.rows.map((r) => String(r.detail)).join(" | ");
    expect(text).toMatch(/SEARCH market USING/);
    expect(text).not.toMatch(/SCAN market/);
  });

  it("the trigger bodies use NOT EXISTS on enabled = 1 and never NOT IN or a data-table scan", async () => {
    const r = await db.execute(GUARD_TRIGGERS);
    for (const x of r.rows) {
      expect(String(x.sql)).not.toMatch(/\bNOT IN\b/);
      expect(String(x.sql).match(/\bSELECT\b/g)).toHaveLength(2); // the probe and the RAISE
    }
  });
});

describe("down and up", () => {
  it("down removes exactly the guard triggers and up restores a schema identical to a fresh one", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms[ms.length - 2]!.name).toBe("m19_market_guard");
    expect(ms[ms.length - 1]!.name).toBe("m20_markets_data"); // 0036 sits on top: its own triggers go with it
    const top = await schemaOf(db);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: ms.length - 1 });
    const full = await schemaOf(db);
    expect(top.length).toBeGreaterThan(full.length);
    expect(await migrateDown(db, ms, 1)).toEqual({ rolledBack: 1, version: ms.length - 2 });
    const down = await schemaOf(db);
    expect(down.some((s) => s.includes("_market_guard_"))).toBe(false);
    expect(full.length - down.length).toBe(182);
    await db.execute(bar("IN")); // no guard any more
    await db.execute("DELETE FROM price_bar WHERE market = 'IN'").catch(() => undefined);
    expect(await migrateUp(db, ms)).toEqual({ applied: 2, version: ms.length });
    expect(await schemaOf(db)).toEqual(top);
  });
});
