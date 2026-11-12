// @vitest-environment node
// Migration 0036_m20_markets_data (M20 A2; D-1122, D-1096, D-1100, D-1101, D-1114, D-1121; AT-68 b): nine new
// market-keyed tables, each with its two guard triggers; the append-only triggers; market.data_only_since and
// rollback_at; the deferred IN/US source_register rows (D-1128); the generated seed delta (profile_version 2). No calendar, price
// or other data row of IN or US exists after the migration (MKT-110 b, D-1097).
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "@/lib/db/migrate-core.mjs";
import { marketTables } from "@/lib/maintenance/rowsByMarket";
import { SEEDS } from "@/lib/market/seed/index.mjs";
// @ts-expect-error the generators are scripts (not typed)
import * as guardGen from "../../scripts/db/gen-market-guard.mjs";
// @ts-expect-error the generator is a script (not typed)
import { applyDelta } from "../../scripts/market/gen-seed-sql.mjs";
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

const { M20_MIGRATION_PATH, M20_REGION, M20_TABLES, m20Tables, renderM20Region } =
  guardGen as unknown as {
    M20_MIGRATION_PATH: string;
    M20_REGION: string;
    M20_TABLES: string[];
    m20Tables: () => Promise<string[]>;
    renderM20Region: () => string;
  };
const NEW_TABLES = [...(M20_TABLES as string[])].sort();
const rows = async (sql: string, args: (string | number)[] = []) =>
  (await db.execute({ sql, args })).rows;
const count = async (sql: string) => Number((await rows(sql))[0]!.n);

/** A valid row of each new table for a market (the NOT NULL set only). */
const ROW: Record<string, (m: string) => string> = {
  price_band: (m) =>
    `INSERT INTO price_band (market, code, d, band_pct, lower_micro, upper_micro, source) VALUES ('${m}', 'ZZ1', '2030-01-02', 20, 1, 2, 't')`,
  surveillance_list: (m) =>
    `INSERT INTO surveillance_list (market, code, d, list, stage, source) VALUES ('${m}', 'ZZ1', '2030-01-02', 'ASM', 1, 't')`,
  trading_halt: (m) =>
    `INSERT INTO trading_halt (market, code, kind, halted_at, source) VALUES ('${m}', 'ZZ1', 'luld', '2030-01-02T15:00:00Z', 't')`,
  announcement_category: (m) =>
    `INSERT INTO announcement_category (market, source, ann_id, category, materiality, verifiable, map_version) VALUES ('${m}', 't', 'a1', 'results', 2, 1, 'v1')`,
  fundamental_fact: (m) =>
    `INSERT INTO fundamental_fact (market, code, cik, concept, unit, period_end, value, accession, filed_at) VALUES ('${m}', 'ZZ1', '1', 'Revenues', 'USD', '2029-12-31', '100', '0001', '2030-02-01')`,
  bar_latency_sample: (m) =>
    `INSERT INTO bar_latency_sample (market, d, close_local, first_seen_at, latency_min, source) VALUES ('${m}', '2030-01-02', '15:30', '2030-01-02T11:00:00Z', 30, 't')`,
  market_switch: (m) =>
    `INSERT INTO market_switch (market, from_mode, to_mode, enabled_after, actor, at) VALUES ('${m}', 'off', 'data_only', 1, 'owner', '2030-01-02T00:00:00Z')`,
  label_item: (m) =>
    `INSERT INTO label_item (market, source, ann_id, label, labelled_at, actor) VALUES ('${m}', 't', 'a1', 'material', '2030-01-02T00:00:00Z', 'owner')`,
  holdout_look: (m) =>
    `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict) VALUES ('L1', '${m}', '2030-01-02T00:00:00Z', 'abcdef0', 'shadow')`,
};

