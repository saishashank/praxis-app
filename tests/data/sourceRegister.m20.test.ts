// @vitest-environment node
// M20 A3 (D-1096, D-1128, DAT-101, DAT-120, AT-32, AT-68 b): the IN and US source rows. They are defined once in
// src/lib/market/seed/{in,us}/sources.mjs and written by ensureMarketSources when a market leaves off: not before, and AU's
// register (rows, history, status, hashes) is never touched.
import { afterEach, describe, expect, it } from "vitest";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import { MARKET_SITES, MARKET_SOURCES, marketSourcesOf } from "@/lib/market/seed/sourceSites.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const IN_IDS = [
  "in_yahoo_ns",
  "in_nse_bhavcopy",
  "in_nse_announcements",
  "in_bse_announcements",
  "in_nse_classification",
  "in_nse_fo_oi",
  "in_nse_slb",
  "in_sebi_pit_sast",
  "in_nse_bands",
  "in_nse_asm_gsm",
  "in_nse_indices_manual",
  "in_nse_board_meetings",
  "in_nse_bse_xbrl",
  "in_rbi",
  "in_mospi",
  "in_nse_holidays",
];
const US_IDS = [
  "us_yahoo",
  "us_stooq",
  "us_edgar",
  "us_finra_short",
  "us_nasdaq_halts",
  "us_sec_suspensions",
  "us_sp_dji_russell_manual",
  "us_fred",
  "us_nyse_holidays",
];
const ENABLED = [
  "in_nse_indices_manual",
  "in_rbi",
  "in_mospi",
  "in_nse_holidays",
  "us_edgar",
  "us_sec_suspensions",
  "us_sp_dji_russell_manual",
  "us_nyse_holidays",
];
const DISABLED = ["in_nse_announcements", "in_bse_announcements"];

const dump = async (db: Awaited<ReturnType<typeof freshDb>>, table: string, key = "source") =>
  (await db.execute(`SELECT * FROM ${table} ORDER BY ${key}, rowid`)).rows.map((r) =>
    JSON.stringify(r),
  );

describe("the seeded rows (D-1096)", () => {
  it("25 rows: the 16 India and 9 US candidates, ids prefixed by market", () => {
    expect(marketSourcesOf("IN").map((r) => r.id)).toEqual(IN_IDS);
    expect(marketSourcesOf("US").map((r) => r.id)).toEqual(US_IDS);
    expect(marketSourcesOf("AU")).toEqual([]);
    for (const [market, rows] of Object.entries(MARKET_SOURCES)) {
      for (const r of rows) {
        expect(r.market).toBe(market);
        expect(r.id.startsWith(`${market.toLowerCase()}_`)).toBe(true);
      }
    }
  });

  it("status: public statistics, EDGAR, holiday lists and manual files enabled; announcements disabled; the rest pending", () => {
    const all = Object.values(MARKET_SOURCES).flat();
    expect(
      all
        .filter((r) => r.status === "enabled")
        .map((r) => r.id)
        .sort(),
    ).toEqual([...ENABLED].sort());
    expect(
      all
        .filter((r) => r.status === "disabled")
        .map((r) => r.id)
        .sort(),
    ).toEqual([...DISABLED].sort());
    expect(all.filter((r) => r.status === "pending")).toHaveLength(25 - 8 - 2);
    for (const id of ["in_yahoo_ns", "us_yahoo"]) {
      const r = all.find((x) => x.id === id)!;
      expect([r.status, r.owner_ref, r.risk]).toEqual(["pending", "O-26", "high"]);
    }
  });

  it("announcement sources are headline and link only and carry no AI summaries (D-1125)", () => {
    for (const id of DISABLED) {
      const r = marketSourcesOf("IN").find((x) => x.id === id)!;
      expect(r.summarisation_permitted).toBe(0);
      expect(r.permitted_use).toMatch(/headline and link only, never a body/);
      expect(r.probe).toBeNull(); // nothing is requested while disabled
    }
  });

  it("EDGAR: enabled, fair-access rate text, the contact is required and never written (D-1094)", () => {
    const e = marketSourcesOf("US").find((x) => x.id === "us_edgar")!;
    expect(e.rate_limits).toBe("10 req/s fair access; we use ≤ 2");
    expect(e.contact).toBe(true);
    expect(e.intervalMs).toBe(500);
  });

  it("no row holds a contact, a key or a secret-like value (SEC-110)", () => {
    const text = JSON.stringify(MARKET_SOURCES);
    expect(text).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/api_key=|apikey=|token=|password/i);
    expect(text).not.toMatch(/\b[0-9a-f]{32,}\b/i);
  });

  it("every host a row names is in the host table, which carries the market and the register ids", () => {
    for (const rows of Object.values(MARKET_SOURCES)) {
      for (const r of rows)
        for (const h of r.hosts) expect(MARKET_SITES[h].sources).toContain(r.id);
    }
    for (const h of [
      "www.nseindia.com",
      "nsearchives.nseindia.com",
      "www.bseindia.com",
      "www.sec.gov",
      "data.sec.gov",
      "efts.sec.gov",
      "www.finra.org",
      "cdn.finra.org",
      "www.nasdaqtrader.com",
      "www.nyse.com",
      "stooq.com",
      "rbi.org.in",
      "www.mospi.gov.in",
      "api.stlouisfed.org",
    ]) {
      expect(MARKET_SITES[h], h).toBeDefined();
    }
  });

  it("the register page (the generated document) lists every row", () => {
    const doc = readFileSync(
      path.join(import.meta.dirname, "../../docs/source-licence-register.md"),
      "utf8",
    );
    for (const id of [...IN_IDS, ...US_IDS]) expect(doc).toContain(`\`${id}\``);
    expect(doc).toContain("## India and US sources (written when a market is enabled)");
  });
});