describe("0036_m20_markets_data", () => {
  it("is migration 36 and its generated regions are current", async () => {
    const ms = await loadMigrations(MIGRATIONS("main"));
    expect(ms).toHaveLength(36);
    expect(ms[35]).toMatchObject({ version: 36, name: "m20_markets_data" });
    const text = readFileSync(M20_MIGRATION_PATH as string, "utf8");
    expect(regionOf(text, M20_REGION as string)).toBe(renderM20Region() as string);
    expect(await applyDelta(true)).toBe(true);
    // the list the guard generator holds equals the tables with a market column that 0036 added
    expect(await m20Tables()).toEqual(NEW_TABLES);
    expect(NEW_TABLES).toHaveLength(9);
  });

  it("rolls back and comes back identical", async () => {
    const d2 = track(createClient({ url: tempDbUrl() }));
    const ms = await loadMigrations(MIGRATIONS("main"));
    await migrateUp(d2, ms);
    const after = await schemaOf(d2);
    const before = (
      await d2.execute("SELECT code, mode, enabled FROM market ORDER BY code")
    ).rows.map((r) => ({ ...r }));
    expect(await migrateDown(d2, ms, 1)).toEqual({ rolledBack: 1, version: 35 });
    const names = (await schemaOf(d2)).join("\n");
    for (const t of NEW_TABLES) expect(names).not.toContain(`table:${t}:`);
    const cols = (await d2.execute("SELECT name FROM pragma_table_info('market')")).rows.map((r) =>
      String(r.name),
    );
    expect(cols).not.toContain("data_only_since");
    expect(cols).not.toContain("rollback_at");
    expect(
      Number(
        (await d2.execute("SELECT profile_version v FROM market_profile WHERE code = 'IN'"))
          .rows[0]!.v,
      ),
    ).toBe(1);
    expect(await migrateUp(d2, ms)).toEqual({ applied: 1, version: 36 });
    expect(await schemaOf(d2)).toEqual(after);
    expect(
      (await d2.execute("SELECT code, mode, enabled FROM market ORDER BY code")).rows.map((r) => ({
        ...r,
      })),
    ).toEqual(before);
  });

  it("every new table has both guard triggers and refuses an IN or US insert under the seed", async () => {
    const trg = new Set(
      (
        await rows(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_market\\_guard\\_%' ESCAPE '\\'",
        )
      ).map((r) => String(r.name)),
    );
    for (const t of NEW_TABLES) {
      expect(trg.has(`${t}_market_guard_ins`), t).toBe(true);
      expect(trg.has(`${t}_market_guard_upd`), t).toBe(true);
      for (const m of ["IN", "US"]) {
        await expect(db.execute(ROW[t]!(m)), `${t} ${m}`).rejects.toThrow(
          new RegExp(`MarketNotEnabled ${t}\\b`),
        );
      }
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(0);
    }
    // every table with a market column is guarded (the derivation of 0035's test, unchanged)
    const all = (await marketTables(db))
      .map((x) => x.table)
      .filter((x) => x !== "market_row_count");
    for (const t of all) expect(trg.has(`${t}_market_guard_ins`), t).toBe(true);
  });

  it("AU inserts pass, and an IN row can be planted only through the enabled-market helper", async () => {
    for (const t of NEW_TABLES) {
      await db.execute(ROW[t]!("AU"));
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(1);
    }
    await plantOffMarketRow(db, "price_band", {
      market: "IN",
      code: "ZZ2",
      d: "2030-01-02",
      band_pct: 5,
      lower_micro: 1,
      upper_micro: 2,
      source: "t",
    });
    expect(await count("SELECT COUNT(*) n FROM price_band WHERE market = 'IN'")).toBe(1);
  });

  it("trading_halt is append-only: only resumed_at may be set, once; nothing is deleted", async () => {
    await db.execute(ROW.trading_halt!("AU"));
    await expect(db.execute("UPDATE trading_halt SET reason = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.execute("UPDATE trading_halt SET code = 'ZZ9'")).rejects.toThrow(/append-only/);
    await expect(db.execute("DELETE FROM trading_halt")).rejects.toThrow(/append-only/);
    await db.execute("UPDATE trading_halt SET resumed_at = '2030-01-02T15:05:00Z'");
    expect(await count("SELECT COUNT(*) n FROM trading_halt WHERE resumed_at IS NOT NULL")).toBe(1);
    await expect(
      db.execute("UPDATE trading_halt SET resumed_at = '2030-01-02T15:06:00Z'"),
    ).rejects.toThrow(/append-only/);
    await expect(db.execute(ROW.trading_halt!("AU"))).rejects.toThrow(/UNIQUE/);
  });

  it("the other append-only tables refuse UPDATE and DELETE", async () => {
    const SET: Record<string, string> = {
      fundamental_fact: "value = '1'",
      market_switch: "reason = 'x'",
      label_item: "label = 'x'",
      holdout_look: "verdict = 'x'",
    };
    for (const [t, set] of Object.entries(SET)) {
      await db.execute(ROW[t]!("AU"));
      await expect(db.execute(`UPDATE ${t} SET ${set}`), t).rejects.toThrow(/append-only/);
      await expect(db.execute(`DELETE FROM ${t}`), t).rejects.toThrow(/append-only/);
      expect(await count(`SELECT COUNT(*) n FROM ${t}`), t).toBe(1);
    }
  });

  it("the CHECK constraints hold (band percentage, list, halt kind, materiality, one look per lineage and market)", async () => {
    await expect(
      db.execute(ROW.price_band!("AU").replace("20, 1, 2", "0, 1, 2")),
    ).rejects.toThrow();
    await expect(
      db.execute(ROW.surveillance_list!("AU").replace("'ASM'", "'XXX'")),
    ).rejects.toThrow();
    await expect(db.execute(ROW.trading_halt!("AU").replace("'luld'", "'zzz'"))).rejects.toThrow();
    await expect(
      db.execute(ROW.announcement_category!("AU").replace("'results', 2, 1", "'results', 4, 1")),
    ).rejects.toThrow();
    await db.execute(ROW.holdout_look!("AU"));
    await expect(db.execute(ROW.holdout_look!("AU"))).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it("market gains data_only_since and rollback_at, NULL for every market", async () => {
    const cols = (await rows("SELECT name FROM pragma_table_info('market')")).map((r) =>
      String(r.name),
    );
    expect(cols).toEqual(expect.arrayContaining(["data_only_since", "rollback_at"]));
    const r = await rows("SELECT code, data_only_since, rollback_at FROM market ORDER BY code");
    expect(r.map((x) => [x.code, x.data_only_since, x.rollback_at])).toEqual([
      ["AU", null, null],
      ["IN", null, null],
      ["US", null, null],
    ]);
  });

  it("the D-1096 register rows are deferred (D-1128): the register is unchanged and the rows wait in the file as comments", async () => {
    // the AT-32 baseline hashes source_register and its history: a row added by 0036 would move AU's hashes
    expect(await count("SELECT COUNT(*) n FROM source_register")).toBe(22);
    expect(await count("SELECT COUNT(*) n FROM source_register_history WHERE op = 'insert'")).toBe(
      22,
    );
    expect(
      await count(
        "SELECT COUNT(*) n FROM source_register WHERE source LIKE 'in\\_%' ESCAPE '\\' OR source LIKE 'us\\_%' ESCAPE '\\'",
      ),
    ).toBe(0);
    const text = readFileSync(M20_MIGRATION_PATH as string, "utf8");
    // the commented register block names 16 IN and 9 US sources, announcements disabled, EDGAR enabled
    const ids = [
      ...text.matchAll(
        /^-- \|\s+\('((?:in|us)_[a-z0-9_]+)', '[^']*', '(?:low|medium|high)', '(\w+)'/gm,
      ),
    ];
    expect(ids.filter((m) => m[1]!.startsWith("in_"))).toHaveLength(16);
    expect(ids.filter((m) => m[1]!.startsWith("us_"))).toHaveLength(9);
    const status = Object.fromEntries(ids.map((m) => [m[1], m[2]]));
    expect(status.in_nse_announcements).toBe("disabled");
    expect(status.in_bse_announcements).toBe("disabled");
    expect(status.us_edgar).toBe("enabled");
    expect(status.us_fred).toBe("pending");
  });

  it("profile_version is 2 for IN and US (the seed), AU stays 1, and the field rows equal the seed", async () => {
    const v = Object.fromEntries(
      (await rows("SELECT code, profile_version v FROM market_profile")).map((x) => [
        String(x.code),
        Number(x.v),
      ]),
    );
    expect(v).toEqual({ AU: 1, IN: 2, US: 2 });
    for (const code of ["IN", "US"]) expect(SEEDS[code]!.profileVersion).toBe(2);
  });

  it("no calendar, price or other data row of IN or US exists after the migration", async () => {
    const all = (await marketTables(db)).map((x) => x.table);
    for (const t of all) {
      expect(await count(`SELECT COUNT(*) n FROM ${t} WHERE market IN ('IN','US')`), t).toBe(0);
    }
    expect(await count("SELECT COUNT(*) n FROM trading_calendar WHERE market <> 'AU'")).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM price_bar WHERE market <> 'AU'")).toBe(0);
    // the production shape: AU enabled, IN and US built and off
    const m = await rows("SELECT code, enabled, mode FROM market ORDER BY code");
    expect(m.map((x) => `${String(x.code)}:${Number(x.enabled)}:${String(x.mode)}`)).toEqual([
      "AU:1:data_only",
      "IN:0:off",
      "US:0:off",
    ]);
  });
});