describe("ensureMarketSources (D-1128)", () => {
  it("the rows appear on enable and not before: after migrate production holds the AU register only", async () => {
    const db = await freshDb("main");
    const rows = await db.execute(
      "SELECT COUNT(*) AS n FROM source_register WHERE source LIKE 'in\\_%' ESCAPE '\\' OR source LIKE 'us\\_%' ESCAPE '\\'",
    );
    expect(Number(rows.rows[0].n)).toBe(0);
    const st = await db.execute(
      "SELECT COUNT(*) AS n FROM source_status WHERE source LIKE 'in\\_%' ESCAPE '\\' OR source LIKE 'us\\_%' ESCAPE '\\'",
    );
    expect(Number(st.rows[0].n)).toBe(0);
  });

  it("enabling IN writes its 16 rows, 16 history rows and 16 status rows; US and AU are untouched", async () => {
    const db = await freshDb("main");
    const auBefore = [
      await dump(db, "source_register"),
      await dump(db, "source_register_history", "id"),
      await dump(db, "source_status"),
    ];
    await allowMarket(db, "IN");
    const r = await ensureMarketSources(db, "IN", { now: () => new Date("2026-11-13T00:00:00Z") });
    expect(r).toEqual({ market: "IN", sources: 16, inserted: 16, existing: 0 });

    const reg = await db.execute(
      "SELECT source, status, owner_ref, terms_url, last_checked FROM source_register WHERE source LIKE 'in\\_%' ESCAPE '\\' ORDER BY source",
    );
    expect(reg.rows.map((x) => String(x.source))).toEqual([...IN_IDS].sort());
    const hist = await db.execute(
      "SELECT source, op FROM source_register_history WHERE source LIKE 'in\\_%' ESCAPE '\\'",
    );
    expect(hist.rows).toHaveLength(16);
    expect(new Set(hist.rows.map((x) => String(x.op)))).toEqual(new Set(["insert"]));
    const st = await db.execute(
      "SELECT mode, since FROM source_status WHERE source LIKE 'in\\_%' ESCAPE '\\'",
    );
    expect(st.rows).toHaveLength(16);
    expect(new Set(st.rows.map((x) => `${String(x.mode)} ${String(x.since)}`))).toEqual(
      new Set(["on 2026-11-13T00:00:00.000Z"]),
    );
    const byId = new Map(reg.rows.map((x) => [String(x.source), x]));
    expect(String(byId.get("in_nse_announcements")!.status)).toBe("disabled");
    expect(String(byId.get("in_yahoo_ns")!.owner_ref)).toBe("O-26");
    expect(String(byId.get("in_nse_holidays")!.status)).toBe("enabled");

    const us = await db.execute(
      "SELECT COUNT(*) AS n FROM source_register WHERE source LIKE 'us\\_%' ESCAPE '\\'",
    );
    expect(Number(us.rows[0].n)).toBe(0);
    // AU's register, history and status: byte-identical
    const auRows = [
      (await dump(db, "source_register")).filter((x) => !x.includes('"source":"in_')),
      (await dump(db, "source_register_history", "id")).filter((x) => !x.includes('"source":"in_')),
      (await dump(db, "source_status")).filter((x) => !x.includes('"source":"in_')),
    ];
    expect(auRows).toEqual(auBefore);
  });

  it("is idempotent: a second call writes nothing and no new history row", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "US");
    expect(await ensureMarketSources(db, "US")).toEqual({
      market: "US",
      sources: 9,
      inserted: 9,
      existing: 0,
    });
    const before = [
      await dump(db, "source_register"),
      await dump(db, "source_register_history", "id"),
    ];
    expect(await ensureMarketSources(db, "US")).toEqual({
      market: "US",
      sources: 9,
      inserted: 0,
      existing: 9,
    });
    expect([
      await dump(db, "source_register"),
      await dump(db, "source_register_history", "id"),
    ]).toEqual(before);
  });

  it("never overwrites a row the Owner changed", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "IN");
    await ensureMarketSources(db, "IN");
    await db.execute(
      "UPDATE source_register SET status = 'enabled' WHERE source = 'in_nse_bhavcopy'",
    );
    await db.execute("UPDATE source_status SET mode = 'off' WHERE source = 'in_nse_bhavcopy'");
    const r = await ensureMarketSources(db, "IN");
    expect(r.inserted).toBe(0);
    const row = await db.execute(
      "SELECT status FROM source_register WHERE source = 'in_nse_bhavcopy'",
    );
    expect(String(row.rows[0].status)).toBe("enabled");
    const mode = await db.execute(
      "SELECT mode FROM source_status WHERE source = 'in_nse_bhavcopy'",
    );
    expect(String(mode.rows[0].mode)).toBe("off");
  });

  it("AU has no rows here: the call writes nothing", async () => {
    const db = await freshDb("main");
    const before = [
      await dump(db, "source_register"),
      await dump(db, "source_register_history", "id"),
      await dump(db, "source_status"),
    ];
    expect(await ensureMarketSources(db, "AU")).toEqual({
      market: "AU",
      sources: 0,
      inserted: 0,
      existing: 0,
    });
    expect([
      await dump(db, "source_register"),
      await dump(db, "source_register_history", "id"),
      await dump(db, "source_status"),
    ]).toEqual(before);
  });
});
